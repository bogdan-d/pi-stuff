import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Args,
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	parseArgs,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type AccountStorageBackend,
	FileAccountStorageBackend,
} from "./storage.js";

type Selection = { provider: string; model: string; thinking: ThinkingLevel };
export type SelectionOptions = {
	storage?: AccountStorageBackend;
	args?: Pick<
		Args,
		| "model"
		| "provider"
		| "models"
		| "thinking"
		| "resume"
		| "continue"
		| "session"
		| "fork"
	>;
	defaults?: (ctx: ExtensionContext) => Selection | undefined;
};

const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function parseSelection(raw: string | undefined): Selection | undefined {
	if (!raw) return undefined;
	const value: unknown = JSON.parse(raw);
	if (
		typeof value !== "object" ||
		value === null ||
		!("provider" in value) ||
		typeof value.provider !== "string" ||
		!value.provider ||
		!("model" in value) ||
		typeof value.model !== "string" ||
		!value.model ||
		!("thinking" in value) ||
		!levels.some((level) => level === value.thinking)
	) {
		throw new Error("Invalid saved accounts selection.");
	}
	return {
		provider: value.provider,
		model: value.model,
		thinking: value.thinking as ThinkingLevel,
	};
}

function defaultSelection(ctx: ExtensionContext): Selection | undefined {
	const settings = SettingsManager.create(ctx.cwd);
	const provider = settings.getDefaultProvider();
	const model = settings.getDefaultModel();
	if (!provider || !model) return undefined;
	return {
		provider,
		model,
		thinking:
			settings.getModelThinkingLevel(provider, model) ??
			settings.getDefaultThinkingLevel() ??
			"medium",
	};
}

// Register after accounts' session_start handler: auth restoration must finish first.
export function registerSelectionMemory(
	pi: ExtensionAPI,
	options: SelectionOptions = {},
): void {
	const storage =
		options.storage ??
		new FileAccountStorageBackend(
			join(getAgentDir(), "pi-accounts-selection.json"),
		);
	let restoring = false;
	let ready = false;
	const save = (
		ctx: ExtensionContext,
		model = ctx.model,
		thinking = pi.getThinkingLevel(),
	): void => {
		if (
			ctx.mode !== "tui" ||
			!ready ||
			restoring ||
			!model ||
			model.provider === "unknown"
		)
			return;
		try {
			storage.withLock(() => ({
				result: undefined,
				next: JSON.stringify({
					provider: model.provider,
					model: model.id,
					thinking,
				}),
			}));
		} catch {
			ctx.ui.notify(
				"Accounts could not save the last-used model selection.",
				"error",
			);
		}
	};
	pi.on("session_start", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		ready = false;
		restoring = true;
		try {
			const args =
				event.reason === "startup"
					? (options.args ?? parseArgs(process.argv.slice(2)))
					: {};
			const explicitModel =
				args.model !== undefined ||
				args.provider !== undefined ||
				args.models !== undefined;
			const branch = ctx.sessionManager.getBranch();
			const resumed =
				args.resume ||
				args.continue ||
				args.session !== undefined ||
				args.fork !== undefined ||
				event.reason === "resume" ||
				event.reason === "fork" ||
				event.reason === "reload" ||
				branch.some((entry) => entry.type === "message");
			const missingModel = !ctx.model || ctx.model.provider === "unknown";
			let target: Selection | undefined;
			if (explicitModel) {
				// Pi owns CLI model resolution, including patterns and thinking suffixes.
				if (missingModel) throw new Error("Explicit model unavailable.");
			} else if (resumed) {
				if (event.reason !== "reload") {
					const saved = buildSessionContext(branch);
					const thinking = levels.find(
						(level) => level === saved.thinkingLevel,
					);
					if (saved.model && thinking)
						target = {
							provider: saved.model.provider,
							model: saved.model.modelId,
							thinking,
						};
				}
			} else {
				target = storage.read(parseSelection);
				if (!target && missingModel)
					target = (options.defaults ?? defaultSelection)(ctx);
			}
			if (target) {
				const model = ctx.modelRegistry
					.getAvailable()
					.find(
						(model) =>
							model.provider === target.provider && model.id === target.model,
					);
				if (!model || !(await pi.setModel(model)))
					throw new Error("Saved model unavailable.");
				pi.setThinkingLevel(args.thinking ?? target.thinking);
				if (
					ctx.model?.provider !== target.provider ||
					ctx.model?.id !== target.model
				)
					throw new Error("Restored model does not match the active model.");
				ctx.ui.notify(
					`Restored ${ctx.model.provider}/${ctx.model.id} with ${pi.getThinkingLevel()} reasoning.`,
					"info",
				);
			}
			ready = true;
		} catch {
			const active = ctx.model;
			ctx.ui.notify(
				active && active.provider !== "unknown"
					? `Could not restore the saved model. Using ${active.provider}/${active.id} with ${pi.getThinkingLevel()} reasoning instead. Change it with /model.`
					: "Could not restore the saved model. No active model is available. Choose an account with /accounts and a model with /model.",
				active && active.provider !== "unknown" ? "warning" : "error",
			);
		} finally {
			restoring = false;
		}
		// Do not replace remembered settings merely by resuming an old session.
	});
	pi.on("model_select", (event, ctx) => {
		if (restoring || event.source === "restore") return;
		ready = true;
		save(ctx, event.model);
	});
	pi.on("thinking_level_select", (event, ctx) =>
		save(ctx, ctx.model, event.level),
	);
	pi.on("before_agent_start", (_event, ctx) => save(ctx));
}
