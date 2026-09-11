import { expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SubagentOverlayComponent } from "../../extensions/subagent/command/overlay.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../extensions/subagent/settings.js";
import { GenerationTranscript } from "../../extensions/subagent/transcript.js";
import { fakeAgent, fakeGeneration } from "./helpers/fake-agent.js";

test("trace retains concurrent inputs, progress and final errors without mutating earlier snapshots", () => {
	const trace = new GenerationTranscript();
	for (const id of ["a", "b"])
		trace.record({
			type: "tool_execution_start",
			toolName: "exec",
			toolCallId: id,
			args: { content: ["all"], nested: { data: "x".repeat(2000) } },
		});
	const before = trace.snapshot();
	trace.record({
		type: "tool_execution_update",
		toolName: "exec",
		toolCallId: "b",
		args: {},
		partialResult: { content: [{ type: "text", text: "partial\noutput" }] },
	});
	trace.record({
		type: "tool_execution_end",
		toolName: "exec",
		toolCallId: "b",
		isError: true,
		result: {
			content: [{ type: "text", text: "failed" }],
			details: { code: 3 },
		},
	});
	expect(before[1]?.running).toBe(true);
	expect(trace.snapshot()[0]?.running).toBe(true);
	expect(trace.snapshot()[1]?.running).toBe(false);
	expect(trace.snapshot()[0]?.body).toContain("x".repeat(2000));
	expect(trace.snapshot()[2]?.body).toBe("partial\noutput");
	expect(trace.snapshot()[3]?.title).toContain("b · error");
	expect(trace.snapshot()[3]?.body).toContain('"code": 3');
});

test("streamed assistant messages update in place and survive subsequent messages", () => {
	const trace = new GenerationTranscript();
	for (const [type, text] of [
		["message_start", ""],
		["message_update", "hello"],
		["message_end", "hello world"],
		["message_start", "next"],
	]) {
		trace.record({
			type,
			message: { role: "assistant", content: [{ type: "text", text }] },
		} as AgentSessionEvent);
	}
	expect(trace.snapshot().map((entry) => entry.body)).toEqual([
		"hello world",
		"next",
	]);
});

test("assistant tool JSON is omitted while text and collapsible thinking survive", () => {
	const trace = new GenerationTranscript();
	trace.record({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "Checking files" },
				{ type: "thinking", thinking: "private reasoning" },
				{
					type: "toolCall",
					id: "a",
					name: "read",
					arguments: { path: "file" },
				},
			],
		},
	} as AgentSessionEvent);
	expect(trace.snapshot()[0]?.body).toBe("Checking files");
	expect(trace.snapshot()[0]?.thinking).toBe("private reasoning");
});

test("both modal modes follow live traces and preserve a scrolled reading position", () => {
	let entries = Array.from({ length: 60 }, (_, index) => ({
		title: `tool-${index}`,
		body: `output-${index}`,
	}));
	const generation = fakeGeneration({
		status: { kind: "running" },
		prompt: "Pinned task prompt",
	});
	const conversation = () =>
		fakeAgent({
			generations: [
				{
					...generation,
					activity: { ...generation.activity, transcript: entries },
				},
			],
		});
	let update = () => {};
	const component = new SubagentOverlayComponent(
		{
			listConversations: () => [conversation()],
			onConversationUpdate: (listener: () => void) => {
				update = listener;
				return () => {};
			},
			collectSubagentForUser() {},
		} as any,
		{ requestRender() {}, terminal: { rows: 60 } },
		{} as any,
		undefined,
		() => {},
		{
			initialPage: "conversations",
			agents: [],
			settings: DEFAULT_SUBAGENT_SETTINGS,
			notify() {},
			onSettingsChange() {},
			onStart: () => undefined,
			onResume() {},
		},
	);
	for (const full of [false, true]) {
		if (full) component.handleInput("\r");
		component.handleInput("g");
		const following = component.render(110);
		expect(following.join("\n")).toContain(entries.at(-1)!.body);
		component.handleInput("\x1b[5~");
		const before = component.render(110).join("\n");
		for (const label of ["generation #1", "Pinned task prompt", "Activity"]) {
			const row = following.findIndex((line) => line.includes(label));
			expect(row).toBeGreaterThanOrEqual(0);
			expect(component.render(110)[row]).toContain(label);
		}
		expect(before).not.toContain(entries.at(-1)!.body);
		entries = [...entries, { title: "new tool", body: `new-output-${full}` }];
		update();
		expect(component.render(110).join("\n")).not.toContain(
			`new-output-${full}`,
		);
		component.handleInput("g");
		expect(component.render(110).join("\n")).toContain(`new-output-${full}`);
	}
	component.dispose();
});
