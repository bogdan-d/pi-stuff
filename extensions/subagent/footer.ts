import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ConversationSnapshot } from "./conversation.js";
import { formatCost } from "./generation-format.js";
import type { SubagentRuntime } from "./runtime.js";

const STATUS_KEY = "subagent-cost";

/** Publishes monotonic subagent spend through Pi's default footer status area. */
export function registerSubagentCostStatusLifecycle(
	pi: Pick<ExtensionAPI, "on">,
	source: Pick<SubagentRuntime, "listConversations" | "onConversationUpdate">,
): void {
	let context: ExtensionContext | undefined;
	let unsubscribe: (() => void) | undefined;
	let total = 0;
	const observed = new Map<string, number>();

	const publish = () => {
		if (!context?.hasUI) return;
		try {
			context.ui.setStatus(
				STATUS_KEY,
				observed.size ? `subs ${formatCost(total)}` : undefined,
			);
		} catch {}
	};
	const observe = (conversation: ConversationSnapshot): boolean => {
		const current =
			Number.isFinite(conversation.cost.total) && conversation.cost.total > 0
				? conversation.cost.total
				: 0;
		const previous = observed.get(conversation.conversationId);
		if (previous !== undefined && current <= previous) return false;
		observed.set(conversation.conversationId, current);
		total += current - (previous ?? 0);
		return true;
	};
	const subscribe = () => {
		unsubscribe ??= source.onConversationUpdate((conversation) => {
			if (observe(conversation.snapshot())) publish();
		});
	};

	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		total = 0;
		observed.clear();
		for (const conversation of source.listConversations())
			observe(conversation);
		subscribe();
		publish();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		try {
			if (context?.hasUI) context.ui.setStatus(STATUS_KEY, undefined);
			else if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {}
		context = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
		total = 0;
		observed.clear();
	});
}
