import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import {
	finalizeRun,
	formatRunFailure,
} from "../extensions/subagent/results.js";

const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function details(text = "hello", overrides = {}) {
	return {
		agent: "review",
		role: "review",
		description: "Reviews",
		task: "task",
		cwd: "/tmp",
		model: "provider/model",
		messages: text
			? [
					{
						role: "assistant",
						content: [{ type: "text", text }],
						provider: "p",
						model: "m",
						usage,
						stopReason: "stop",
					},
				]
			: [],
		stderr: "",
		usage,
		...overrides,
	} as any;
}

describe("subagent result finalization", () => {
	test("keeps normal and empty output compact", async () => {
		const normal = await finalizeRun(details());
		expect(normal.output).toBe("hello");
		expect(normal.details).not.toHaveProperty("messages");
		expect((await finalizeRun(details(""))).output).toBe("(no output)");
	});

	test("uses error message, stderr, then output precedence", async () => {
		expect(
			(
				await finalizeRun(
					details("output", {
						stopReason: "error",
						errorMessage: "model error",
						stderr: "stderr",
					}),
				)
			).error,
		).toBe("model error");
		expect(
			(
				await finalizeRun(
					details("output", { stopReason: "error", stderr: "stderr" }),
				)
			).error,
		).toBe("stderr");
		expect(formatRunFailure("review", "bad")).toBe(
			"Subagent review failed: bad",
		);
	});

	test("truncates oversized output into a private file", async () => {
		const full = Array.from(
			{ length: 3000 },
			(_, index) => `line ${index}`,
		).join("\n");
		const result = await finalizeRun(details(full));
		expect(result.details.truncated).toBe(true);
		expect(result.output).toContain("Output truncated");
		expect((await stat(result.details.fullOutputPath!)).mode & 0o777).toBe(
			0o600,
		);
	});

	test("does not retain unbounded failure text", async () => {
		const full = Array.from(
			{ length: 3000 },
			(_, index) => `failure ${index}`,
		).join("\n");
		const result = await finalizeRun(details(full, { stopReason: "error" }));
		expect(result.error).toBe(result.output);
		expect(result.error).toContain("Output truncated");
		expect(result.error).not.toContain("failure 2999");
	});
});
