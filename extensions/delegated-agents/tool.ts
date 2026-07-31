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
import { getFinalOutput } from "./messages.js";
import { PROFILE_NAMES, PROFILES } from "./profiles.js";
import { renderDelegateCall, renderDelegateResult } from "./render.js";
import { isSubagentFailure, runDelegatedAgent } from "./runner.js";
import type { DelegateRunDetails, PersistedRunDetails } from "./types.js";

const DelegateParams = Type.Object({
	profile: StringEnum(PROFILE_NAMES, {
		description: "planning | implementation | verification | review",
	}),
	task: Type.String({
		description: "Standalone task brief for the delegated agent.",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory. Defaults to current cwd." }),
	),
});

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

const delegateAgentTool = defineTool<typeof DelegateParams, DelegateRunDetails>(
	{
		name: "delegate_agent",
		label: "Delegate Agent",
		description:
			"Delegate a standalone planning, implementation, verification/debugging, or review task to an isolated Pi agent.",
		promptSnippet:
			"Delegate isolated planning, implementation, verification, or review work",
		promptGuidelines: [
			"delegate_agent: No inherited context; include background, exact objective, scope, constraints, cwd, and expected output.",
			"delegate_agent: Use planning for concrete implementation plans, not broad discovery.",
			"delegate_agent: Use implementation for a scoped autonomous code change and focused validation.",
			"delegate_agent: Use verification for reproducing failures, running checks, and root-cause diagnosis without source edits.",
			"delegate_agent: Use review for actionable code-review findings without edits.",
			"delegate_agent: Prefer explore_subagent when available for discovery-only retrieval.",
		],
		parameters: DelegateParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const spec = PROFILES[params.profile];
			const details = await runDelegatedAgent({
				profile: params.profile,
				spec,
				task: params.task,
				cwd: params.cwd ?? ctx.cwd,
				...(ctx.model
					? { model: `${ctx.model.provider}/${ctx.model.id}` }
					: {}),
				...(ctx.thinkingLevel ? { thinking: ctx.thinkingLevel } : {}),
				...(signal ? { signal } : {}),
				...(onUpdate ? { onUpdate } : {}),
			});
			const finalOutput = getFinalOutput(details.messages) || "(no output)";
			if (isSubagentFailure(details)) {
				throw new Error(
					`Delegated ${params.profile} agent failed: ${details.errorMessage || details.stderr || finalOutput}`,
				);
			}

			const output = await prepareOutput(finalOutput);
			const persistedDetails: PersistedRunDetails = {
				profile: details.profile,
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
	},
);

export function registerDelegateAgentTool(pi: ExtensionAPI): void {
	pi.registerTool(delegateAgentTool);
}
