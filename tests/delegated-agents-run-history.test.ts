import { describe, expect, test } from "bun:test";
import {
	AgentRunHistory,
	RUN_ENTRY_TYPE,
} from "../extensions/delegated-agents/run-history.js";

function registration(
	id: string,
	mode: "foreground" | "background" = "foreground",
) {
	return {
		id,
		mode,
		status: mode === "foreground" ? ("running" as const) : ("queued" as const),
		agent: "review",
		role: "review" as const,
		task: `Task ${id}`,
		cwd: "/repo",
		model: "provider/model",
		createdAt: Number(id) || 1,
	};
}

describe("AgentRunHistory", () => {
	test("sorts active first, filters broadly, and returns immutable copies", () => {
		const history = new AgentRunHistory();
		history.register(registration("1"));
		history.update("1", { status: "completed", completedAt: 2 });
		history.register({ ...registration("2", "background"), cwd: "/API" });
		expect(history.list().map((run) => run.id)).toEqual(["2", "1"]);
		expect(history.list("api").map((run) => run.id)).toEqual(["2"]);
		expect(history.list("BACKGROUND").map((run) => run.id)).toEqual(["2"]);
		const copy = history.get("2")!;
		copy.task = "changed";
		expect(history.get("2")?.task).toBe("Task 2");
	});

	test("persists one terminal snapshot and reconstructs it as inherited", () => {
		const terminal: any[] = [];
		const history = new AgentRunHistory({
			onTerminal: (run) => terminal.push(run),
		});
		history.register(registration("1"));
		history.update("1", {
			status: "completed",
			completedAt: 2,
			output: "done",
		});
		history.update("1", { output: "still done" });
		expect(terminal).toHaveLength(1);

		const restored = new AgentRunHistory();
		restored.reconstruct([
			{
				type: "custom",
				id: "entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: RUN_ENTRY_TYPE,
				data: terminal[0],
			},
		]);
		expect(restored.get("1")).toMatchObject({
			output: "done",
			inherited: true,
		});
	});

	test("persists and reconstructs explore roles", () => {
		const terminal: any[] = [];
		const history = new AgentRunHistory({
			onTerminal: (run) => terminal.push(run),
		});
		history.register({
			...registration("explore"),
			agent: "explore-deep",
			role: "explore-deep",
		});
		history.update("explore", { status: "completed", completedAt: 2 });

		const restored = new AgentRunHistory();
		restored.reconstruct([
			{
				type: "custom",
				id: "entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: RUN_ENTRY_TYPE,
				data: terminal[0],
			},
		]);
		expect(restored.get("explore")).toMatchObject({
			agent: "explore-deep",
			role: "explore-deep",
			inherited: true,
		});
	});

	test("sanitizes lifecycle storage shape and caps timeline", () => {
		let now = 0;
		const history = new AgentRunHistory({ now: () => ++now });
		history.register(registration("1"));
		for (let index = 0; index < 105; index++) {
			history.recordEvent("1", {
				type: "tool_start",
				id: String(index),
				tool: "read",
				summary: `file-${index}`,
				args: { path: `file-${index}` },
			});
		}
		history.recordEvent("1", {
			type: "tool_end",
			id: "104",
			tool: "read",
			failed: false,
		});
		const run = history.get("1")!;
		expect(run.timeline).toHaveLength(100);
		expect(run.omittedTimelineEvents).toBe(5);
		expect(run.timeline.at(-1)).toMatchObject({
			id: "104",
			status: "completed",
		});
		expect(history.getToolArgumentLines("1", "4")).toBeUndefined();
		const argumentLines = history.getToolArgumentLines("1", "104");
		expect(argumentLines).toEqual(["   {", '     "path": "file-104"', "   }"]);
		expect(history.getToolArgumentLines("1", "104")).toBe(argumentLines);
		history.recordEvent("1", {
			type: "tool_end",
			id: "unmatched",
			tool: "read",
			failed: false,
		});
		expect(history.getToolArgumentLines("1", "5")).toBeUndefined();
	});

	test("updates live usage without persisting tool arguments", () => {
		const terminal: any[] = [];
		const history = new AgentRunHistory({
			onTerminal: (run) => terminal.push(run),
		});
		history.register(registration("1"));
		history.recordEvent("1", {
			type: "tool_start",
			id: "call",
			tool: "exec",
			summary: "command omitted",
			args: { command: "echo super-secret" },
		});
		history.recordEvent("1", {
			type: "usage",
			model: "provider/live-model",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: {
					input: 0.01,
					output: 0.02,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0.03,
				},
			},
		});
		expect(history.get("1")).toMatchObject({
			model: "provider/live-model",
			usage: { totalTokens: 15, cost: { total: 0.03 } },
		});
		history.update("1", { status: "completed", completedAt: 2 });
		expect(JSON.stringify(terminal[0])).not.toContain("super-secret");

		history.reconstruct([]);
		expect(history.getToolArgumentLines("1", "call")).toBeUndefined();
	});

	test("rejects ID collisions and unsubscribes listeners", () => {
		let updates = 0;
		const history = new AgentRunHistory();
		const unsubscribe = history.subscribe(() => updates++);
		history.register(registration("1"));
		expect(() => history.register(registration("1"))).toThrow("Duplicate");
		unsubscribe();
		history.update("1", { model: "new/model" });
		expect(updates).toBe(1);
	});

	test("isolates persistence and subscriber failures", () => {
		const history = new AgentRunHistory({
			onTerminal: () => {
				throw new Error("disk full");
			},
		});
		history.subscribe(() => {
			throw new Error("render failed");
		});
		expect(() => history.register(registration("1"))).not.toThrow();
		expect(() =>
			history.update("1", { status: "completed", completedAt: 2 }),
		).not.toThrow();
		expect(history.get("1")?.status).toBe("completed");
	});

	test("preserves owned active records during branch reconstruction", () => {
		const history = new AgentRunHistory();
		history.register(registration("1", "background"));
		history.reconstruct([]);
		expect(history.get("1")?.status).toBe("queued");
		expect(history.get("1")?.inherited).toBeUndefined();
		expect(() =>
			history.update("1", { status: "cancelled", completedAt: 2 }),
		).not.toThrow();
	});

	test("reconstructs legacy foreground tool results without duplicating launches", () => {
		const history = new AgentRunHistory();
		history.reconstruct([
			{
				type: "message",
				id: "assistant",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "delegate_agent",
							arguments: { agent: "review", task: "Legacy task" },
						},
					],
				},
			} as any,
			{
				type: "message",
				id: "result",
				parentId: "assistant",
				timestamp: "2026-01-01T00:00:01Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "delegate_agent",
					content: [{ type: "text", text: "legacy output" }],
					isError: false,
					details: {
						profile: "review",
						cwd: "/repo",
						model: "provider/model",
					},
				},
			} as any,
		]);
		expect(history.list()).toHaveLength(1);
		expect(history.list()[0]).toMatchObject({
			id: "legacy-call-1",
			task: "Legacy task",
			output: "legacy output",
			inherited: true,
		});
	});

	test("reconstructs unmatched background launches as interrupted", () => {
		const history = new AgentRunHistory();
		history.reconstruct([
			{
				type: "message",
				id: "result",
				parentId: null,
				timestamp: "2026-01-01T00:00:01Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "delegate_agent",
					content: [{ type: "text", text: "started" }],
					isError: false,
					details: {
						id: "background-1",
						mode: "background",
						status: "running",
						agent: "review",
						role: "review",
						task: "Background task",
						cwd: "/repo",
						model: "provider/model",
						createdAt: 1,
					},
				},
			} as any,
		]);
		expect(history.get("background-1")).toMatchObject({
			mode: "background",
			status: "cancelled",
			inherited: true,
			error: "Interrupted before a terminal snapshot was recorded.",
		});
	});

	test("rejects malformed and non-terminal persisted snapshots", () => {
		const base = {
			version: 1,
			...registration("1"),
			status: "running",
			completedAt: 2,
			timeline: [],
			omittedTimelineEvents: 0,
		};
		const history = new AgentRunHistory();
		history.reconstruct([
			{
				type: "custom",
				id: "bad",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				customType: RUN_ENTRY_TYPE,
				data: base,
			},
			{
				type: "custom",
				id: "worse",
				parentId: "bad",
				timestamp: "2026-01-01T00:00:01Z",
				customType: RUN_ENTRY_TYPE,
				data: { ...base, id: "2", status: "completed", agent: undefined },
			},
		] as any);
		expect(history.list()).toEqual([]);
	});

	test("list summaries omit retained heavy details", () => {
		const history = new AgentRunHistory();
		history.register(registration("1"));
		history.update("1", {
			status: "completed",
			completedAt: 2,
			output: "large",
			error: "error",
		});
		expect(history.listSummaries()[0]).not.toHaveProperty("output");
		expect(history.listSummaries()[0]).not.toHaveProperty("timeline");
	});
});
