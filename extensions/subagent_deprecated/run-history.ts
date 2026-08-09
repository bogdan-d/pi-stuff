import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ROLE_NAMES } from "./roles.js";
import type {
	AgentRunSnapshot,
	AgentToolTimelineEvent,
	BackgroundRunStatus,
	RoleName,
} from "./types.js";

export const RUN_ENTRY_TYPE = "subagent-run-v1";
const TERMINAL = new Set<BackgroundRunStatus>([
	"completed",
	"failed",
	"cancelled",
]);
const MAX_TIMELINE = 100;
const THINKING_LEVELS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export type AgentRunRegistration = Omit<
	AgentRunSnapshot,
	"version" | "timeline" | "omittedTimelineEvents"
>;

export type SubagentRuntimeEvent =
	| {
			type: "tool_start";
			id: string;
			tool: string;
			summary: string;
			args: Record<string, unknown>;
	  }
	| { type: "tool_end"; id: string; tool: string; failed: boolean }
	| { type: "usage"; usage: Usage; model: string };

function clone<T>(value: T): T {
	return structuredClone(value);
}

function isSnapshot(value: unknown): value is AgentRunSnapshot {
	if (!value || typeof value !== "object") return false;
	const run = value as Partial<AgentRunSnapshot>;
	return (
		run.version === 1 &&
		typeof run.id === "string" &&
		run.id.length > 0 &&
		(run.mode === "foreground" || run.mode === "background") &&
		!!run.status &&
		TERMINAL.has(run.status) &&
		typeof run.agent === "string" &&
		run.agent.length > 0 &&
		!!run.role &&
		ROLE_SET.has(run.role) &&
		typeof run.task === "string" &&
		typeof run.cwd === "string" &&
		typeof run.model === "string" &&
		Number.isFinite(run.createdAt) &&
		(run.startedAt === undefined || Number.isFinite(run.startedAt)) &&
		Number.isFinite(run.completedAt) &&
		(run.description === undefined || typeof run.description === "string") &&
		(run.thinking === undefined || THINKING_LEVELS.has(run.thinking)) &&
		(run.output === undefined || typeof run.output === "string") &&
		(run.error === undefined || typeof run.error === "string") &&
		(run.truncated === undefined || typeof run.truncated === "boolean") &&
		(run.fullOutputPath === undefined ||
			typeof run.fullOutputPath === "string") &&
		(run.inherited === undefined || typeof run.inherited === "boolean") &&
		isUsage(run.usage) &&
		Array.isArray(run.timeline) &&
		run.timeline.length <= MAX_TIMELINE &&
		run.timeline.every(
			(event) => isTimelineEvent(event) && event.status !== "running",
		) &&
		Number.isInteger(run.omittedTimelineEvents) &&
		(run.omittedTimelineEvents ?? -1) >= 0
	);
}

const ROLE_SET = new Set<RoleName>(ROLE_NAMES);

function isUsage(usage: AgentRunSnapshot["usage"]): boolean {
	if (usage === undefined) return true;
	return (
		Number.isFinite(usage.input) &&
		Number.isFinite(usage.output) &&
		Number.isFinite(usage.cacheRead) &&
		Number.isFinite(usage.cacheWrite) &&
		Number.isFinite(usage.totalTokens) &&
		!!usage.cost &&
		Number.isFinite(usage.cost.input) &&
		Number.isFinite(usage.cost.output) &&
		Number.isFinite(usage.cost.cacheRead) &&
		Number.isFinite(usage.cost.cacheWrite) &&
		Number.isFinite(usage.cost.total)
	);
}

function isTimelineEvent(value: unknown): value is AgentToolTimelineEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<AgentToolTimelineEvent>;
	return (
		typeof event.id === "string" &&
		typeof event.tool === "string" &&
		typeof event.summary === "string" &&
		(event.status === "running" ||
			event.status === "completed" ||
			event.status === "failed") &&
		Number.isFinite(event.startedAt) &&
		(event.completedAt === undefined || Number.isFinite(event.completedAt))
	);
}

export type AgentRunListItem = Pick<
	AgentRunSnapshot,
	| "id"
	| "mode"
	| "status"
	| "agent"
	| "role"
	| "task"
	| "cwd"
	| "model"
	| "createdAt"
	| "startedAt"
	| "completedAt"
	| "inherited"
>;

export class AgentRunHistory {
	readonly #runs = new Map<string, AgentRunSnapshot>();
	// Keep raw arguments out of persisted snapshots; commands may contain secrets.
	readonly #toolArgumentLines = new Map<
		string,
		Map<string, readonly string[]>
	>();
	readonly #localIds = new Set<string>();
	readonly #ordinals = new Map<string, number>();
	readonly #listeners = new Set<() => void>();
	readonly #now: () => number;
	readonly #onTerminal: ((run: AgentRunSnapshot) => void) | undefined;
	#nextOrdinal = 0;

	constructor(
		options: {
			now?: () => number;
			onTerminal?: (run: AgentRunSnapshot) => void;
		} = {},
	) {
		this.#now = options.now ?? Date.now;
		this.#onTerminal = options.onTerminal;
	}

	has(id: string): boolean {
		return this.#runs.has(id);
	}

	register(run: AgentRunRegistration): AgentRunSnapshot {
		if (this.#runs.has(run.id))
			throw new Error(`Duplicate agent run ID: ${run.id}`);
		const snapshot: AgentRunSnapshot = {
			version: 1,
			...clone(run),
			timeline: [],
			omittedTimelineEvents: 0,
		};
		this.#runs.set(run.id, snapshot);
		this.#toolArgumentLines.delete(run.id);
		this.#ordinals.set(run.id, this.#nextOrdinal++);
		this.#localIds.add(run.id);
		this.#emit();
		return clone(snapshot);
	}

	update(id: string, patch: Partial<AgentRunSnapshot>): AgentRunSnapshot {
		const run = this.#require(id);
		const wasTerminal = TERMINAL.has(run.status);
		Object.assign(run, clone(patch));
		this.#finishTimeline(run);
		this.#emit();
		if (!wasTerminal && TERMINAL.has(run.status))
			try {
				this.#onTerminal?.(clone(run));
			} catch {
				// Session persistence is best-effort and must not alter run settlement.
			}
		return clone(run);
	}

	recordEvent(id: string, event: SubagentRuntimeEvent): void {
		const run = this.#require(id);
		if (event.type === "usage") {
			run.usage = clone(event.usage);
			run.model = event.model;
			this.#emit();
			return;
		}
		const existing = run.timeline.find((item) => item.id === event.id);
		if (event.type === "tool_start") {
			if (existing) return;
			let argumentsByTool = this.#toolArgumentLines.get(id);
			if (!argumentsByTool) {
				argumentsByTool = new Map();
				this.#toolArgumentLines.set(id, argumentsByTool);
			}
			argumentsByTool.set(
				event.id,
				JSON.stringify(event.args, null, 2)
					.split("\n")
					.map((line) => `   ${line}`),
			);
			run.timeline.push({
				id: event.id,
				tool: event.tool,
				summary: event.summary,
				status: "running",
				startedAt: this.#now(),
			});
			if (run.timeline.length > MAX_TIMELINE) {
				const omitted = run.timeline.shift();
				if (omitted) argumentsByTool.delete(omitted.id);
				run.omittedTimelineEvents++;
			}
		} else if (existing) {
			if (existing.status !== "running") return;
			existing.status = event.failed ? "failed" : "completed";
			existing.completedAt = this.#now();
		} else {
			const item: AgentToolTimelineEvent = {
				id: event.id,
				tool: event.tool,
				summary: event.tool,
				status: event.failed ? "failed" : "completed",
				startedAt: this.#now(),
				completedAt: this.#now(),
			};
			run.timeline.push(item);
		}
		if (run.timeline.length > MAX_TIMELINE) {
			const omitted = run.timeline.shift();
			if (omitted) this.#toolArgumentLines.get(id)?.delete(omitted.id);
			run.omittedTimelineEvents++;
		}
		this.#emit();
	}

	getToolArgumentLines(
		runId: string,
		toolCallId: string,
	): readonly string[] | undefined {
		return this.#toolArgumentLines.get(runId)?.get(toolCallId);
	}

	get(id: string): AgentRunSnapshot | undefined {
		const run = this.#runs.get(id);
		return run ? clone(run) : undefined;
	}

	list(filter = ""): AgentRunSnapshot[] {
		return this.#filtered(filter).map(clone);
	}

	listSummaries(filter = ""): AgentRunListItem[] {
		return this.#filtered(filter).map((run) => ({
			id: run.id,
			mode: run.mode,
			status: run.status,
			agent: run.agent,
			role: run.role,
			task: run.task,
			cwd: run.cwd,
			model: run.model,
			createdAt: run.createdAt,
			...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
			...(run.completedAt !== undefined
				? { completedAt: run.completedAt }
				: {}),
			...(run.inherited !== undefined ? { inherited: run.inherited } : {}),
		}));
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	reconstruct(entries: readonly SessionEntry[]): void {
		const ownedActive = [...this.#runs.values()].filter(
			(run) => this.#localIds.has(run.id) && !TERMINAL.has(run.status),
		);
		const ownedActiveIds = new Set(ownedActive.map((run) => run.id));
		for (const id of this.#toolArgumentLines.keys())
			if (!ownedActiveIds.has(id)) this.#toolArgumentLines.delete(id);
		this.#runs.clear();
		this.#ordinals.clear();
		this.#nextOrdinal = 0;
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== RUN_ENTRY_TYPE)
				continue;
			if (!isSnapshot(entry.data)) continue;
			this.#runs.set(entry.data.id, {
				...clone(entry.data),
				...(this.#localIds.has(entry.data.id) ? {} : { inherited: true }),
			});
			this.#ordinals.set(entry.data.id, this.#nextOrdinal++);
		}
		const tasks = new Map<string, string>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant")
				continue;
			for (const content of entry.message.content) {
				if (content.type !== "toolCall" || content.name !== "subagent")
					continue;
				const args = content.arguments;
				if (
					args &&
					typeof args === "object" &&
					typeof (args as Record<string, unknown>)["task"] === "string"
				)
					tasks.set(
						content.id,
						(args as Record<string, unknown>)["task"] as string,
					);
			}
		}
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "toolResult")
				continue;
			const message = entry.message;
			if (message.toolName !== "subagent") continue;
			const details = message.details as Record<string, unknown> | undefined;
			if (!details) continue;
			const role = details["role"] ?? details["profile"];
			if (typeof role !== "string" || !ROLE_SET.has(role as RoleName)) continue;
			const id =
				typeof details["id"] === "string"
					? details["id"]
					: `legacy-${message.toolCallId}`;
			if (this.#runs.has(id)) continue;
			if (details["mode"] === "background") {
				const createdAt =
					typeof details["createdAt"] === "number"
						? details["createdAt"]
						: Date.parse(entry.timestamp);
				this.#runs.set(id, {
					version: 1,
					id,
					mode: "background",
					status: "cancelled",
					agent:
						typeof details["agent"] === "string"
							? details["agent"]
							: (role as RoleName),
					role: role as RoleName,
					task:
						typeof details["task"] === "string"
							? details["task"]
							: (tasks.get(message.toolCallId) ?? "(legacy subagent task)"),
					cwd:
						typeof details["cwd"] === "string" ? details["cwd"] : "(unknown)",
					model:
						typeof details["model"] === "string"
							? details["model"]
							: "unknown model",
					createdAt: Number.isFinite(createdAt) ? createdAt : 0,
					...(typeof details["startedAt"] === "number"
						? { startedAt: details["startedAt"] }
						: {}),
					completedAt: Number.isFinite(Date.parse(entry.timestamp))
						? Date.parse(entry.timestamp)
						: 0,
					error: "Interrupted before a terminal snapshot was recorded.",
					timeline: [],
					omittedTimelineEvents: 0,
					inherited: true,
				});
				this.#ordinals.set(id, this.#nextOrdinal++);
				continue;
			}
			const output = message.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			const timestamp = Date.parse(entry.timestamp);
			this.#runs.set(id, {
				version: 1,
				id,
				mode: "foreground",
				status: message.isError ? "failed" : "completed",
				agent:
					typeof details["agent"] === "string"
						? details["agent"]
						: (role as RoleName),
				role: role as RoleName,
				task: tasks.get(message.toolCallId) ?? "(legacy subagent task)",
				cwd: typeof details["cwd"] === "string" ? details["cwd"] : "(unknown)",
				model:
					typeof details["model"] === "string"
						? details["model"]
						: "unknown model",
				createdAt: Number.isNaN(timestamp) ? 0 : timestamp,
				completedAt: Number.isNaN(timestamp) ? 0 : timestamp,
				...(output ? { output } : {}),
				...(message.isError && output ? { error: output } : {}),
				timeline: [],
				omittedTimelineEvents: 0,
				inherited: true,
			});
			this.#ordinals.set(id, this.#nextOrdinal++);
		}
		for (const run of ownedActive) {
			this.#runs.set(run.id, run);
			this.#ordinals.set(run.id, this.#nextOrdinal++);
		}
		this.#emit();
	}

	#finishTimeline(run: AgentRunSnapshot): void {
		if (!TERMINAL.has(run.status)) return;
		for (const item of run.timeline) {
			if (item.status === "running") {
				item.status = "failed";
				item.completedAt = run.completedAt ?? this.#now();
			}
		}
	}

	#searchText(run: AgentRunSnapshot): string {
		return [
			run.id,
			run.agent,
			run.role,
			run.task,
			run.cwd,
			run.status,
			run.mode,
		]
			.join("\n")
			.toLowerCase();
	}

	#emit(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {
				// UI observers cannot disrupt authoritative history mutation.
			}
		}
	}

	#filtered(filter: string): AgentRunSnapshot[] {
		const needle = filter.trim().toLowerCase();
		return [...this.#runs.values()]
			.filter((run) => !needle || this.#searchText(run).includes(needle))
			.sort((left, right) => {
				const leftActive = TERMINAL.has(left.status) ? 0 : 1;
				const rightActive = TERMINAL.has(right.status) ? 0 : 1;
				return (
					rightActive - leftActive ||
					right.createdAt - left.createdAt ||
					(this.#ordinals.get(right.id) ?? 0) -
						(this.#ordinals.get(left.id) ?? 0)
				);
			});
	}

	#require(id: string): AgentRunSnapshot {
		const run = this.#runs.get(id);
		if (!run) throw new Error(`Unknown subagent history run: ${id}`);
		return run;
	}
}
