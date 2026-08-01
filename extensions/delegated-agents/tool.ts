import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatAgentCatalog, getAgentNames } from "./agents.js";
import { renderDelegateCall, renderDelegateResult } from "./render.js";
import { formatRunFailure } from "./results.js";
import type { DelegatedAgentManager } from "./runs.js";
import type { AgentCatalog, DelegateRunDetails } from "./types.js";

export function createDelegateAgentTool(
	catalog: AgentCatalog,
	manager: DelegatedAgentManager,
) {
	const names = getAgentNames(catalog);
	const catalogText = formatAgentCatalog(catalog);
	const DelegateParams = Type.Object({
		agent: StringEnum(names, {
			description: "Built-in or configured delegated agent name.",
		}),
		task: Type.String({
			description: "Standalone task brief for the delegated agent.",
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

	return defineTool<typeof DelegateParams, DelegateRunDetails>({
		name: "delegate_agent",
		label: "Delegate Agent",
		description: `Delegate a standalone task to an isolated built-in or configured Pi agent using its model-selected active tools.\n\nAvailable agents:\n${catalogText}`,
		promptSnippet:
			"Delegate isolated planning, implementation, verification, or review work",
		promptGuidelines: [
			"delegate_agent: No inherited context; include background, exact objective, scope, constraints, cwd, and expected output.",
			"delegate_agent: Select agent by name from the catalog in its tool description.",
			"delegate_agent: Agents share the child runtime's active tools; role restrictions are behavioral instructions, not tool-level enforcement.",
			"delegate_agent: Parallel calls must be independent; never batch delegated implementation with local mutating tools.",
			"delegate_agent: Do not duplicate background implementation work. Use allowConcurrentWrites only when overlapping writes are knowingly safe.",
			"delegate_agent: Keep the run ID returned by an accepted background launch for result retrieval or cancellation.",
			"delegate_agent: Use planning for concrete implementation plans, not broad discovery.",
			"delegate_agent: Use implementation for a scoped autonomous code change and focused validation.",
			"delegate_agent: Use verification for reproducing failures, running checks, and root-cause diagnosis without source edits.",
			"delegate_agent: Use review for actionable code-review findings without edits.",
			"delegate_agent: Prefer explore_subagent when available for discovery-only retrieval.",
		],
		parameters: DelegateParams,
		executionMode: "parallel",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const spec = catalog.get(params.agent);
			if (!spec) throw new Error(`Unknown delegated agent: ${params.agent}`);
			if (params.background && signal?.aborted)
				throw new Error("Delegated agent launch aborted.");
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
							text: `Started delegated agent in background.\nRun ID: ${details.id}\nAgent: ${details.agent}\nStatus: ${details.status}\nUse delegate_agent_result with this ID to retrieve the result.`,
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
			return renderDelegateCall(args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderDelegateResult(result, options, theme, context.args.task);
		},
	});
}

export function registerDelegateAgentTool(
	pi: ExtensionAPI,
	catalog: AgentCatalog,
	manager: DelegatedAgentManager,
): void {
	pi.registerTool(createDelegateAgentTool(catalog, manager));
}
