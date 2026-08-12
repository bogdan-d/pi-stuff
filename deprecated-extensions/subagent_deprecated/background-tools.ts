import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SubagentManager } from "./runs.js";
import type { BackgroundRunResult } from "./types.js";

function formatRun(run: BackgroundRunResult): string {
	const lines = [
		`Run ID: ${run.id}`,
		`Agent: ${run.agent}`,
		`Status: ${run.status}`,
	];
	if (run.output !== undefined) lines.push("", run.output);
	if (run.error !== undefined) lines.push("", `Error: ${run.error}`);
	if (run.fullOutputPath) lines.push(`Full output: ${run.fullOutputPath}`);
	return lines.join("\n");
}

function formatRunSummary(run: BackgroundRunResult): string {
	return `Run ID: ${run.id}\nAgent: ${run.agent}\nStatus: ${run.status}`;
}

export function createBackgroundAgentTools(manager: SubagentManager) {
	const ResultParams = Type.Object({
		id: Type.Optional(
			Type.String({ description: "Background run ID. Omit to list runs." }),
		),
		wait: Type.Optional(
			Type.Boolean({ description: "Wait for the selected run to finish." }),
		),
	});
	const CancelParams = Type.Object({
		id: Type.String({ description: "Background run ID." }),
	});

	const result = defineTool<
		typeof ResultParams,
		BackgroundRunResult | BackgroundRunResult[]
	>({
		name: "subagent_result",
		label: "Subagent Result",
		description:
			"List background subagent runs or retrieve one result, optionally waiting for completion.",
		promptSnippet: "List or retrieve background subagent results",
		promptGuidelines: [
			"subagent_result: Use an accepted background run ID to inspect or wait for its result; interrupting a wait does not cancel the run.",
		],
		parameters: ResultParams,
		async execute(_toolCallId, params, signal) {
			if (params.wait && !params.id)
				throw new Error("subagent_result wait requires an id.");
			if (!params.id) {
				const runs = manager.list();
				return {
					content: [
						{
							type: "text",
							text: runs.length
								? runs.map(formatRunSummary).join("\n\n")
								: "No background subagent runs.",
						},
					],
					details: runs,
				};
			}
			if (params.wait) await manager.waitFor(params.id, signal);
			const claimed = manager.claim(params.id);
			return {
				content: [{ type: "text", text: formatRun(claimed.result) }],
				details: claimed.result,
				...(claimed.usage ? { usage: claimed.usage } : {}),
			};
		},
	});

	const cancel = defineTool<typeof CancelParams, BackgroundRunResult>({
		name: "subagent_cancel",
		label: "Cancel Subagent",
		description: "Cancel a queued or running background subagent run.",
		promptSnippet: "Cancel a background subagent run",
		parameters: CancelParams,
		async execute(_toolCallId, params) {
			const before = manager.get(params.id);
			const run = manager.cancel(params.id);
			const prefix =
				before.status === "running"
					? "Cancellation requested."
					: `Status: ${run.status}`;
			return {
				content: [{ type: "text", text: `${prefix}\nRun ID: ${run.id}` }],
				details: run,
			};
		},
	});
	return [result, cancel] as const;
}

export function registerBackgroundAgentTools(
	pi: ExtensionAPI,
	manager: SubagentManager,
): void {
	for (const tool of createBackgroundAgentTools(manager)) pi.registerTool(tool);
}
