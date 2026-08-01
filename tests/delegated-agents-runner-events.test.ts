import { describe, expect, test } from "bun:test";
import {
	runtimeEventFromRpcEvent,
	summarizeToolCall,
} from "../extensions/delegated-agents/runner.js";

describe("delegated-agent runtime events", () => {
	test("keeps path summaries but omits commands and unknown arguments", () => {
		expect(summarizeToolCall("read", { path: "src/../secret.ts" })).toBe(
			"secret.ts",
		);
		expect(summarizeToolCall("bash", { command: "echo super-secret" })).toBe(
			"command omitted",
		);
		expect(summarizeToolCall("custom", { token: "super-secret" })).toBe(
			"custom",
		);
	});

	test("translates only tool start and end events", () => {
		expect(
			runtimeEventFromRpcEvent({
				type: "tool_execution_start",
				toolCallId: "call",
				toolName: "grep",
				args: { pattern: "needle", path: "src" },
			}),
		).toEqual({
			type: "tool_start",
			id: "call",
			tool: "grep",
			summary: "needle in src",
			args: { pattern: "needle", path: "src" },
		});
		expect(
			runtimeEventFromRpcEvent({
				type: "tool_execution_end",
				toolCallId: "call",
				toolName: "grep",
				isError: true,
			}),
		).toEqual({ type: "tool_end", id: "call", tool: "grep", failed: true });
		expect(
			runtimeEventFromRpcEvent({ type: "tool_execution_update" }),
		).toBeUndefined();
	});
});
