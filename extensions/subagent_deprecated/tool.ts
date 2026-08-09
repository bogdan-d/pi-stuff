import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatAgentCatalog, getAgentNames } from "./agents.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import { formatRunFailure } from "./results.js";
import type { SubagentManager } from "./runs.js";
import type { AgentCatalog, SubagentRunDetails } from "./types.js";

export function createSubagentTool(
	catalog: AgentCatalog,
	manager: SubagentManager,
) {
	const names = getAgentNames(catalog);
	const catalogText = formatAgentCatalog(catalog);
	const SubagentParams = Type.Object({
		agent: StringEnum(names, {
			description: "Built-in or configured subagent name.",
		}),
		task: Type.String({
			description: "Standalone task brief for the subagent.",
		}),
		cwd: Type.Optional(
			Type.String({
				description: "Working directory. Defaults to current cwd.",
			}),
		),
		background: Type.Optional(
			Type.Boolean({
				description: "Launch in background and return a run ID immediately.",
			}),
		),
		allowConcurrentWrites: Type.Optional(
			Type.Boolean({
				description:
					"Accept shared-workspace concurrent write risk for this call.",
			}),
		),
	});

	return defineTool<typeof SubagentParams, SubagentRunDetails>({
		name: "subagent",
		label: "Subagent",
		description: `Run a standalone task with an isolated built-in or configured Pi agent using its model-selected active tools.\n\nAvailable agents:\n${catalogText}`,
		promptSnippet:
			"Run isolated exploration, planning, implementation, verification, or review work",
		promptGuidelines: [
			"subagent: No inherited context; include background, exact objective, scope, constraints, cwd, and expected output.",
			"subagent: Select agent by name from the catalog in its tool description.",
			"subagent: Agents share the child runtime's active tools; role restrictions are behavioral instructions, not tool-level enforcement.",
			"subagent: Parallel calls must be independent; never batch subagent implementation with local mutating tools.",
			"subagent: Do not duplicate background implementation work. Use allowConcurrentWrites only when overlapping writes are knowingly safe.",
			"subagent: Keep the run ID returned by an accepted background launch for result retrieval or cancellation.",
			"subagent: Use planning for concrete implementation plans, not broad discovery.",
			"subagent: Use implementation for a scoped autonomous code change and focused validation.",
			"subagent: Use verification for reproducing failures, running checks, and root-cause diagnosis without source edits.",
			"subagent: Use review for actionable code-review findings without edits.",
			"subagent: Use explore-shallow for narrow, bounded discovery of hotspots, entry points, and best next reads.",
			"subagent: Use explore-deep for broad, open-ended, triage, compare/rank, or revisit-heavy discovery.",
			"subagent: Explore agents receive no inherited context; include background, exact question, scope, constraints, cwd, and desired evidence.",
		],
		parameters: SubagentParams,
		executionMode: "parallel",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const spec = catalog.get(params.agent);
			if (!spec) throw new Error(`Unknown subagent: ${params.agent}`);
			if (params.background && signal?.aborted)
				throw new Error("Subagent launch aborted.");
			const parentModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			const model = spec.model ?? parentModel;
			const thinking = spec.thinking ?? ctx.thinkingLevel;
			const run = {
				spec,
				task: params.task,
				cwd: params.cwd ?? ctx.cwd,
				...(model ? { model } : {}),
				...(thinking ? { thinking } : {}),
			};
			if (params.background) {
				const details = manager.startBackground({
					run,
					...(params.allowConcurrentWrites
						? { allowConcurrentWrites: true }
						: {}),
				});
				return {
					content: [
						{
							type: "text",
							text: `Started subagent in background.\nRun ID: ${details.id}\nAgent: ${details.agent}\nStatus: ${details.status}\nUse subagent_result with this ID to retrieve the result.`,
						},
					],
					details,
				};
			}

			const foreground = await manager.runForeground({
				run: {
					...run,
					...(signal ? { signal } : {}),
					...(onUpdate ? { onUpdate } : {}),
				},
				...(params.allowConcurrentWrites
					? { allowConcurrentWrites: true }
					: {}),
			});
			const { details, finalized } = foreground;
			if (finalized.failed)
				throw new Error(
					formatRunFailure(params.agent, finalized.error ?? finalized.output),
				);
			return {
				content: [{ type: "text", text: finalized.output }],
				details: {
					...finalized.details,
					id: foreground.id,
					mode: "foreground",
				},
				usage: details.usage,
			};
		},

		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderSubagentResult(result, options, theme, context.args.task);
		},
	});
}

export function registerSubagentTool(
	pi: ExtensionAPI,
	catalog: AgentCatalog,
	manager: SubagentManager,
): void {
	pi.registerTool(createSubagentTool(catalog, manager));
}
