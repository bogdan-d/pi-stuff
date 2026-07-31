import { join } from "node:path";
import type {
	AssistantMessage,
	ModelThinkingLevel,
	Usage,
} from "@earendil-works/pi-ai";
import type {
	AgentToolUpdateCallback,
	RpcEventListener,
} from "@earendil-works/pi-coding-agent";
import { getPackageDir, RpcClient } from "@earendil-works/pi-coding-agent";
import { getFinalOutput, getToolCalls } from "./messages.js";
import type { ChildRunDetails, ProfileName, ProfileSpec } from "./types.js";

export const CHILD_ENV = "PI_DELEGATED_AGENT_CHILD";
const RUN_TIMEOUT_MS = 30 * 60 * 1_000;

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function recordMessage(
	details: ChildRunDetails,
	message: AssistantMessage,
): void {
	details.messages.push(message);
	details.model = `${message.provider}/${message.model}`;
	details.stopReason = message.stopReason;
	if (message.errorMessage) details.errorMessage = message.errorMessage;

	const source = message.usage;
	const target = details.usage;
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.totalTokens += source.totalTokens;
	target.cost.input += source.cost.input;
	target.cost.output += source.cost.output;
	target.cost.cacheRead += source.cost.cacheRead;
	target.cost.cacheWrite += source.cost.cacheWrite;
	target.cost.total += source.cost.total;
	if (source.cacheWrite1h !== undefined) {
		target.cacheWrite1h = (target.cacheWrite1h ?? 0) + source.cacheWrite1h;
	}
	if (source.reasoning !== undefined) {
		target.reasoning = (target.reasoning ?? 0) + source.reasoning;
	}
}

export function isSubagentFailure(details: ChildRunDetails): boolean {
	return details.stopReason === "error" || details.stopReason === "aborted";
}

export async function runDelegatedAgent(options: {
	profile: ProfileName;
	spec: ProfileSpec;
	task: string;
	cwd: string;
	model?: string;
	thinking?: ModelThinkingLevel;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<ChildRunDetails>;
}): Promise<ChildRunDetails> {
	const details: ChildRunDetails = {
		profile: options.profile,
		task: options.task,
		cwd: options.cwd,
		model: options.model ?? "default model",
		...(options.thinking ? { thinking: options.thinking } : {}),
		messages: [],
		stderr: "",
		usage: emptyUsage(),
	};
	const args = [
		"--no-session",
		"--no-skills",
		"--no-extensions",
		"--tools",
		options.spec.tools.join(","),
		"--append-system-prompt",
		options.spec.promptPath,
	];
	if (options.thinking) args.push("--thinking", options.thinking);

	const client = new RpcClient({
		cliPath: join(getPackageDir(), "dist", "cli.js"),
		cwd: options.cwd,
		env: { [CHILD_ENV]: "1" },
		...(options.model ? { model: options.model } : {}),
		args,
	});
	const prompt = [
		`Run as the ${options.spec.label} delegated agent inside an isolated no-session subprocess.`,
		"You receive no parent conversation. Treat this standalone task as the complete brief.",
		`Profile: ${options.profile}`,
		`Task: ${options.task}`,
	].join("\n\n");
	const handleEvent: RpcEventListener = (event) => {
		if (event.type !== "message_end" || event.message.role !== "assistant") {
			return;
		}
		recordMessage(details, event.message);
		const output = getFinalOutput(details.messages);
		if (!output && getToolCalls(details.messages).length === 0) return;
		options.onUpdate?.({
			content: output ? [{ type: "text", text: output }] : [],
			details,
		});
	};
	const removeEventListener = client.onEvent(handleEvent);
	const abort = () => {
		void client.abort().catch(() => undefined);
	};

	try {
		if (options.signal?.aborted) throw new Error("Delegated agent aborted.");
		await client.start();
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) throw new Error("Delegated agent aborted.");
		await client.setAutoCompaction(true);
		await client.setAutoRetry(true);
		await client.promptAndWait(prompt, undefined, RUN_TIMEOUT_MS);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const stderr = client.getStderr().trim();
		if (!stderr || message.includes(stderr)) throw error;
		throw new Error(`${message}\nStderr: ${stderr}`, { cause: error });
	} finally {
		details.stderr = client.getStderr();
		options.signal?.removeEventListener("abort", abort);
		removeEventListener();
		await client.stop();
	}

	return details;
}
