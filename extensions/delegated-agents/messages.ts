import type { AssistantMessage } from "@earendil-works/pi-ai";

export function getFinalOutput(messages: AssistantMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message) continue;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (text) return text;
	}
	return "";
}

export function getToolCalls(
	messages: AssistantMessage[],
): { name: string; args: Record<string, unknown> }[] {
	return messages.flatMap((message) =>
		message.content.flatMap((part) =>
			part.type === "toolCall"
				? [{ name: part.name, args: part.arguments }]
				: [],
		),
	);
}
