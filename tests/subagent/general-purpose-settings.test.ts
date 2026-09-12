import { expect, test } from "bun:test";
import type {
	AgentSession,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	AgentRegistry,
	DEFAULT_AGENT,
} from "../../extensions/subagent/agents.js";
import { completedGeneration } from "../../extensions/subagent/conversation.js";
import { SubagentRuntime } from "../../extensions/subagent/runtime.js";
import {
	GENERAL_PURPOSE_THINKING_VALUES,
	normalizeSettings,
	prepareSubagentRuntime,
} from "../../extensions/subagent/settings.js";

test("general-purpose settings preserve defaults and validate stored choices", () => {
	expect(normalizeSettings({}).settings.runtime).toMatchObject({
		generalPurposeModel: "inherit",
		generalPurposeThinking: "default",
	});
	for (const thinking of GENERAL_PURPOSE_THINKING_VALUES) {
		const loaded = normalizeSettings({
			runtime: {
				generalPurposeModel: "test/model",
				generalPurposeThinking: thinking,
			},
		});
		expect(loaded.warning).toBeUndefined();
		expect(loaded.settings.runtime.generalPurposeThinking).toBe(thinking);
	}
	const invalid = normalizeSettings({
		runtime: { generalPurposeModel: "", generalPurposeThinking: "extreme" },
	});
	expect(invalid.warning).toContain("generalPurposeModel");
	expect(invalid.warning).toContain("generalPurposeThinking");
	expect(invalid.settings.runtime).toMatchObject({
		generalPurposeModel: "inherit",
		generalPurposeThinking: "default",
	});
});

test("loaded defaults apply only to unnamed spawns, overrides win, and resumes retain configuration", async () => {
	const registry = new AgentRegistry();
	registry.agents.set("specialist", {
		...DEFAULT_AGENT,
		name: "specialist",
		model: "test/named",
		thinking: "low",
		source: "project",
	});
	const models = ["configured", "override", "named"].map((id) => ({
		provider: "test",
		id,
	}));
	const ctx = {
		cwd: process.cwd(),
		modelRegistry: { getAll: () => models },
	} as ExtensionContext;
	const runtime = new SubagentRuntime(
		registry,
		1,
		async (_ctx, conversation, generation) => {
			conversation.bindSession(
				generation,
				conversation.sessionForResume() ??
					({
						messages: [],
						subscribe: () => () => {},
						dispose: () => {},
					} as unknown as AgentSession),
			);
			return completedGeneration(conversation, generation, "Done");
		},
	);
	await prepareSubagentRuntime({
		ctx,
		runtime,
		settingsStore: {
			load: async () =>
				normalizeSettings({
					runtime: {
						generalPurposeModel: "test/configured",
						generalPurposeThinking: "high",
					},
				}),
		},
	});
	const batch = runtime.startTasks(ctx, [
		{ kind: "spawn", prompt: "Default", label: "Default" },
		{
			kind: "spawn",
			prompt: "Override",
			label: "Override",
			model: "test/override",
			thinking: "off",
		},
		{ kind: "spawn", agent: "specialist", prompt: "Named", label: "Named" },
	]);
	await batch.completion;
	expect(
		runtime.listConversations().map((item) => item.requestedConfig),
	).toEqual([
		{ model: "test/configured", thinking: "high" },
		{ model: "test/override", thinking: "off" },
		{ model: "test/named", thinking: "low" },
	]);
	const first = batch.starts[0];
	if (!first?.ok) throw new Error("Spawn failed");
	const join = runtime.bindSubagentJoin([first.conversationId]);
	join.markCollected("model");
	join.release();
	runtime.configure({
		generalPurposeModel: "test/override",
		generalPurposeThinking: "max",
	});
	const resumed = runtime.startTasks(ctx, [
		{ kind: "resume", subagentId: first.conversationId, prompt: "Continue" },
	]);
	await resumed.completion;
	expect(resumed.starts[0]?.ok).toBe(true);
	expect(runtime.conversation(first.conversationId)?.requestedConfig).toEqual({
		model: "test/configured",
		thinking: "high",
	});
	await runtime.shutdown();
});

test("inherit thinking snapshots the root or immediate child parent's current level", async () => {
	const registry = new AgentRegistry();
	let rootThinking: "high" | "low" = "high";
	const runtime = new SubagentRuntime(
		registry,
		1,
		async (_ctx, conversation, generation) => {
			conversation.bindSession(generation, {
				messages: [],
				thinkingLevel: "minimal",
				subscribe: () => () => {},
				dispose: () => {},
			} as unknown as AgentSession);
			return completedGeneration(conversation, generation, "Done");
		},
	);
	runtime.configure({
		generalPurposeThinking: "inherit",
		getRootThinkingLevel: () => rootThinking,
	});
	const ctx = { cwd: process.cwd() } as ExtensionContext;
	const first = runtime.startTasks(ctx, [
		{ kind: "spawn", prompt: "Parent", label: "Parent" },
	]);
	await first.completion;
	const parent = first.starts[0];
	if (!parent?.ok) throw new Error("Spawn failed");
	rootThinking = "low";
	const child = runtime.startTasks(
		ctx,
		[{ kind: "spawn", prompt: "Child", label: "Child" }],
		{ caller: runtime.generationCaller(parent) },
	);
	await child.completion;
	expect(
		runtime.listConversations().map((item) => item.requestedConfig.thinking),
	).toEqual(["high", "minimal"]);
	const second = runtime.startTasks(ctx, [
		{ kind: "spawn", prompt: "Second", label: "Second" },
	]);
	await second.completion;
	expect(runtime.listConversations().at(-1)?.requestedConfig.thinking).toBe(
		"low",
	);
	await runtime.shutdown();
});
