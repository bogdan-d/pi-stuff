/**
 * Codex usage status shortcut.
 *
 * Usage: /status
 *
 * Calls the Codex conversion usage helpers directly so `/status` shows usage
 * without sending `/codex usage` back through the chat input.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	fetchCodexUsage,
	formatCodexUsage,
} from "../../howaboua-pi-stuff/packages/pi-codex-conversion/src/ui/settings/usage.ts";

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
				const usage = await fetchCodexUsage(ctx);
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
