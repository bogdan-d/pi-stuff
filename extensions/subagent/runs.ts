import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { FinalizedRun } from "./results.js";
import { AgentRunHistory } from "./run-history.js";
import { type RunSubagentOptions, SubagentRunError } from "./runner.js";
import type {
	AgentRunSnapshot,
	BackgroundLaunchDetails,
	BackgroundRunResult,
	BackgroundRunStatus,
	ChildRunDetails,
	RoleName,
} from "./types.js";

const TERMINAL = new Set<BackgroundRunStatus>([
	"completed",
	"failed",
	"cancelled",
]);

interface RunRecord extends BackgroundRunResult {
	ordinal: number;
	options: RunSubagentOptions;
	controller?: AbortController;
	completion: Promise<void>;
	resolveCompletion: () => void;
	runnerPromise?: Promise<void>;
	usageReported: boolean;
}

export interface SubagentManagerOptions {
	run: (options: RunSubagentOptions) => Promise<ChildRunDetails>;
	finalize: (details: ChildRunDetails) => Promise<FinalizedRun>;
	onBackgroundSettled?: (run: BackgroundRunResult) => void | Promise<void>;
	history?: AgentRunHistory;
	onRunTerminal?: (run: AgentRunSnapshot) => void;
	maxConcurrentBackground?: number;
	maxRecords?: number;
	now?: () => number;
	createId?: () => string;
}

export interface StartRunOptions {
	run: RunSubagentOptions;
	allowConcurrentWrites?: boolean;
}

export interface ClaimedRunResult {
	result: BackgroundRunResult;
	usage?: Usage;
}

export interface ForegroundRunResult {
	id: string;
	details: ChildRunDetails;
	finalized: FinalizedRun;
}

export class SubagentManager {
	readonly #run: SubagentManagerOptions["run"];
	readonly #finalize: SubagentManagerOptions["finalize"];
	readonly #onBackgroundSettled?: SubagentManagerOptions["onBackgroundSettled"];
	readonly #maxConcurrentBackground: number;
	readonly #maxRecords: number;
	readonly #now: () => number;
	readonly #createId: () => string;
	readonly history: AgentRunHistory;
	readonly #runs = new Map<string, RunRecord>();
	readonly #queue: string[] = [];
	readonly #foregroundControllers = new Set<AbortController>();
	readonly #foregroundPromises = new Set<Promise<unknown>>();
	readonly #foregroundWrites = new Map<string, number>();
	#activeBackground = 0;
	#nextOrdinal = 0;
	#closed = false;
	#shutdownPromise?: Promise<void>;

	constructor(options: SubagentManagerOptions) {
		this.#run = options.run;
		this.#finalize = options.finalize;
		this.#onBackgroundSettled = options.onBackgroundSettled;
		this.#maxConcurrentBackground = options.maxConcurrentBackground ?? 4;
		this.#maxRecords = options.maxRecords ?? 32;
		this.#now = options.now ?? Date.now;
		this.#createId =
			options.createId ?? (() => randomUUID().replaceAll("-", "").slice(0, 12));
		this.history =
			options.history ??
			new AgentRunHistory({
				now: this.#now,
				...(options.onRunTerminal ? { onTerminal: options.onRunTerminal } : {}),
			});
	}

	async runForeground(options: StartRunOptions): Promise<ForegroundRunResult> {
		this.#assertOpen();
		const cwd = resolve(options.run.cwd);
		this.#assertWriteAdmission(
			options.run.spec.role,
			cwd,
			options.allowConcurrentWrites,
		);
		const id = this.#allocateId();
		this.history.register({
			id,
			mode: "foreground",
			status: "running",
			agent: options.run.spec.name,
			role: options.run.spec.role,
			...(options.run.spec.description
				? { description: options.run.spec.description }
				: {}),
			task: options.run.task,
			cwd,
			model: options.run.model ?? "default model",
			...(options.run.thinking ? { thinking: options.run.thinking } : {}),
			createdAt: this.#now(),
			startedAt: this.#now(),
		});
		const writes = options.run.spec.role === "implementation";
		if (writes) this.#addForegroundWrite(cwd);
		const controller = new AbortController();
		this.#foregroundControllers.add(controller);
		let resolveCompletion: () => void = () => {};
		const completion = new Promise<void>((resolvePromise) => {
			resolveCompletion = resolvePromise;
		});
		this.#foregroundPromises.add(completion);
		const signal = options.run.signal
			? AbortSignal.any([options.run.signal, controller.signal])
			: controller.signal;
		let promise: Promise<ChildRunDetails>;
		try {
			promise = this.#run({
				...options.run,
				cwd,
				signal,
				onEvent: (event) => {
					try {
						options.run.onEvent?.(event);
					} catch {
						// Callers observe runtime events; they do not own execution.
					}
					try {
						this.history.recordEvent(id, event);
					} catch {
						// History observation must not disrupt the child run.
					}
				},
			});
		} catch (error) {
			promise = Promise.reject(error);
		}
		try {
			let details: ChildRunDetails;
			try {
				details = await promise;
			} catch (error) {
				if (!(error instanceof SubagentRunError)) {
					this.history.update(id, {
						status: signal.aborted ? "cancelled" : "failed",
						completedAt: this.#now(),
						...(signal.aborted
							? {}
							: {
									error: error instanceof Error ? error.message : String(error),
								}),
					});
					throw error;
				}
				details = error.details;
			}
			this.history.update(id, {
				model: details.model,
				...(details.thinking ? { thinking: details.thinking } : {}),
				usage: details.usage,
			});
			const finalized = await this.#finalize(details);
			this.#settleHistory(id, finalized, signal.aborted);
			return { id, details, finalized };
		} catch (error) {
			const current = this.history.get(id);
			if (current && !TERMINAL.has(current.status)) {
				this.history.update(id, {
					status: signal.aborted ? "cancelled" : "failed",
					completedAt: this.#now(),
					...(signal.aborted
						? {}
						: {
								error: error instanceof Error ? error.message : String(error),
							}),
				});
			}
			throw error;
		} finally {
			resolveCompletion();
			this.#foregroundPromises.delete(completion);
			this.#foregroundControllers.delete(controller);
			if (writes) this.#removeForegroundWrite(cwd);
		}
	}

	startBackground(options: StartRunOptions): BackgroundLaunchDetails {
		this.#assertOpen();
		this.#ensureCapacity();
		const cwd = resolve(options.run.cwd);
		this.#assertWriteAdmission(
			options.run.spec.role,
			cwd,
			options.allowConcurrentWrites,
		);
		const id = this.#allocateId();
		let resolveCompletion: () => void = () => {};
		const completion = new Promise<void>((resolvePromise) => {
			resolveCompletion = resolvePromise;
		});
		const backgroundOptions = { ...options.run };
		delete backgroundOptions.signal;
		delete backgroundOptions.onUpdate;
		const record: RunRecord = {
			ordinal: this.#nextOrdinal++,
			id,
			status: "queued",
			agent: options.run.spec.name,
			role: options.run.spec.role,
			...(options.run.spec.description
				? { description: options.run.spec.description }
				: {}),
			task: options.run.task,
			cwd,
			model: options.run.model ?? "default model",
			...(options.run.thinking ? { thinking: options.run.thinking } : {}),
			createdAt: this.#now(),
			options: { ...backgroundOptions, cwd },
			completion,
			resolveCompletion,
			usageReported: false,
		};
		this.#runs.set(id, record);
		this.history.register({
			id,
			mode: "background",
			status: record.status,
			agent: record.agent,
			role: record.role,
			...(record.description ? { description: record.description } : {}),
			task: record.task,
			cwd: record.cwd,
			model: record.model,
			...(record.thinking ? { thinking: record.thinking } : {}),
			createdAt: record.createdAt,
		});
		this.#queue.push(id);
		this.#pump();
		return { ...this.#snapshot(record), mode: "background" };
	}

	list(): BackgroundRunResult[] {
		return [...this.#runs.values()]
			.sort((left, right) => right.ordinal - left.ordinal)
			.map((record) => this.#snapshot(record));
	}

	get(id: string): BackgroundRunResult {
		return this.#snapshot(this.#require(id));
	}

	claim(id: string): ClaimedRunResult {
		const record = this.#require(id);
		const usage =
			TERMINAL.has(record.status) && !record.usageReported
				? record.usage
				: undefined;
		if (usage) record.usageReported = true;
		return { result: this.#snapshot(record), ...(usage ? { usage } : {}) };
	}

	async waitFor(
		id: string,
		signal?: AbortSignal,
	): Promise<BackgroundRunResult> {
		const record = this.#require(id);
		if (TERMINAL.has(record.status)) return this.#snapshot(record);
		if (signal?.aborted)
			throw new Error("Waiting for subagent result aborted.");
		let abort: (() => void) | undefined;
		const aborted = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("Waiting for subagent result aborted."));
			signal?.addEventListener("abort", abort, { once: true });
		});
		try {
			await (signal
				? Promise.race([record.completion, aborted])
				: record.completion);
		} finally {
			if (abort) signal?.removeEventListener("abort", abort);
		}
		return this.#snapshot(record);
	}

	cancel(id: string): BackgroundRunResult {
		const record = this.#require(id);
		if (record.status === "queued") {
			record.status = "cancelled";
			record.completedAt = this.#now();
			record.resolveCompletion();
			this.#removeQueued(id);
			this.#syncHistory(record);
		} else if (record.status === "running") {
			record.controller?.abort();
		}
		return this.#snapshot(record);
	}

	shutdown(): Promise<void> {
		if (this.#shutdownPromise) return this.#shutdownPromise;
		this.#closed = true;
		this.#shutdownPromise = this.#doShutdown();
		return this.#shutdownPromise;
	}

	async #doShutdown(): Promise<void> {
		for (const id of [...this.#queue]) {
			const record = this.#runs.get(id);
			if (record?.status === "queued") {
				record.status = "cancelled";
				record.completedAt = this.#now();
				record.resolveCompletion();
				this.#syncHistory(record);
			}
		}
		this.#queue.length = 0;
		for (const record of this.#runs.values()) record.controller?.abort();
		for (const controller of this.#foregroundControllers) controller.abort();
		await Promise.allSettled([
			...[...this.#runs.values()].flatMap((record) =>
				record.runnerPromise ? [record.runnerPromise] : [],
			),
			...this.#foregroundPromises,
		]);
	}

	#pump(): void {
		while (
			!this.#closed &&
			this.#activeBackground < this.#maxConcurrentBackground
		) {
			const id = this.#queue.shift();
			if (!id) return;
			const record = this.#runs.get(id);
			if (!record || record.status !== "queued") continue;
			const controller = new AbortController();
			record.controller = controller;
			record.status = "running";
			record.startedAt = this.#now();
			this.history.update(record.id, {
				status: "running",
				startedAt: record.startedAt,
			});
			this.#activeBackground++;
			const promise = this.#executeBackground(
				record,
				controller.signal,
			).finally(() => {
				this.#activeBackground--;
				delete record.controller;
				this.#pump();
			});
			record.runnerPromise = promise;
		}
	}

	async #executeBackground(
		record: RunRecord,
		signal: AbortSignal,
	): Promise<void> {
		let details: ChildRunDetails;
		try {
			details = await this.#run({
				...record.options,
				signal,
				onEvent: (event) => {
					try {
						this.history.recordEvent(record.id, event);
					} catch {
						// History observation must not disrupt the child run.
					}
				},
			});
		} catch (error) {
			if (!(error instanceof SubagentRunError)) {
				this.#settleError(record, error);
				return;
			}
			details = error.details;
		}
		record.model = details.model;
		if (details.thinking) record.thinking = details.thinking;
		record.usage = details.usage;
		try {
			this.#settleSuccess(record, await this.#finalize(details));
		} catch (error) {
			this.#settleError(record, error);
		}
	}

	#settleSuccess(record: RunRecord, finalized: FinalizedRun): void {
		if (TERMINAL.has(record.status)) return;
		const cancelled = record.controller?.signal.aborted ?? false;
		record.status = cancelled
			? "cancelled"
			: finalized.failed
				? "failed"
				: "completed";
		record.output = finalized.output;
		record.model = finalized.details.model;
		if (finalized.details.thinking)
			record.thinking = finalized.details.thinking;
		record.usage = finalized.details.usage;
		record.truncated = finalized.details.truncated;
		if (finalized.details.fullOutputPath)
			record.fullOutputPath = finalized.details.fullOutputPath;
		if (finalized.error) record.error = finalized.error;
		this.#finish(record);
	}

	#settleError(record: RunRecord, error: unknown): void {
		if (TERMINAL.has(record.status)) return;
		record.status = record.controller?.signal.aborted ? "cancelled" : "failed";
		if (record.status === "failed")
			record.error = error instanceof Error ? error.message : String(error);
		this.#finish(record);
	}

	#finish(record: RunRecord): void {
		record.completedAt = this.#now();
		record.resolveCompletion();
		try {
			this.#syncHistory(record);
		} catch {
			// Completion remains authoritative if inspector persistence fails.
		}
		if (
			!this.#closed &&
			(record.status === "completed" || record.status === "failed")
		) {
			try {
				const notification = this.#onBackgroundSettled?.(
					this.#snapshot(record),
				);
				if (notification) void notification.catch(() => undefined);
			} catch {
				// Delivery failure must not alter retained result.
			}
		}
	}

	#settleHistory(
		id: string,
		finalized: FinalizedRun,
		cancelled: boolean,
	): void {
		this.history.update(id, {
			status: cancelled
				? "cancelled"
				: finalized.failed
					? "failed"
					: "completed",
			completedAt: this.#now(),
			model: finalized.details.model,
			...(finalized.details.thinking
				? { thinking: finalized.details.thinking }
				: {}),
			usage: finalized.details.usage,
			output: finalized.output,
			...(finalized.error ? { error: finalized.error } : {}),
			truncated: finalized.details.truncated,
			...(finalized.details.fullOutputPath
				? { fullOutputPath: finalized.details.fullOutputPath }
				: {}),
		});
	}

	#syncHistory(record: RunRecord): void {
		this.history.update(record.id, {
			status: record.status,
			...(record.startedAt !== undefined
				? { startedAt: record.startedAt }
				: {}),
			...(record.completedAt !== undefined
				? { completedAt: record.completedAt }
				: {}),
			model: record.model,
			...(record.thinking ? { thinking: record.thinking } : {}),
			...(record.usage ? { usage: record.usage } : {}),
			...(record.output !== undefined ? { output: record.output } : {}),
			...(record.error !== undefined ? { error: record.error } : {}),
			...(record.truncated !== undefined
				? { truncated: record.truncated }
				: {}),
			...(record.fullOutputPath
				? { fullOutputPath: record.fullOutputPath }
				: {}),
		});
	}

	#snapshot(record: RunRecord): BackgroundRunResult {
		return {
			id: record.id,
			status: record.status,
			agent: record.agent,
			role: record.role,
			...(record.description ? { description: record.description } : {}),
			task: record.task,
			cwd: record.cwd,
			model: record.model,
			...(record.thinking ? { thinking: record.thinking } : {}),
			createdAt: record.createdAt,
			...(record.startedAt !== undefined
				? { startedAt: record.startedAt }
				: {}),
			...(record.completedAt !== undefined
				? { completedAt: record.completedAt }
				: {}),
			...(record.output !== undefined ? { output: record.output } : {}),
			...(record.error !== undefined ? { error: record.error } : {}),
			...(record.usage ? { usage: record.usage } : {}),
			...(record.truncated !== undefined
				? { truncated: record.truncated }
				: {}),
			...(record.fullOutputPath
				? { fullOutputPath: record.fullOutputPath }
				: {}),
		};
	}

	#assertWriteAdmission(role: RoleName, cwd: string, allowed = false): void {
		if (role !== "implementation" || allowed) return;
		const backgroundConflict = [...this.#runs.values()].some(
			(record) =>
				record.role === "implementation" &&
				record.cwd === cwd &&
				!TERMINAL.has(record.status),
		);
		if (backgroundConflict || (this.#foregroundWrites.get(cwd) ?? 0) > 0) {
			throw new Error(
				`Another implementation run is active in ${cwd}. Use allowConcurrentWrites only when overlapping writes are knowingly safe.`,
			);
		}
	}

	#ensureCapacity(): void {
		if (this.#runs.size < this.#maxRecords) return;
		const oldestTerminal = [...this.#runs.values()].find((record) =>
			TERMINAL.has(record.status),
		);
		if (oldestTerminal) this.#runs.delete(oldestTerminal.id);
		if (this.#runs.size >= this.#maxRecords) {
			throw new Error(
				`Background run capacity (${this.#maxRecords}) reached. Cancel or wait for an active run.`,
			);
		}
	}

	#addForegroundWrite(cwd: string): void {
		this.#foregroundWrites.set(cwd, (this.#foregroundWrites.get(cwd) ?? 0) + 1);
	}

	#removeForegroundWrite(cwd: string): void {
		const count = (this.#foregroundWrites.get(cwd) ?? 1) - 1;
		if (count) this.#foregroundWrites.set(cwd, count);
		else this.#foregroundWrites.delete(cwd);
	}

	#removeQueued(id: string): void {
		const index = this.#queue.indexOf(id);
		if (index >= 0) this.#queue.splice(index, 1);
	}

	#require(id: string): RunRecord {
		const record = this.#runs.get(id);
		if (!record) throw new Error(`Unknown subagent run: ${id}`);
		return record;
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Subagent manager is shutting down.");
	}

	#allocateId(): string {
		for (let attempt = 0; attempt < 100; attempt++) {
			const id = this.#createId();
			if (id && !this.#runs.has(id) && !this.history.has(id)) return id;
		}
		throw new Error("Unable to allocate subagent run ID.");
	}
}
