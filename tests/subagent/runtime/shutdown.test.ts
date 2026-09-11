import { expect, mock, test } from "bun:test";
import type { Conversation } from "../../../extensions/subagent/conversation.js";
import { SubagentRuntime } from "../../../extensions/subagent/runtime.js";
import { eventually } from "../helpers/eventually.js";

test.each([false, true])(
	"shutdown disposes abandoned sessions once, previously cancelled: %s",
	async (cancelFirst) => {
		const never = new Promise<never>(() => {});
		const emit = mock(async () => {});
		const dispose = mock(() => {});
		let conversation: Conversation | undefined;
		const definition = {
			name: "worker",
			description: "",
			systemPrompt: "",
			source: "project",
		};
		const runtime = new SubagentRuntime(
			{ agents: new Map([["worker", definition]]) } as any,
			1,
			async (_ctx, agent, generation) => {
				conversation = agent;
				agent.bindSession(generation, {
					messages: [],
					subscribe: () => () => {},
					abort: () => never,
					extensionRunner: { emit },
					dispose,
				} as any);
				return never;
			},
			1,
			5,
			async () => [],
		);
		const run = runtime.startTasks({ cwd: process.cwd() } as any, [
			{ kind: "spawn", agent: "worker", label: "wedged", prompt: "wait" },
		]);
		await eventually(() => expect(conversation?.status.kind).toBe("running"));
		if (cancelFirst) await runtime.cancelSubagent(conversation!.conversationId);
		await runtime.shutdown();
		await run.completion;
		expect(emit).toHaveBeenCalledWith({
			type: "session_shutdown",
			reason: "quit",
		});
		expect(dispose).toHaveBeenCalledTimes(1);
		conversation!.markCollected(conversation!.latestGeneration, "model");
		expect(conversation!.sessionForResume()).toBeUndefined();
		expect(conversation!.isResumeAllowed).toBe(false);
		await runtime.shutdown();
		expect(emit).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
	},
);
