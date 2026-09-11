import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CHECKPOINT_TYPE,
	type ConversationCheckpoint,
	parseCheckpoint,
	readSavedSession,
} from "./checkpoint.js";
import { isConversationId } from "./identifiers.js";
import type { SubagentRuntime } from "./runtime.js";
import {
	loadSubagentSettings,
	type SubagentSettings,
	type SubagentSettingsStore,
} from "./settings.js";

/** Parent-owned registry. Child JSONL remains the only transcript store. */
export function registerSubagentPersistence(
	pi: ExtensionAPI,
	runtime: SubagentRuntime,
	settingsStore: Pick<SubagentSettingsStore, "load">,
	onSettings: (settings: SubagentSettings) => void,
): void {
	let context: ExtensionContext | undefined;
	const written = new Map<string, string>();
	const warn = (message: string) => {
		if (context?.hasUI) context.ui.notify(message, "warning");
		else console.warn(message);
	};
	const unsubscribe = runtime.onConversationUpdate((conversation, kind) => {
		if (!conversation.saveSessions && !written.has(conversation.conversationId))
			return;
		if (
			!context ||
			conversation.rootSessionId !== context.sessionManager.getSessionId()
		)
			return;
		if (!["status", "collection", "removed"].includes(kind)) return;
		try {
			if (kind === "removed") {
				pi.appendEntry(CHECKPOINT_TYPE, {
					version: 1,
					rootSessionId: conversation.rootSessionId,
					conversationId: conversation.conversationId,
					removed: true,
				});
				written.delete(conversation.conversationId);
				return;
			}
			// Include unsaved ancestors so a saved descendant keeps its ownership after reload.
			for (const ancestor of runtime.checkpointLineage(conversation)) {
				const data = ancestor.checkpoint();
				const serialized = JSON.stringify(data);
				if (written.get(ancestor.conversationId) === serialized) continue;
				pi.appendEntry(CHECKPOINT_TYPE, data);
				written.set(ancestor.conversationId, serialized);
			}
		} catch (error) {
			warn(`Could not save subagent state: ${errorMessage(error)}`);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		const settings = await loadSubagentSettings(ctx, settingsStore);
		onSettings(settings);
		runtime.configure({
			saveSessions: settings.runtime.saveSessions,
			maxExecuting: settings.runtime.maxConcurrentSubagents,
			maxConversations: settings.runtime.maxConversations,
		});
		const records = new Map<string, ConversationCheckpoint>();
		// Registry changes are session-wide, not undone by navigating the parent's conversation tree.
		// Forks have a new root ID and must not attach to their source's child files.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== CHECKPOINT_TYPE)
				continue;
			const data = entry.data;
			if (
				!data ||
				typeof data !== "object" ||
				!("rootSessionId" in data) ||
				data.rootSessionId !== ctx.sessionManager.getSessionId()
			)
				continue;
			if ("conversationId" in data && isConversationId(data.conversationId))
				runtime.reserveConversationId(data.conversationId);
			if (
				"removed" in data &&
				data.removed === true &&
				"version" in data &&
				data.version === 1 &&
				"conversationId" in data &&
				typeof data.conversationId === "string"
			) {
				records.delete(data.conversationId);
				continue;
			}
			try {
				const record = parseCheckpoint(data);
				records.set(record.conversationId, record);
			} catch (error) {
				if ("conversationId" in data && typeof data.conversationId === "string")
					records.delete(data.conversationId);
				warn(errorMessage(error));
			}
		}
		if (!settings.runtime.restoreSubagents || !settings.runtime.saveSessions)
			return;
		const restored = new Set<string>();
		while (records.size) {
			let progressed = false;
			for (const [id, record] of records) {
				if (
					record.parentConversationId &&
					!restored.has(record.parentConversationId)
				)
					continue;
				try {
					let session: ReturnType<typeof readSavedSession> | undefined;
					let unavailable: string | undefined;
					try {
						if (record.sessionFile)
							session = readSavedSession(record.sessionFile);
						else
							unavailable =
								"No saved session file. This subagent cannot be resumed.";
					} catch (error) {
						unavailable = `Session unavailable: ${errorMessage(error)}`;
					}
					await runtime.restoreConversation(record, session, unavailable);
					restored.add(id);
					written.set(id, JSON.stringify(record));
					if (unavailable) warn(`${record.label}: ${unavailable}`);
				} catch (error) {
					warn(`Could not restore ${record.label}: ${errorMessage(error)}`);
				}
				records.delete(id);
				progressed = true;
			}
			if (!progressed) {
				warn(
					`Could not restore subagents with missing or cyclic parents: ${[...records.keys()].join(", ")}`,
				);
				break;
			}
		}
	});
	pi.on("session_shutdown", () => {
		// Keep the last running checkpoint. Restoration marks it interrupted, without replaying work.
		context = undefined;
		unsubscribe();
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
