import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Conversation } from "./conversation.js";
import type { SubagentRuntime } from "./runtime.js";

const LoadSkillParams = Type.Object(
	{
		name: Type.String({
			description: "Exact skill name to load.",
			minLength: 1,
		}),
	},
	{ additionalProperties: false },
);

export function makeChildSkillTool(
	runtime: Pick<SubagentRuntime, "loadChildSkill">,
	parent: Conversation,
): ToolDefinition {
	return defineTool({
		name: "load_skill",
		label: "Load Skill",
		description:
			"Load the full instructions for one available skill by exact name. Skill references remain ordinary filesystem paths readable with the existing file tools.",
		parameters: LoadSkillParams,
		async execute(_toolCallId, { name }) {
			const loaded = runtime.loadChildSkill(parent, name);
			return loaded.ok
				? {
						content: [{ type: "text", text: loaded.value }],
						details: { name },
					}
				: {
						content: [{ type: "text", text: loaded.error }],
						details: { name },
						isError: true,
					};
		},
	});
}
