import { expect, test } from "bun:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	AgentRegistry,
	DEFAULT_AGENT,
} from "../../extensions/subagent/agents.js";
import { parseCheckpoint } from "../../extensions/subagent/checkpoint.js";
import {
	Conversation,
	completedGeneration,
} from "../../extensions/subagent/conversation.js";
import { SubagentRuntime } from "../../extensions/subagent/runtime.js";
import {
	parseSpawnTask,
	SubagentParams,
} from "../../extensions/subagent/schema.js";

test("omitted agent passes SDK validation and creates a checkpointable built-in conversation", async () => {
	const raw = {
		prompt: "Inspect files without editing",
		label: "Inspect files",
	};
	validateToolArguments(
		{ name: "subagent", description: "", parameters: SubagentParams },
		{
			type: "toolCall",
			id: "call",
			name: "subagent",
			arguments: { action: "spawn", spawns: [raw] },
		},
	);
	const task = parseSpawnTask(raw);
	if ("error" in task) throw new Error(task.error);
	const registry = new AgentRegistry();
	// A same-named preset must not replace the omission default.
	registry.agents.set(DEFAULT_AGENT.name, {
		...DEFAULT_AGENT,
		source: "project",
		systemPrompt: "Specialized instructions",
	});
	let checkpoint;
	const runtime = new SubagentRuntime(
		registry,
		1,
		async (_ctx, conversation, generation) => {
			expect(conversation.definition).toEqual(DEFAULT_AGENT);
			expect(conversation.requestedConfig).toEqual({});
			expect(generation.prompt).toBe(raw.prompt);
			checkpoint = conversation.checkpoint();
			return completedGeneration(conversation, generation, "Done");
		},
	);
	const ctx = { cwd: process.cwd() } as ExtensionContext;
	await runtime.prepareTasks(ctx, [task]);
	const batch = runtime.startTasks(ctx, [task]);
	await batch.completion;
	expect(batch.starts[0]?.ok).toBe(true);
	const parsed = parseCheckpoint(checkpoint);
	expect(parsed).toBeDefined();
	if (!parsed) throw new Error("Invalid checkpoint");
	expect(Conversation.restore(parsed).snapshot().agent).toMatchObject({
		name: DEFAULT_AGENT.name,
		source: "builtin",
	});
	await runtime.shutdown();
});

test("explicit names resolve only registered definitions and unknown names explain recovery", async () => {
	const registry = new AgentRegistry();
	registry.agents.set("specialist", {
		...DEFAULT_AGENT,
		name: "specialist",
		source: "project",
	});
	const runtime = new SubagentRuntime(
		registry,
		1,
		async (_ctx, conversation, generation) =>
			completedGeneration(conversation, generation, "Done"),
	);
	const batch = runtime.startTasks({ cwd: process.cwd() } as ExtensionContext, [
		{ kind: "spawn", agent: "specialist", prompt: "Work", label: "Work" },
		{ kind: "spawn", agent: "typo", prompt: "Work", label: "Work" },
	]);
	await batch.completion;
	expect(batch.starts[0]?.ok).toBe(true);
	expect(batch.starts[1]).toMatchObject({
		ok: false,
		error:
			"Unknown agent: typo. Available agents: specialist. Omit agent to use the built-in general-purpose agent.",
	});
	expect(runtime.listConversations()).toHaveLength(1);
	await runtime.shutdown();
});

test("explicit invalid agent values do not select the default", () => {
	for (const agent of [null, "", " ", 42]) {
		expect(
			parseSpawnTask({ agent, prompt: "Work", label: "Work" }),
		).toHaveProperty("error");
	}
});
