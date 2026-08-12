import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { getFinalOutput } from "./messages.js";
import { createSubagentOutputFile } from "./output-files.js";
import { isSubagentFailure } from "./runner.js";
import type { ChildRunDetails, PersistedRunDetails } from "./types.js";

export interface FinalizedRun {
	output: string;
	details: Omit<PersistedRunDetails, "id" | "mode">;
	failed: boolean;
	error?: string;
}

function truncateFailure(text: string): string {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) return text;
	return `${truncation.content}\n\n[Failure text truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
}

export async function prepareOutput(output: string): Promise<{
	text: string;
	truncated: boolean;
	fullOutputPath?: string;
}> {
	const truncation = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) return { text: output, truncated: false };

	const fullOutputPath = await createSubagentOutputFile(output);
	const notice = `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output: ${fullOutputPath}]`;
	return {
		text: `${truncation.content}\n\n${notice}`,
		truncated: true,
		fullOutputPath,
	};
}

export async function finalizeRun(
	details: ChildRunDetails,
): Promise<FinalizedRun> {
	const finalOutput = getFinalOutput(details.messages) || "(no output)";
	const output = await prepareOutput(finalOutput);
	const failed = isSubagentFailure(details);
	const errorSource = details.errorMessage || details.stderr;
	const error = failed
		? errorSource
			? truncateFailure(errorSource)
			: output.text
		: undefined;
	return {
		output: output.text,
		failed,
		...(error ? { error } : {}),
		details: {
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
		},
	};
}

export function formatRunFailure(agent: string, error: string): string {
	return `Subagent ${agent} failed: ${error}`;
}
