import { describe, expect, test } from "bun:test";
import { SubagentRunError } from "../extensions/subagent/runner.js";
import { SubagentManager } from "../extensions/subagent/runs.js";

const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const specs = {
	review: {
		name: "review",
		role: "review",
		description: "Review",
		rolePromptPath: "/review",
		source: "builtin",
	},
	implementation: {
		name: "implementation",
		role: "implementation",
		description: "Implement",
		rolePromptPath: "/implementation",
		source: "builtin",
	},
	"explore-deep": {
		name: "explore-deep",
		role: "explore-deep",
		description: "Explore deeply",
		rolePromptPath: "/explore-deep",
		source: "builtin",
	},
} as const;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function child(agent = "review") {
	const spec = specs[agent as keyof typeof specs];
	return {
		agent: spec.name,
		role: spec.role,
		description: spec.description,
		task: "task",
		cwd: "/tmp",
		model: "model",
		messages: [],
		stderr: "",
		usage,
	} as any;
}

function start(
	manager: SubagentManager,
	agent: keyof typeof specs = "review",
	extra = {},
) {
	return manager.startBackground({
		run: {
			spec: specs[agent] as any,
			task: "task",
			cwd: "/tmp",
			model: "model",
		},
		...extra,
	});
}

const finalize = async (details: any) => ({
	output: "done",
	failed: false,
	details: {
		agent: details.agent,
		role: details.role,
		cwd: details.cwd,
		model: details.model,
		usage,
		truncated: false,
	},
});

describe("SubagentManager", () => {
	test("runs explore agents through the shared background lifecycle", async () => {
		const manager = new SubagentManager({
			run: async () => child("explore-deep"),
			finalize,
			createId: () => "explore",
		});
		const run = start(manager, "explore-deep");
		expect(await manager.waitFor(run.id)).toMatchObject({
			status: "completed",
			agent: "explore-deep",
			role: "explore-deep",
		});
		expect(manager.history.get(run.id)).toMatchObject({
			status: "completed",
			agent: "explore-deep",
		});
	});

	test("runs four, queues FIFO, and frees slots after failure", async () => {
		const jobs = Array.from({ length: 6 }, () => deferred<any>());
		let called = 0;
		const manager = new SubagentManager({
			run: () => jobs[called++]!.promise,
			finalize,
			createId: (() => {
				let id = 0;
				return () => String(++id);
			})(),
		});
		const runs = Array.from({ length: 6 }, () => start(manager));
		expect(runs.map((run) => run.status)).toEqual([
			"running",
			"running",
			"running",
			"running",
			"queued",
			"queued",
		]);
		jobs[0]!.resolve(child());
		await manager.waitFor("1");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(manager.get("5").status).toBe("running");
		jobs[1]!.reject(new Error("bad"));
		await manager.waitFor("2");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(manager.get("6").status).toBe("running");
		for (const job of jobs.slice(2)) job.resolve(child());
		await manager.shutdown();
	});

	test("cancels queued work and aborts only a result wait", async () => {
		const job = deferred<any>();
		let childSignal: AbortSignal | undefined;
		const manager = new SubagentManager({
			run: (options) => {
				childSignal = options.signal;
				return job.promise;
			},
			finalize,
			maxConcurrentBackground: 1,
			createId: (() => {
				let id = 0;
				return () => String(++id);
			})(),
		});
		start(manager);
		const queued = start(manager);
		const waited = manager.waitFor(queued.id);
		expect(manager.cancel(queued.id).status).toBe("cancelled");
		expect((await waited).status).toBe("cancelled");
		const controller = new AbortController();
		const waiting = manager.waitFor("1", controller.signal);
		controller.abort();
		await expect(waiting).rejects.toThrow("aborted");
		expect(childSignal?.aborted).toBe(false);
		job.resolve(child());
		await manager.shutdown();
	});

	test("guards implementation writes and permits explicit override", async () => {
		const jobs = [deferred<any>(), deferred<any>()];
		let called = 0;
		const manager = new SubagentManager({
			run: () => jobs[called++]!.promise,
			finalize,
			createId: () => crypto.randomUUID(),
		});
		start(manager, "implementation");
		expect(() => start(manager, "implementation")).toThrow(
			"allowConcurrentWrites",
		);
		start(manager, "implementation", { allowConcurrentWrites: true });
		jobs.forEach((job) => job.resolve(child("implementation")));
		await manager.shutdown();
	});

	test("claims terminal usage once and evicts oldest terminal record", async () => {
		let id = 0;
		const manager = new SubagentManager({
			run: async () => child(),
			finalize,
			maxRecords: 1,
			createId: () => String(++id),
		});
		const first = start(manager);
		await manager.waitFor(first.id);
		expect(manager.claim(first.id).usage).toEqual(usage);
		expect(manager.claim(first.id).usage).toBeUndefined();
		const second = start(manager);
		expect(() => manager.get(first.id)).toThrow("Unknown");
		await manager.waitFor(second.id);
	});

	test("lists newest first and notifies only completed or failed runs", async () => {
		let id = 0;
		const notices: string[] = [];
		const manager = new SubagentManager({
			run: async () => child(),
			finalize,
			now: () => 1,
			createId: () => String(++id),
			onBackgroundSettled: (run) => {
				notices.push(run.id);
			},
		});
		const first = start(manager);
		const second = start(manager);
		expect(manager.list().map((run) => run.id)).toEqual([second.id, first.id]);
		await Promise.all([manager.waitFor(first.id), manager.waitFor(second.id)]);
		expect(notices).toEqual([first.id, second.id]);
	});

	test("retains partial usage and runtime model from runner failures", async () => {
		const failedChild = {
			...child(),
			model: "actual/model",
			stopReason: "error",
			errorMessage: "transport failed",
		};
		const manager = new SubagentManager({
			run: async () => {
				throw new SubagentRunError(
					"transport failed",
					failedChild,
					new Error("transport failed"),
				);
			},
			finalize: async (details) => ({
				output: "partial",
				failed: true,
				error: details.errorMessage,
				details: {
					agent: details.agent,
					role: details.role,
					cwd: details.cwd,
					model: details.model,
					usage: details.usage,
					truncated: false,
				},
			}),
			createId: () => "failed",
		});
		const run = start(manager);
		await manager.waitFor(run.id);
		expect(manager.get(run.id)).toMatchObject({
			status: "failed",
			model: "actual/model",
			usage,
			error: "transport failed",
		});
	});

	test("notifies failed runs", async () => {
		const notices: string[] = [];
		const manager = new SubagentManager({
			run: async () => child(),
			finalize: async (details) => ({
				...(await finalize(details)),
				failed: true,
				error: "failed",
			}),
			createId: () => "failed",
			onBackgroundSettled: (run) => {
				notices.push(run.status);
			},
		});
		const run = start(manager);
		await manager.waitFor(run.id);
		expect(notices).toEqual(["failed"]);
	});

	test("shutdown cancels queued and running background work silently", async () => {
		const notices: string[] = [];
		let cleaned = false;
		let calls = 0;
		const manager = new SubagentManager({
			run: (options) => {
				calls++;
				return new Promise((_resolve, reject) => {
					options.signal!.addEventListener("abort", () => {
						cleaned = true;
						reject(new Error("aborted"));
					});
				});
			},
			finalize,
			maxConcurrentBackground: 1,
			createId: (() => {
				let id = 0;
				return () => String(++id);
			})(),
			onBackgroundSettled: (run) => {
				notices.push(run.id);
			},
		});
		const running = start(manager);
		const queued = start(manager);
		const shutdown = manager.shutdown();
		expect(manager.shutdown()).toBe(shutdown);
		await shutdown;
		expect(cleaned).toBe(true);
		expect(calls).toBe(1);
		expect(manager.get(running.id).status).toBe("cancelled");
		expect(manager.get(queued.id).status).toBe("cancelled");
		expect(notices).toEqual([]);
	});

	test("foreground bypasses background slots and shutdown aborts it", async () => {
		const signals: AbortSignal[] = [];
		const manager = new SubagentManager({
			run: (options) =>
				new Promise((_resolve, reject) => {
					signals.push(options.signal!);
					options.signal!.addEventListener("abort", () =>
						reject(new Error("aborted")),
					);
				}),
			finalize,
			maxConcurrentBackground: 0,
		});
		const foreground = manager.runForeground({
			run: { spec: specs.review as any, task: "task", cwd: "/tmp" },
		});
		await manager.shutdown();
		expect(signals[0]?.aborted).toBe(true);
		await expect(foreground).rejects.toThrow("aborted");
		expect(() => start(manager)).toThrow("shutting down");
	});

	test("tracks foreground before invocation and settles runtime details", async () => {
		let seenBeforeRun = false;
		let manager!: SubagentManager;
		manager = new SubagentManager({
			run: async (options) => {
				seenBeforeRun = manager.history.list()[0]?.status === "running";
				options.onEvent?.({
					type: "tool_start",
					id: "read-1",
					tool: "read",
					summary: "file.ts",
					args: { path: "file.ts" },
				});
				return { ...child(), model: "actual/model" };
			},
			finalize: async (details) => ({
				...(await finalize(details)),
				output: "foreground output",
			}),
			createId: () => "foreground",
		});
		const result = await manager.runForeground({
			run: { spec: specs.review as any, task: "task", cwd: "/tmp" },
		});
		expect(seenBeforeRun).toBe(true);
		expect(result.id).toBe("foreground");
		expect(manager.history.get(result.id)).toMatchObject({
			status: "completed",
			model: "actual/model",
			output: "foreground output",
		});
		expect(manager.history.get(result.id)?.timeline[0]).toMatchObject({
			status: "failed",
		});
	});

	test("retains inspector summaries after result-record eviction", async () => {
		let id = 0;
		const manager = new SubagentManager({
			run: async () => child(),
			finalize,
			maxRecords: 1,
			createId: () => String(++id),
		});
		const first = start(manager);
		await manager.waitFor(first.id);
		const second = start(manager);
		await manager.waitFor(second.id);
		expect(manager.history.list().map((run) => run.id)).toEqual(["2", "1"]);
		expect(() => manager.get("1")).toThrow("Unknown");
	});

	test("settles runs when terminal persistence or runtime observers throw", async () => {
		const manager = new SubagentManager({
			run: async (options) => {
				options.onEvent?.({
					type: "tool_start",
					id: "tool",
					tool: "read",
					summary: "file.ts",
					args: { path: "file.ts" },
				});
				return child();
			},
			finalize,
			createId: (() => {
				let id = 0;
				return () => String(++id);
			})(),
			onRunTerminal: () => {
				throw new Error("persistence failed");
			},
		});
		const background = start(manager);
		await expect(manager.waitFor(background.id)).resolves.toMatchObject({
			status: "completed",
		});
		const foreground = await manager.runForeground({
			run: {
				spec: specs.review as any,
				task: "task",
				cwd: "/tmp",
				onEvent: () => {
					throw new Error("observer failed");
				},
			},
		});
		expect(foreground.finalized.failed).toBe(false);
	});
});
