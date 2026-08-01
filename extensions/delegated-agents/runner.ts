import { join, normalize } from "node:path";
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
import { ROLES } from "./roles.js";
import type { DelegatedAgentRuntimeEvent } from "./run-history.js";
import type { AgentSpec, ChildRunDetails } from "./types.js";

export const CHILD_ENV = "PI_DELEGATED_AGENT_CHILD";
const RUN_TIMEOUT_MS = 30 * 60 * 1_000;

export class DelegatedAgentRunError extends Error {
	readonly details: ChildRunDetails;

	constructor(message: string, details: ChildRunDetails, cause: unknown) {
		super(message, { cause });
		this.name = "DelegatedAgentRunError";
		this.details = details;
	}
}

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

export function buildChildArgs(
	spec: AgentSpec,
	thinking?: ModelThinkingLevel,
): string[] {
	const args = [
		"--no-session",
		"--no-skills",
		"--append-system-prompt",
		spec.rolePromptPath,
	];
	if (spec.specializationPrompt) {
		args.push(
			"--append-system-prompt",
			`Custom delegated-agent specialization:\n${spec.specializationPrompt}`,
		);
	}
	if (thinking) args.push("--thinking", thinking);
	return args;
}

export interface RunDelegatedAgentOptions {
	spec: AgentSpec;
	task: string;
	cwd: string;
	model?: string;
	thinking?: ModelThinkingLevel;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<ChildRunDetails>;
	onEvent?: (event: DelegatedAgentRuntimeEvent) => void;
}

function oneLine(value: unknown, fallback: string): string {
	const text = String(value ?? fallback)
		.replaceAll(/\s+/g, " ")
		.trim();
	return (text || fallback).slice(0, 160);
}

export function summarizeToolCall(
	tool: string,
	args: Record<string, unknown>,
): string {
	if (["bash", "exec", "exec_command"].includes(tool)) return "command omitted";
	if (["read", "write", "edit", "ls"].includes(tool))
		return oneLine(normalize(String(args["path"] ?? ".")), ".");
	if (["grep", "find", "rg"].includes(tool)) {
		const pattern = oneLine(args["pattern"], "*");
		const path = oneLine(normalize(String(args["path"] ?? ".")), ".");
		return `${pattern} in ${path}`.slice(0, 160);
	}
	return tool;
}

export function runtimeEventFromRpcEvent(event: {
	type: string;
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	isError?: boolean;
}): DelegatedAgentRuntimeEvent | undefined {
	if (
		(event.type !== "tool_execution_start" &&
			event.type !== "tool_execution_end") ||
		!event.toolCallId ||
		!event.toolName
	)
		return undefined;
	if (event.type === "tool_execution_end") {
		return {
			type: "tool_end",
			id: event.toolCallId,
			tool: event.toolName,
			failed: event.isError ?? false,
		};
	}
	const args =
		event.args && typeof event.args === "object"
			? (event.args as Record<string, unknown>)
			: {};
	return {
		type: "tool_start",
		id: event.toolCallId,
		tool: event.toolName,
		summary: summarizeToolCall(event.toolName, args),
	};
}

export async function runDelegatedAgent(
	options: RunDelegatedAgentOptions,
): Promise<ChildRunDetails> {
	const details: ChildRunDetails = {
		agent: options.spec.name,
		role: options.spec.role,
		description: options.spec.description,
		task: options.task,
		cwd: options.cwd,
		model: options.model ?? "default model",
		...(options.thinking ? { thinking: options.thinking } : {}),
		messages: [],
		stderr: "",
		usage: emptyUsage(),
	};
	const args = buildChildArgs(options.spec, options.thinking);

	const client = new RpcClient({
		cliPath: join(getPackageDir(), "dist", "cli.js"),
		cwd: options.cwd,
		env: { [CHILD_ENV]: "1" },
		...(options.model ? { model: options.model } : {}),
		args,
	});
	const prompt = [
		`Run as the ${ROLES[options.spec.role].label} delegated agent inside an isolated no-session subprocess.`,
		"You receive no parent conversation. Treat this standalone task as the complete brief.",
		`Agent: ${options.spec.name}`,
		`Role: ${options.spec.role}`,
		`Task: ${options.task}`,
	].join("\n\n");
	const handleEvent: RpcEventListener = (event) => {
		const runtimeEvent = runtimeEventFromRpcEvent(event);
		if (runtimeEvent) {
			try {
				options.onEvent?.(runtimeEvent);
			} catch {
				// Runtime observers cannot own or disrupt the delegated run.
			}
		}
		if (event.type !== "message_end" || event.message.role !== "assistant") {
			return;
		}
		recordMessage(details, event.message);
		const output = getFinalOutput(details.messages);
		if (!output && getToolCalls(details.messages).length === 0) return;
		try {
			options.onUpdate?.({
				content: output ? [{ type: "text", text: output }] : [],
				details,
			});
		} catch {
			// Parent streaming updates are advisory.
		}
	};
	const removeEventListener = client.onEvent(handleEvent);
	const abort = () => {
		void client.abort().catch(() => undefined);
	};

	let failure: unknown;
	try {
		if (options.signal?.aborted) throw new Error("Delegated agent aborted.");
		await client.start();
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) throw new Error("Delegated agent aborted.");
		await client.setAutoCompaction(true);
		await client.setAutoRetry(true);
		await client.promptAndWait(prompt, undefined, RUN_TIMEOUT_MS);
	} catch (error) {
		failure = error;
	} finally {
		details.stderr = client.getStderr();
		options.signal?.removeEventListener("abort", abort);
		removeEventListener();
		try {
			await client.stop();
		} catch (error) {
			failure ??= error;
		}
	}

	if (failure) {
		const message =
			failure instanceof Error ? failure.message : String(failure);
		const stderr = details.stderr.trim();
		const fullMessage =
			stderr && !message.includes(stderr)
				? `${message}\nStderr: ${stderr}`
				: message;
		details.stopReason = options.signal?.aborted ? "aborted" : "error";
		details.errorMessage = fullMessage;
		throw new DelegatedAgentRunError(fullMessage, details, failure);
	}

	return details;
}
