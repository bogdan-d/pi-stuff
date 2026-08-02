import { describe, expect, test } from "bun:test";
import {
	createBackgroundAgentTools,
	registerBackgroundAgentTools,
} from "../extensions/subagent/background-tools.js";
import { notifyBackgroundSettled } from "../extensions/subagent/index.js";
import { SubagentManager } from "../extensions/subagent/runs.js";

const usage = {
	input: 1,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const spec = {
	name: "verification",
	role: "verification",
	description: "Verify",
	rolePromptPath: "/verify",
	source: "builtin",
} as const;
const child = {
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
const finalized = {
	output: "answer",
	failed: false,
	details: {
		agent: spec.name,
		role: spec.role,
		cwd: "/tmp",
		model: "model",
		usage,
		truncated: false,
	},
} as any;

function manager(run = async () => child) {
	return new SubagentManager({
		run,
		finalize: async () => finalized,
		createId: () => "run-1",
	});
}

async function execute(tool: any, params: any, signal?: AbortSignal) {
	return tool.execute("call", params, signal, undefined, {} as any);
}

describe("background subagent tools", () => {
	test("delivers completion as a follow-up and wakes the parent", () => {
		const calls: any[] = [];
		notifyBackgroundSettled(
			{ sendMessage: (...args: any[]) => calls.push(args) } as any,
			{
				id: "run-1",
				status: "completed",
				agent: "verification",
				role: "verification",
				task: "task",
				cwd: "/tmp",
				model: "model",
				createdAt: 1,
			},
		);
		expect(calls[0][0].content).toContain("subagent_result");
		expect(calls[0][0].content).not.toContain("answer");
		expect(calls[0][1]).toEqual({
			deliverAs: "followUp",
			triggerTurn: true,
		});
		expect(() =>
			notifyBackgroundSettled(
				{
					sendMessage: () => {
						throw new Error("delivery failed");
					},
				} as any,
				calls[0][0].details,
			),
		).not.toThrow();
	});
	test("registers result and cancel tools", () => {
		const names: string[] = [];
		registerBackgroundAgentTools(
			{ registerTool: (tool: any) => names.push(tool.name) } as any,
			manager(),
		);
		expect(names).toEqual(["subagent_result", "subagent_cancel"]);
	});

	test("lists, waits, reports result, and claims usage once", async () => {
		const subject = manager();
		subject.startBackground({
			run: { spec: spec as any, task: "task", cwd: "/tmp", model: "model" },
		});
		const [resultTool] = createBackgroundAgentTools(subject);
		expect((await execute(resultTool, {})).content[0].text).toContain("run-1");
		const first = await execute(resultTool, { id: "run-1", wait: true });
		expect(first.content[0].text).toContain("answer");
		expect(first.usage).toEqual(usage);
		expect((await execute(resultTool, { id: "run-1" })).usage).toBeUndefined();
	});

	test("validates waits and unknown IDs", async () => {
		const [resultTool, cancelTool] = createBackgroundAgentTools(manager());
		await expect(execute(resultTool, { wait: true })).rejects.toThrow(
			"requires an id",
		);
		await expect(execute(resultTool, { id: "missing" })).rejects.toThrow(
			"Unknown",
		);
		await expect(execute(cancelTool, { id: "missing" })).rejects.toThrow(
			"Unknown",
		);
	});

	test("cancels queued and running work", async () => {
		let abort!: () => void;
		const subject = manager(
			(options) =>
				new Promise((_resolve, reject) => {
					abort = () => reject(new Error("aborted"));
					options.signal!.addEventListener("abort", abort);
				}),
		);
		subject.startBackground({
			run: { spec: spec as any, task: "task", cwd: "/tmp" },
		});
		const [, cancelTool] = createBackgroundAgentTools(subject);
		const result = await execute(cancelTool, { id: "run-1" });
		expect(result.content[0].text).toContain("Cancellation requested");
		await subject.waitFor("run-1");
		expect(subject.get("run-1").status).toBe("cancelled");
	});
});
