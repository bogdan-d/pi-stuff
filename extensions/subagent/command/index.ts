import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentRegistry } from "../agents.js";
import type { SubagentId } from "../identifiers.js";
import type { SubagentRuntime } from "../runtime.js";
import {
	prepareSubagentRuntime,
	type SubagentSettings,
	SubagentSettingsStore,
} from "../settings.js";
import { updateSubagentWidget } from "../widget.js";
import { SUBAGENTS_SHORTCUT } from "./input.js";
import {
	SubagentOverlayComponent,
	type SubagentOverlayPage,
} from "./overlay.js";
import { applySubagentSettingsChange } from "./settings.js";

export function registerSubagentsCommand(
	pi: ExtensionAPI,
	runtime: SubagentRuntime,
	settingsStore: Pick<
		SubagentSettingsStore,
		"load" | "save"
	> = new SubagentSettingsStore(),
	agentRegistry?: AgentRegistry,
	onSettingsUpdated?: (settings: SubagentSettings) => void,
) {
	const subagentsCommand = {
		description: "Manage subagent conversations and generations",
		getArgumentCompletions,
		handler: async (args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI || !ctx.ui?.custom) return;

			const requested = args.trim();
			const initialPage: SubagentOverlayPage =
				requested === "settings" ||
				requested === "agents" ||
				requested === "conversations"
					? requested
					: runtime.listConversations().length
						? "conversations"
						: "agents";
			let settings = await prepareSubagentRuntime({
				ctx,
				settingsStore,
				runtime,
				...(agentRegistry ? { agentRegistry } : {}),
			});
			onSettingsUpdated?.(settings);
			await runtime.prepareSkillCatalog?.(ctx.cwd);
			updateSubagentWidget(ctx, runtime.listConversations(), settings);
			let saveQueue = Promise.resolve();
			let restoreAltScreenPaging: (() => void) | undefined;

			try {
				await ctx.ui.custom<void>(
					(tui, theme, keys, done) => {
						restoreAltScreenPaging = suspendAltScreenPaging(keys);
						return new SubagentOverlayComponent(
							runtime,
							tui,
							theme,
							keys,
							() => done(undefined),
							{
								initialPage,
								agents: agentRegistry ? [...agentRegistry.agents.values()] : [],
								settings,
								models:
									ctx.modelRegistry
										?.getAll()
										.map((model) => `${model.provider}/${model.id}`) ?? [],
								notify: (message, level) => notify(ctx, message, level as any),
								onSettingsChange: (change) => {
									settings = applySubagentSettingsChange(settings, change);
									runtime.configure({
										generalPurposeModel: settings.runtime.generalPurposeModel,
										generalPurposeThinking:
											settings.runtime.generalPurposeThinking,
										saveSessions: settings.runtime.saveSessions,
										maxExecuting: settings.runtime.maxConcurrentSubagents,
										maxConversations: settings.runtime.maxConversations,
									});
									if (
										change.kind === "widgetPlacement" ||
										change.kind === "widgetMode" ||
										change.kind === "widgetMaxRowsPerSection"
									) {
										updateSubagentWidget(
											ctx,
											runtime.listConversations(),
											settings,
										);
									}
									onSettingsUpdated?.(settings);
									const next = settings;
									saveQueue = saveQueue
										.then(() => settingsStore.save(next))
										.catch((error) => {
											notify(
												ctx,
												`Could not save subagent settings: ${errorMessage(error)}`,
												"warning",
											);
										});
									return settings;
								},
								onStart: (agent, prompt) => {
									const start = runtime.startTasks(
										ctx,
										[{ kind: "spawn", agent, prompt, label: prompt }],
										{ initiatedBy: "user" },
									).starts[0];
									if (!start?.ok) {
										notify(
											ctx,
											start?.error ?? "Could not start generation.",
											"warning",
										);
										return undefined;
									}
									updateSubagentWidget(
										ctx,
										runtime.listConversations(),
										settings,
									);
									notify(
										ctx,
										`Started ${agent} (${start.conversationId}, generation ${start.generation}).`,
										"info",
									);
									return start.conversationId;
								},
								onResume: (conversationId, prompt) => {
									const start = runtime.startTasks(
										ctx,
										[
											{
												kind: "resume",
												subagentId: conversationId as SubagentId,
												prompt,
											},
										],
										{ initiatedBy: "user" },
									).starts[0];
									if (!start?.ok)
										notify(
											ctx,
											start?.error ??
												`Could not resume conversation ${conversationId}.`,
											"warning",
										);
									else {
										updateSubagentWidget(
											ctx,
											runtime.listConversations(),
											settings,
										);
										notify(
											ctx,
											`Resumed subagent ${conversationId} with generation ${start.generation}.`,
											"info",
										);
									}
								},
								onCancel: async (subagentId) => {
									try {
										await runtime.cancelSubagent(subagentId as SubagentId);
										notify(ctx, "Cancelled subagent.", "info");
									} catch (error) {
										notify(ctx, errorMessage(error), "warning");
									}
									updateSubagentWidget(
										ctx,
										runtime.listConversations(),
										settings,
									);
								},
								onRemove: async (conversationId) => {
									const result =
										await runtime.removeConversation(conversationId);
									if (result.ok) {
										const removed = result.removedIds.length;
										notify(
											ctx,
											`Removed ${removed} subagent${removed === 1 ? "" : "s"} rooted at ${conversationId}.`,
											"info",
										);
									} else notify(ctx, result.error, "warning");
									updateSubagentWidget(
										ctx,
										runtime.listConversations(),
										settings,
									);
								},
							},
						);
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "center",
							width: "95%",
							minWidth: 56,
							maxHeight: "95%",
						},
					},
				);
			} catch (error) {
				notify(ctx, `Subagents UI failed: ${errorMessage(error)}`, "warning");
			} finally {
				restoreAltScreenPaging?.();
			}
			await saveQueue;
		},
	};
	pi.registerCommand?.("subagents", subagentsCommand);
	pi.registerShortcut?.(SUBAGENTS_SHORTCUT, {
		description: "Open subagent manager",
		handler: (ctx) => subagentsCommand.handler("", ctx),
	});
}

function suspendAltScreenPaging(
	keybindings:
		| Pick<KeybindingsManager, "getUserBindings" | "setUserBindings">
		| undefined,
): () => void {
	if (!keybindings) return () => {};
	const userBindings = keybindings.getUserBindings();
	keybindings.setUserBindings({
		...userBindings,
		"tui.altScreen.pageUp": [],
		"tui.altScreen.pageDown": [],
	});
	return () => keybindings.setUserBindings(userBindings);
}

function getArgumentCompletions(prefix: string) {
	const values = [
		{
			value: "conversations",
			label: "conversations",
			description: "Open conversations and generations",
		},
		{ value: "agents", label: "agents", description: "Browse agents" },
		{ value: "settings", label: "settings", description: "Open settings" },
	];
	const normalized = prefix.trimStart();
	if (normalized.includes(" ")) return null;
	const filtered = values.filter((value) => value.value.startsWith(normalized));
	return filtered.length ? filtered : null;
}

export function notify(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error" | "success" = "info",
) {
	if (!ctx.hasUI) return;
	try {
		ctx.ui?.notify?.(message, level as any);
	} catch {}
}

export function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
