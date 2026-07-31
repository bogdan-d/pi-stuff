import { describe, expect, test } from "bun:test";
import {
	cleanStepText,
	extractDoneSteps,
	extractTodoItems,
	isSafeCommand,
	markCompletedSteps,
} from "../extensions/plan-mode/utils.ts";

describe("plan mode utilities", () => {
	test("allows read-only commands and blocks writes", () => {
		expect(isSafeCommand("git status --short")).toBe(true);
		expect(isSafeCommand("rg TODO extensions")).toBe(true);
		expect(isSafeCommand("cat README.md > copy.md")).toBe(false);
		expect(isSafeCommand("git status && rm file")).toBe(false);
	});

	test("extracts and cleans numbered plan steps", () => {
		expect(
			extractTodoItems(`Plan:
1. **Read the config**
2) Run \`bun test\`

Notes follow.`),
		).toEqual([
			{ step: 1, text: "Config", completed: false },
			{ step: 2, text: "Bun test", completed: false },
		]);
		expect(cleanStepText(`Update   the **very long** configuration`)).toBe(
			"Very long configuration",
		);
	});

	test("marks reported steps complete", () => {
		const items = extractTodoItems(
			"Plan:\n1. Inspect files\n2. Update scripts",
		);

		expect(extractDoneSteps("[DONE:2] ignored [done:9]")).toEqual([2, 9]);
		expect(markCompletedSteps("[DONE:2]", items)).toBe(1);
		expect(items[1]?.completed).toBe(true);
	});
});
