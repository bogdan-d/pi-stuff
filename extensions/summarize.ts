import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	ProviderStreamOptions,
	UserMessage,
} from "@earendil-works/pi-ai";
import { complete, getModel } from "@earendil-works/pi-ai/compat";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";

const extractTextParts = (content: unknown): string[] => {
	if (typeof content === "string") {
		return [content];
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const textParts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		if (
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string"
		) {
			textParts.push(part.text);
		}
	}

	return textParts;
};

const extractToolCallLines = (content: unknown): string[] => {
	if (!Array.isArray(content)) {
		return [];
	}

	const toolCalls: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		if (
			!("type" in part) ||
			part.type !== "toolCall" ||
			!("name" in part) ||
			typeof part.name !== "string"
		) {
			continue;
		}

		const args =
			"arguments" in part && part.arguments != null ? part.arguments : {};
		toolCalls.push(
			`Tool ${part.name} was called with args ${JSON.stringify(args)}`,
		);
	}

	return toolCalls;
};

const buildConversationText = (entries: SessionEntry[]): string => {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") {
			continue;
		}

		const message = entry.message;
		if (!isConversationMessage(message)) {
			continue;
		}

		const role = message.role;
		const isUser = role === "user";
		const isAssistant = role === "assistant";

		if (!isUser && !isAssistant) {
			continue;
		}

		const entryLines: string[] = [];
		const textParts = extractTextParts(message.content);
		if (textParts.length > 0) {
			const roleLabel = isUser ? "User" : "Assistant";
			const messageText = textParts.join("\n").trim();
			if (messageText.length > 0) {
				entryLines.push(`${roleLabel}: ${messageText}`);
			}
		}

		if (isAssistant) {
			entryLines.push(...extractToolCallLines(message.content));
		}

		if (entryLines.length > 0) {
			sections.push(entryLines.join("\n"));
		}
	}

	return sections.join("\n\n");
};

const isConversationMessage = (
	message: AgentMessage,
): message is UserMessage | AssistantMessage =>
	message.role === "user" || message.role === "assistant";

const buildSummaryPrompt = (conversationText: string): string =>
	[
		"Summarize this conversation so I can resume it later.",
		"Include goals, key decisions, progress, open questions, and next steps.",
		"Keep it concise and structured with headings.",
		"",
		"<conversation>",
		conversationText,
		"</conversation>",
	].join("\n");

const showSummaryUi = async (summary: string, ctx: ExtensionCommandContext) => {
	if (!ctx.hasUI) {
		return;
	}

	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		const mdTheme = getMarkdownTheme();

		container.addChild(border);
		container.addChild(
			new Text(theme.fg("accent", theme.bold("Conversation Summary")), 1, 0),
		);
		container.addChild(new Markdown(summary, 1, 1, mdTheme));
		container.addChild(
			new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0),
		);
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
					done(undefined);
				}
			},
		};
	});
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("summarize", {
		description: "Summarize the current conversation in a custom UI",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const conversationText = buildConversationText(branch);

			if (!conversationText.trim()) {
				if (ctx.hasUI) {
					ctx.ui.notify("No conversation text found", "warning");
				}
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify("Preparing summary...", "info");
			}

			const model = getModel("openai", "gpt-5.2");
			if (!model && ctx.hasUI) {
				ctx.ui.notify("Model openai/gpt-5.2 not found", "warning");
			}

			const auth = model
				? await ctx.modelRegistry.getApiKeyAndHeaders(model)
				: undefined;
			if (auth && !auth.ok && ctx.hasUI) {
				ctx.ui.notify(auth.error, "warning");
			}
			if (auth?.ok && !auth.apiKey && ctx.hasUI) {
				ctx.ui.notify("No API key for openai/gpt-5.2", "warning");
			}

			if (!model || !auth?.ok || !auth.apiKey) {
				return;
			}

			const summaryMessages = [
				{
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: buildSummaryPrompt(conversationText),
						},
					],
					timestamp: Date.now(),
				},
			];

			const requestOptions: ProviderStreamOptions = {
				apiKey: auth.apiKey,
				reasoningEffort: "high",
			};
			if (auth.headers !== undefined) {
				requestOptions.headers = auth.headers;
			}

			const response = await complete(
				model,
				{ messages: summaryMessages },
				requestOptions,
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			await showSummaryUi(summary, ctx);
		},
	});
}
