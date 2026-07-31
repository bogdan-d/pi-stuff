import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	type ExtensionAPI,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatAgentCatalog, getAgentNames } from "./agents.js";
import { getFinalOutput } from "./messages.js";
import { renderDelegateCall, renderDelegateResult } from "./render.js";
import { isSubagentFailure, runDelegatedAgent } from "./runner.js";
import type {
	AgentCatalog,
	DelegateRunDetails,
	PersistedRunDetails,
} from "./types.js";

async function prepareOutput(output: string): Promise<{
	text: string;
	truncated: boolean;
	fullOutputPath?: string;
}> {
	const truncation = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) return { text: output, truncated: false };

	const directory = await mkdtemp(join(tmpdir(), "pi-delegated-agent-"));
	const fullOutputPath = join(directory, "output.md");
	await writeFile(fullOutputPath, output, { encoding: "utf8", mode: 0o600 });
	const notice = `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output: ${fullOutputPath}]`;
	return {
		text: `${truncation.content}\n\n${notice}`,
		truncated: true,
		fullOutputPath,
	};
}

export function createDelegateAgentTool(catalog: AgentCatalog) {
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
			"delegate_agent: Use planning for concrete implementation plans, not broad discovery.",
			"delegate_agent: Use implementation for a scoped autonomous code change and focused validation.",
			"delegate_agent: Use verification for reproducing failures, running checks, and root-cause diagnosis without source edits.",
			"delegate_agent: Use review for actionable code-review findings without edits.",
			"delegate_agent: Prefer explore_subagent when available for discovery-only retrieval.",
		],
		parameters: DelegateParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const spec = catalog.get(params.agent);
			if (!spec) throw new Error(`Unknown delegated agent: ${params.agent}`);
			const parentModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;
			const model = spec.model ?? parentModel;
			const thinking = spec.thinking ?? ctx.thinkingLevel;
			const details = await runDelegatedAgent({
				spec,
				task: params.task,
				cwd: params.cwd ?? ctx.cwd,
				...(model ? { model } : {}),
				...(thinking ? { thinking } : {}),
				...(signal ? { signal } : {}),
				...(onUpdate ? { onUpdate } : {}),
			});
			const finalOutput = getFinalOutput(details.messages) || "(no output)";
			if (isSubagentFailure(details)) {
				throw new Error(
					`Delegated agent ${params.agent} failed: ${details.errorMessage || details.stderr || finalOutput}`,
				);
			}

			const output = await prepareOutput(finalOutput);
			const persistedDetails: PersistedRunDetails = {
				agent: details.agent,
				role: details.role,
				...(details.description ? { description: details.description } : {}),
				cwd: details.cwd,
				model: details.model,
				...(details.thinking ? { thinking: details.thinking } : {}),
				usage: details.usage,
				truncated: output.truncated,
				...(output.fullOutputPath
					? { fullOutputPath: output.fullOutputPath }
					: {}),
			};
			return {
				content: [{ type: "text", text: output.text }],
				details: persistedDetails,
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
): void {
	pi.registerTool(createDelegateAgentTool(catalog));
}
