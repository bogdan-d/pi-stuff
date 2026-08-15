import { expect, test } from "bun:test";
import type { Usage } from "@earendil-works/pi-ai";
import { GenerationActivity } from "../../extensions/subagent/activity.js";
import { Conversation } from "../../extensions/subagent/conversation.js";
import { formatCost } from "../../extensions/subagent/generation-format.js";

function usage(totalTokens: number, total: number): Usage {
	return {
		input: totalTokens - 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: {
			input: total / 2,
			output: total / 2,
			cacheRead: 0,
			cacheWrite: 0,
			total,
		},
	};
}

function eventSession(abort?: () => void) {
	const listeners = new Set<(event: any) => void>();
	return {
		session: {
			messages: [],
			subscribe(listener: (event: any) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			abort,
		} as any,
		emit(event: any) {
			for (const listener of [...listeners]) listener(event);
		},
	};
}

function assistantUsage(value: Usage, stopReason = "stop") {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			usage: value,
			stopReason,
		},
	};
}

test("activity accumulates per-call cost while retaining latest context usage", () => {
	const updates: string[] = [];
	const activity = new GenerationActivity((kind) => updates.push(kind));
	const events = eventSession();
	activity.subscribe(events.session);

	events.emit(assistantUsage(usage(100, 0.01), "toolUse"));
	events.emit({
		type: "tool_execution_start",
		toolCallId: "read-1",
		toolName: "read",
		args: { path: "src/index.ts" },
	});
	events.emit({
		type: "tool_execution_end",
		toolCallId: "read-1",
		toolName: "read",
	});
	events.emit(assistantUsage(usage(180, 0.025), "error"));

	expect(activity.usage.totalTokens).toBe(180);
	expect(activity.cost).toEqual({
		input: 0.0175,
		output: 0.0175,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0.035,
	});
	expect(updates.filter((kind) => kind === "usage")).toHaveLength(2);
});

test("compaction cost accumulates without replacing latest context usage", () => {
	const activity = new GenerationActivity(() => {});
	const events = eventSession();
	activity.subscribe(events.session);
	const latest = usage(240, 0.02);

	events.emit(assistantUsage(latest));
	events.emit({
		type: "compaction_end",
		aborted: false,
		result: {
			summary: "summary",
			firstKeptEntryId: "entry",
			tokensBefore: 240,
			usage: usage(80, 0.007),
		},
	});
	events.emit({
		type: "compaction_end",
		aborted: true,
		result: {
			summary: "unused summary",
			firstKeptEntryId: "entry",
			tokensBefore: 240,
			usage: usage(40, 0.003),
		},
	});

	expect(activity.usage).toBe(latest);
	expect(activity.cost.total).toBeCloseTo(0.03);
	expect(activity.snapshot().compactions).toBe(1);
});

test("conversation cost spans resumed generations and retains terminal usage", async () => {
	const events = eventSession(() => {});
	const conversation = new Conversation(
		"calm-otter" as any,
		{
			name: "helper",
			description: "",
			systemPrompt: "",
			source: "project",
		},
		{ kind: "spawn", agent: "helper", prompt: "first", label: "work" },
		() => {},
	);
	const first = conversation.latestGeneration;
	conversation.bindSession(first, events.session);
	events.emit(assistantUsage(usage(100, 0.01)));
	conversation.settle(first, "completed");
	conversation.markCollected(first, "model");

	const second = conversation.beginResume("second");
	conversation.bindSession(second, events.session);
	events.emit(assistantUsage(usage(160, 0.02)));
	await conversation.abort();
	events.emit(assistantUsage(usage(30, 0.003), "aborted"));
	conversation.executionSettled(second);

	const snapshot = conversation.snapshot();
	expect(
		snapshot.generations.map((generation) => generation.cost.total),
	).toEqual([0.01, 0.023]);
	expect(snapshot.cost.total).toBe(0.033);
	expect(snapshot.generations[1]?.usage.totalTokens).toBe(30);
	expect(snapshot.generations[1]?.status).toMatchObject({
		kind: "done",
		outcome: "aborted",
	});
});

test("reported zero cost has stable precision", () => {
	expect(formatCost(0)).toBe("$0.0000");
});
