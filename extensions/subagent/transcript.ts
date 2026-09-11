import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface TranscriptEntry {
	readonly title: string;
	readonly body: string;
	readonly toolCallId?: string;
	readonly running?: boolean;
	readonly parentToolCallId?: string;
	readonly isError?: boolean;
	readonly thinking?: string;
}

/** Generation-local history, independent of the SDK's compactable context. */
export class GenerationTranscript {
	private entries: readonly TranscriptEntry[] = [];
	private messageIndex: number | undefined;

	snapshot(): readonly TranscriptEntry[] {
		return this.entries;
	}

	record(event: AgentSessionEvent): boolean {
		if (
			event.type === "message_start" ||
			event.type === "message_update" ||
			event.type === "message_end"
		) {
			if (event.message.role === "toolResult") return false;
			const entry = {
				title: event.message.role,
				body: formatPayload(
					event.message.role === "assistant"
						? event.message.content.filter(
								(block) =>
									block.type !== "toolCall" && block.type !== "thinking",
							)
						: "content" in event.message
							? event.message.content
							: event.message,
				),
				...(event.message.role === "assistant"
					? {
							thinking: event.message.content
								.filter((block) => block.type === "thinking")
								.map((block) => block.thinking)
								.join("\n"),
						}
					: {}),
			};
			if (event.type === "message_start" || this.messageIndex === undefined) {
				this.messageIndex = this.entries.length;
				this.entries = [...this.entries, entry];
			} else this.replace(this.messageIndex, entry);
			if (event.type === "message_end") this.messageIndex = undefined;
			return true;
		}
		if (event.type === "tool_execution_start") {
			this.entries = [
				...this.entries,
				{
					title: `${event.toolName} · ${event.toolCallId}`,
					toolCallId: event.toolCallId,
					body: `Input\n${JSON.stringify(event.args, null, 2) ?? ""}`,
					running: true,
				},
			];
			return true;
		}
		if (
			event.type === "tool_execution_update" ||
			event.type === "tool_execution_end"
		) {
			const index = this.entries.findIndex(
				(entry) => entry.toolCallId === event.toolCallId,
			);
			const call = this.entries[index];
			if (!call) return false;
			// Partial results are snapshots, not deltas. Keep each emitted result so
			// progress information absent from the final result remains inspectable.
			if (event.type === "tool_execution_end")
				this.replace(index, { ...call, running: false });
			this.entries = [
				...this.entries,
				{
					title: `${event.toolName} · ${event.toolCallId} · ${event.type === "tool_execution_update" ? "progress" : event.isError ? "error" : "result"}`,
					parentToolCallId: event.toolCallId,
					isError: event.type === "tool_execution_end" && event.isError,
					body: formatPayload(
						event.type === "tool_execution_update"
							? event.partialResult
							: event.result,
					),
				},
			];
			return true;
		}
		if (
			event.type === "compaction_end" ||
			event.type === "auto_retry_start" ||
			event.type === "auto_retry_end"
		) {
			this.entries = [
				...this.entries,
				{ title: event.type, body: formatPayload(event) },
			];
			return true;
		}
		return false;
	}

	private replace(index: number, entry: TranscriptEntry): void {
		this.entries = this.entries.map((old, position) =>
			position === index ? entry : old,
		);
	}
}

function formatPayload(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(formatPayload).join("\n");
	if (value && typeof value === "object") {
		const block = value as Record<string, unknown>;
		if (block["type"] === "image")
			return `[image: ${String(block["mimeType"] ?? "unknown format")}]`;
		if (Array.isArray(block["content"])) {
			const { content, ...details } = block;
			return `${formatPayload(content)}${Object.keys(details).length ? `\nDetails\n${JSON.stringify(details, null, 2)}` : ""}`;
		}
		if (block["type"] === "text" && typeof block["text"] === "string")
			return block["text"];
		if (block["type"] === "thinking" && typeof block["thinking"] === "string")
			return `Thinking\n${block["thinking"]}`;
	}
	return JSON.stringify(value, null, 2) ?? "";
}
