import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	AGENT_NAME_PATTERN,
	type CustomAgentsConfig,
	getCustomAgentConfigPath,
	loadCustomAgentConfig,
	THINKING_LEVELS,
	writeCustomAgentConfig,
} from "./config.js";
import { ROLE_NAMES } from "./roles.js";
import type { CustomAgentConfig, RoleName } from "./types.js";

const INHERIT = "inherit";

export interface AgentCommandContext {
	hasUI: boolean;
	ui: Pick<
		ExtensionUIContext,
		"confirm" | "editor" | "input" | "notify" | "select"
	>;
	reload(): Promise<void>;
}

async function requiredInput(
	ctx: AgentCommandContext,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	while (true) {
		const value = await ctx.ui.input(title, placeholder);
		if (value === undefined) return undefined;
		if (value.trim()) return value.trim();
		ctx.ui.notify("Value is required.", "warning");
	}
}

async function requiredEditor(
	ctx: AgentCommandContext,
	title: string,
	prefill = "",
): Promise<string | undefined> {
	while (true) {
		const value = await ctx.ui.editor(title, prefill);
		if (value === undefined) return undefined;
		if (value.trim()) return value.trim();
		ctx.ui.notify("Value is required.", "warning");
	}
}

async function optionalEditor(
	ctx: AgentCommandContext,
	title: string,
	prefill = "",
): Promise<{ cancelled: true } | { cancelled: false; value?: string }> {
	const value = await ctx.ui.editor(title, prefill);
	if (value === undefined) return { cancelled: true };
	const trimmed = value.trim();
	return trimmed ? { cancelled: false, value: trimmed } : { cancelled: false };
}

async function selectThinking(
	ctx: AgentCommandContext,
	current?: ModelThinkingLevel,
): Promise<
	{ cancelled: true } | { cancelled: false; value?: ModelThinkingLevel }
> {
	const selected = await ctx.ui.select("Thinking", [
		current ?? INHERIT,
		...[INHERIT, ...THINKING_LEVELS].filter(
			(value) => value !== (current ?? INHERIT),
		),
	]);
	if (selected === undefined) return { cancelled: true };
	return selected === INHERIT
		? { cancelled: false }
		: { cancelled: false, value: selected as ModelThinkingLevel };
}

async function promptAgent(
	ctx: AgentCommandContext,
	current?: CustomAgentConfig,
): Promise<CustomAgentConfig | undefined> {
	const role = await ctx.ui.select("Role", [
		...(current ? [current.role] : []),
		...ROLE_NAMES.filter((name) => name !== current?.role),
	]);
	if (role === undefined) return undefined;
	const description = await requiredEditor(
		ctx,
		"Description",
		current?.description,
	);
	if (description === undefined) return undefined;
	const prompt = await requiredEditor(
		ctx,
		"Specialization prompt",
		current?.prompt,
	);
	if (prompt === undefined) return undefined;
	const model = await optionalEditor(
		ctx,
		"Model (blank = inherit)",
		current?.model,
	);
	if (model.cancelled) return undefined;
	const thinking = await selectThinking(ctx, current?.thinking);
	if (thinking.cancelled) return undefined;

	return {
		role: role as RoleName,
		description,
		prompt,
		...(model.value ? { model: model.value } : {}),
		...(thinking.value ? { thinking: thinking.value } : {}),
	};
}

function formatAgent(name: string, agent: CustomAgentConfig): string {
	return [
		`Name: ${name}`,
		`Role: ${agent.role}`,
		`Description: ${agent.description}`,
		`Model: ${agent.model ?? INHERIT}`,
		`Thinking: ${agent.thinking ?? INHERIT}`,
		"",
		"Specialization prompt:",
		agent.prompt,
	].join("\n");
}

async function saveAndReload(
	ctx: AgentCommandContext,
	config: CustomAgentsConfig,
	configPath: string,
	message: string,
): Promise<void> {
	try {
		writeCustomAgentConfig(config, configPath);
	} catch (error) {
		ctx.ui.notify(
			`Failed to save ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}
	ctx.ui.notify(message, "info");
	try {
		await ctx.reload();
	} catch (error) {
		ctx.ui.notify(
			`Saved, but reload failed: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}

function loadForCommand(
	ctx: AgentCommandContext,
	configPath: string,
): CustomAgentsConfig | undefined {
	try {
		return loadCustomAgentConfig(configPath);
	} catch (error) {
		ctx.ui.notify(
			error instanceof Error ? error.message : String(error),
			"error",
		);
		return undefined;
	}
}

export async function runAgentAdd(
	ctx: AgentCommandContext,
	configPath: string = getCustomAgentConfigPath(),
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/agent-add requires interactive UI.", "error");
		return;
	}
	const config = loadForCommand(ctx, configPath);
	if (!config) return;

	let name: string | undefined;
	while (!name) {
		const candidate = await requiredInput(ctx, "Agent name", "lowercase-name");
		if (candidate === undefined) return;
		if (!AGENT_NAME_PATTERN.test(candidate)) {
			ctx.ui.notify("Name must match ^[a-z][a-z0-9-]{0,63}$.", "warning");
			continue;
		}
		if (
			ROLE_NAMES.includes(candidate as RoleName) ||
			config.agents[candidate]
		) {
			ctx.ui.notify(`Agent ${candidate} already exists.`, "warning");
			continue;
		}
		name = candidate;
	}

	const agent = await promptAgent(ctx);
	if (!agent) return;
	if (!(await ctx.ui.confirm("Add agent?", formatAgent(name, agent)))) return;
	await saveAndReload(
		ctx,
		{ agents: { ...config.agents, [name]: agent } },
		configPath,
		`Added agent ${name}.`,
	);
}

export async function runAgentEdit(
	ctx: AgentCommandContext,
	configPath: string = getCustomAgentConfigPath(),
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/agent-edit requires interactive UI.", "error");
		return;
	}
	const config = loadForCommand(ctx, configPath);
	if (!config) return;
	const names = Object.keys(config.agents).sort();
	if (names.length === 0) {
		ctx.ui.notify("No custom agents to edit.", "info");
		return;
	}
	const name = await ctx.ui.select("Agent to edit", names);
	if (name === undefined) return;
	const current = config.agents[name];
	if (!current) return;
	const agent = await promptAgent(ctx, current);
	if (!agent) return;
	if (!(await ctx.ui.confirm("Save agent?", formatAgent(name, agent)))) return;
	await saveAndReload(
		ctx,
		{ agents: { ...config.agents, [name]: agent } },
		configPath,
		`Updated agent ${name}.`,
	);
}

export async function runAgentRemove(
	ctx: AgentCommandContext,
	configPath: string = getCustomAgentConfigPath(),
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/agent-remove requires interactive UI.", "error");
		return;
	}
	const config = loadForCommand(ctx, configPath);
	if (!config) return;
	const names = Object.keys(config.agents).sort();
	if (names.length === 0) {
		ctx.ui.notify("No custom agents to remove.", "info");
		return;
	}
	const name = await ctx.ui.select("Agent to remove", names);
	if (name === undefined) return;
	const agent = config.agents[name];
	if (!agent) return;
	if (
		!(await ctx.ui.confirm("Remove agent?", `Remove ${name} (${agent.role})?`))
	)
		return;

	const agents = { ...config.agents };
	delete agents[name];
	await saveAndReload(ctx, { agents }, configPath, `Removed agent ${name}.`);
}

export function registerAgentCommands(pi: ExtensionAPI): void {
	const commands: Array<
		[
			name: string,
			description: string,
			run: (ctx: AgentCommandContext) => Promise<void>,
		]
	> = [
		["agent-add", "Add a custom delegated agent", runAgentAdd],
		["agent-edit", "Edit a custom delegated agent", runAgentEdit],
		["agent-remove", "Remove a custom delegated agent", runAgentRemove],
	];
	for (const [name, description, run] of commands) {
		pi.registerCommand(name, {
			description,
			handler: async (_args, ctx: ExtensionCommandContext) => run(ctx),
		});
	}
}
