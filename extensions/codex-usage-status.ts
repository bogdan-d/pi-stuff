/**
 * Codex usage status shortcut.
 *
 * Usage: /status
 *
 * Calls the Codex conversion usage helpers directly so `/status` shows usage
 * without sending `/codex usage` back through the chat input.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	fetchCodexUsage,
	formatCodexUsage,
} from "../../howaboua-pi-stuff/packages/pi-codex-conversion/src/ui/settings/usage.ts";

async function fetchUsage(ctx: ExtensionCommandContext) {
	return fetchCodexUsage({
		model: ctx.model,
		signal: ctx.signal,
		modelRegistry: {
			getApiKeyAndHeaders: async (
				model: Parameters<typeof ctx.modelRegistry.getApiKeyAndHeaders>[0],
			) => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok || !auth.headers) return auth;
				return {
					...auth,
					headers: Object.fromEntries(
						Object.entries(auth.headers).filter((entry) => entry[1] !== null),
					),
				};
			},
		},
	} as Parameters<typeof fetchCodexUsage>[0]);
}

export default function codexUsageStatusShortcut(pi: ExtensionAPI) {
	pi.registerCommand("status", {
		description: "Show Codex usage status",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed) {
				ctx.ui.notify("Usage: /status", "warning");
				return;
			}

			try {
				const usage = await fetchUsage(ctx);
				ctx.ui.notify(formatCodexUsage(usage), "info");
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}
