import { expect, test } from "bun:test";
import { makeChildSkillTool } from "../../extensions/subagent/skill-tool.js";

test("child skill tool loads one exact name without listing catalog metadata", async () => {
	const loadChildSkill = (parent: unknown, name: string) => ({
		ok: true as const,
		value: `<skill name="${name}">Loaded instructions.</skill>`,
	});
	const parent = {} as any;
	const tool = makeChildSkillTool({ loadChildSkill } as any, parent);

	expect(tool.name).toBe("load_skill");
	expect(tool.promptSnippet).toBeUndefined();
	expect(tool.description).not.toContain("secret-review");
	expect(Object.keys((tool.parameters as any).properties)).toEqual(["name"]);

	const result = await tool.execute(
		"call",
		{ name: "secret-review" },
		undefined,
		undefined,
		{} as any,
	);

	expect(loadChildSkill(parent, "secret-review")).toEqual({
		ok: true,
		value: '<skill name="secret-review">Loaded instructions.</skill>',
	});
	expect(result).toEqual({
		content: [
			{
				type: "text",
				text: '<skill name="secret-review">Loaded instructions.</skill>',
			},
		],
		details: { name: "secret-review" },
	});
});

test("child skill tool reports an unknown exact name without revealing alternatives", async () => {
	const tool = makeChildSkillTool(
		{
			loadChildSkill: (_parent: unknown, name: string) => ({
				ok: false as const,
				error: `Unknown skill: ${name}`,
			}),
		} as any,
		{} as any,
	);

	const result = await tool.execute(
		"call",
		{ name: "missing" },
		undefined,
		undefined,
		{} as any,
	);

	expect(result).toEqual({
		content: [{ type: "text", text: "Unknown skill: missing" }],
		details: { name: "missing" },
		isError: true,
	});
});
