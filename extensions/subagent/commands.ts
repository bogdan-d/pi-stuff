import { readFileSync } from "node:fs";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createAgentCatalog, getAgentNames } from "./agents.js";
import {
	AGENT_NAME_PATTERN,
	type CustomAgentsConfig,
	getCustomAgentConfigPath,
	loadCustomAgentConfig,
	THINKING_LEVELS,
	writeCustomAgentConfig,
} from "./config.js";
import { ROLE_NAMES, ROLES } from "./roles.js";
import type { AgentOverride, CustomAgentConfig, RoleName } from "./types.js";

const DEFAULT = "role/parent default";

export interface AgentCommandContext {
	hasUI: boolean;
	model:
		| Pick<NonNullable<ExtensionCommandContext["model"]>, "id" | "provider">
		| undefined;
	modelRegistry: Pick<ExtensionCommandContext["modelRegistry"], "getAvailable">;
	thinkingLevel?: ExtensionCommandContext["thinkingLevel"];
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

async function selectModel(
	ctx: AgentCommandContext,
	current?: string,
): Promise<{ cancelled: true } | { cancelled: false; value?: string }> {
	const choices = [
		DEFAULT,
		...(current ? [current] : []),
		...ctx.modelRegistry
			.getAvailable()
			.map((model) => `${model.provider}/${model.id}`)
			.sort(),
	].filter((value, index, values) => values.indexOf(value) === index);
	const selected = await ctx.ui.select("Model", choices);
	if (selected === undefined) return { cancelled: true };
	return selected === DEFAULT
		? { cancelled: false }
		: { cancelled: false, value: selected };
}

async function selectThinking(
	ctx: AgentCommandContext,
	current?: ModelThinkingLevel,
): Promise<
	{ cancelled: true } | { cancelled: false; value?: ModelThinkingLevel }
> {
	const selected = await ctx.ui.select("Thinking", [
		current ?? DEFAULT,
		...[DEFAULT, ...THINKING_LEVELS].filter(
			(value) => value !== (current ?? DEFAULT),
		),
	]);
	if (selected === undefined) return { cancelled: true };
	return selected === DEFAULT
		? { cancelled: false }
		: { cancelled: false, value: selected as ModelThinkingLevel };
}

async function promptAgent(
	ctx: AgentCommandContext,
	current?: CustomAgentConfig,
	blockedPrompt?: string,
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
	let prompt: string | undefined;
	while (prompt === undefined) {
		prompt = await requiredEditor(
			ctx,
			"Specialization prompt",
			current?.prompt,
		);
		if (prompt === undefined) return undefined;
		if (prompt === blockedPrompt) {
			ctx.ui.notify(
				"Modify the copied role prompt to avoid running it twice.",
				"warning",
			);
			prompt = undefined;
		}
	}
	const model = await selectModel(ctx, current?.model);
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

async function selectDisabled(
	ctx: AgentCommandContext,
	disabled = false,
): Promise<boolean | undefined> {
	const current = disabled ? "disabled" : "enabled";
	const selected = await ctx.ui.select("Status", [
		current,
		current === "enabled" ? "disabled" : "enabled",
	]);
	return selected === undefined ? undefined : selected === "disabled";
}

function withOverride(
	config: CustomAgentsConfig,
	name: string,
	override: AgentOverride,
): CustomAgentsConfig {
	const overrides = { ...config.overrides };
	if (Object.keys(override).length) overrides[name] = override;
	else delete overrides[name];
	return {
		...(Object.keys(overrides).length ? { overrides } : {}),
		agents: config.agents,
	};
}

function agentLabel(config: CustomAgentsConfig, name: string): string {
	return config.overrides?.[name]?.disabled ? `${name} [disabled]` : name;
}

async function selectAgent(
	ctx: AgentCommandContext,
	config: CustomAgentsConfig,
	title: string,
	names: string[],
): Promise<string | undefined> {
	const choices = new Map(
		names.map((name) => [agentLabel(config, name), name]),
	);
	const selected = await ctx.ui.select(title, [...choices.keys()]);
	return selected === undefined ? undefined : choices.get(selected);
}

async function uniqueAgentName(
	ctx: AgentCommandContext,
	config: CustomAgentsConfig,
): Promise<string | undefined> {
	while (true) {
		const candidate = await requiredInput(ctx, "Agent name", "lowercase-name");
		if (candidate === undefined) return undefined;
		if (!AGENT_NAME_PATTERN.test(candidate)) {
			ctx.ui.notify("Name must match ^[a-z][a-z0-9-]{0,63}$.", "warning");
			continue;
		}
		if (
			ROLE_NAMES.includes(candidate as RoleName) ||
			Object.hasOwn(config.agents, candidate)
		) {
			ctx.ui.notify(`Agent ${candidate} already exists.`, "warning");
			continue;
		}
		return candidate;
	}
}

function formatAgent(
	name: string,
	agent: CustomAgentConfig,
	disabled = false,
): string {
	return [
		`Name: ${name}`,
		`Role: ${agent.role}`,
		`Status: ${disabled ? "disabled" : "enabled"}`,
		`Description: ${agent.description}`,
		`Model: ${agent.model ?? DEFAULT}`,
		`Thinking: ${agent.thinking ?? DEFAULT}`,
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
		ctx.ui.notify("/subagent-add requires interactive UI.", "error");
		return;
	}
	const config = loadForCommand(ctx, configPath);
	if (!config) return;

	const name = await uniqueAgentName(ctx, config);
	if (!name) return;

	const agent = await promptAgent(ctx);
	if (!agent) return;
	if (!(await ctx.ui.confirm("Add agent?", formatAgent(name, agent)))) return;
	await saveAndReload(
		ctx,
		{ ...config, agents: { ...config.agents, [name]: agent } },
		configPath,
		`Added agent ${name}.`,
	);
}

export async function runAgentEdit(
	ctx: AgentCommandContext,
	configPath: string = getCustomAgentConfigPath(),
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/subagent-edit requires interactive UI.", "error");
		return;
	}
	const config = loadForCommand(ctx, configPath);
	if (!config) return;
	const names = Object.keys(config.agents).sort();
	if (names.length === 0) {
		ctx.ui.notify("No custom agents to edit.", "info");
		return;
	}
	const name = await selectAgent(ctx, config, "Agent to edit", names);
	if (name === undefined) return;
	const current = config.agents[name];
	if (!current) return;
	const agent = await promptAgent(ctx, current);
	if (!agent) return;
	const disabled = await selectDisabled(
		ctx,
		config.overrides?.[name]?.disabled,
	);
	if (disabled === undefined) return;
	if (
		!(await ctx.ui.confirm("Save agent?", formatAgent(name, agent, disabled)))
	)
		return;
	const edited = withOverride(config, name, disabled ? { disabled: true } : {});
	await saveAndReload(
		ctx,
		{ ...edited, agents: { ...config.agents, [name]: agent } },
		configPath,
		`Updated agent ${name}.`,
	);
}

export async function runAgentRemove(
	ctx: AgentCommandContext,
	configPath: string = getCustomAgentConfigPath(),
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/subagent-remove requires interactive UI.", "error");
		return;
	}
	const config = loadForCommand(ctx, configPath);
	if (!config) return;
	const names = Object.keys(config.agents).sort();
	if (names.length === 0) {
		ctx.ui.notify("No custom agents to remove.", "info");
		return;
	}
	const name = await selectAgent(ctx, config, "Agent to remove", names);
	if (name === undefined) return;
	const agent = config.agents[name];
	if (!agent) return;
	if (
		!(await ctx.ui.confirm("Remove agent?", `Remove ${name} (${agent.role})?`))
	)
		return;

	const agents = { ...config.agents };
	delete agents[name];
	const cleaned = withOverride(config, name, {});
	await saveAndReload(
		ctx,
		{ ...cleaned, agents },
		configPath,
		`Removed agent ${name}.`,
	);
}

export async function runAgentOverride(
	ctx: AgentCommandContext,
	configPath: string = getCustomAgentConfigPath(),
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/subagent-override requires interactive UI.", "error");
		return;
	}
	const config = loadForCommand(ctx, configPath);
	if (!config) return;
	const name = await selectAgent(
		ctx,
		config,
		"Agent to override",
		getAgentNames(createAgentCatalog(config)),
	);
	if (name === undefined) return;
	const current = config.overrides?.[name];
	const model = await selectModel(ctx, current?.model);
	if (model.cancelled) return;
	const thinking = await selectThinking(ctx, current?.thinking);
	if (thinking.cancelled) return;
	const disabled = await selectDisabled(ctx, current?.disabled);
	if (disabled === undefined) return;
	const override: AgentOverride = {
		...(model.value ? { model: model.value } : {}),
		...(thinking.value ? { thinking: thinking.value } : {}),
		...(disabled ? { disabled: true } : {}),
	};
	if (
		!(await ctx.ui.confirm(
			"Save override?",
			`Agent: ${name}\nModel: ${override.model ?? DEFAULT}\nThinking: ${override.thinking ?? DEFAULT}\nStatus: ${disabled ? "disabled" : "enabled"}`,
		))
	)
		return;
	await saveAndReload(
		ctx,
		withOverride(config, name, override),
		configPath,
		`Updated override for ${name}.`,
	);
}

export async function runAgentClone(
	ctx: AgentCommandContext,
	configPath: string = getCustomAgentConfigPath(),
	readPrompt: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/subagent-clone requires interactive UI.", "error");
		return;
	}
	const config = loadForCommand(ctx, configPath);
	if (!config) return;
	const sourceName = await selectAgent(
		ctx,
		config,
		"Agent to clone",
		getAgentNames(createAgentCatalog(config)),
	);
	if (sourceName === undefined) return;
	const name = await uniqueAgentName(ctx, config);
	if (!name) return;
	const custom = config.agents[sourceName];
	const roleName = ROLE_NAMES.includes(sourceName as RoleName)
		? (sourceName as RoleName)
		: custom?.role;
	if (!roleName) return;
	const role = ROLES[roleName];
	let copiedRolePrompt: string | undefined;
	if (!custom) {
		try {
			copiedRolePrompt = readPrompt(role.promptPath).trim();
		} catch (error) {
			ctx.ui.notify(
				`Failed to read ${role.promptPath}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
	}
	const source: CustomAgentConfig = custom
		? { ...custom }
		: {
				role: roleName,
				description: role.description,
				prompt: copiedRolePrompt!,
				...(role.model ? { model: role.model } : {}),
				...(role.thinking ? { thinking: role.thinking } : {}),
			};
	const agent = await promptAgent(ctx, source, copiedRolePrompt);
	if (!agent) return;
	if (!(await ctx.ui.confirm("Clone agent?", formatAgent(name, agent)))) return;
	await saveAndReload(
		ctx,
		{ ...config, agents: { ...config.agents, [name]: agent } },
		configPath,
		`Cloned ${sourceName} as ${name}.`,
	);
}

export async function runAgentList(
	ctx: AgentCommandContext,
	configPath: string = getCustomAgentConfigPath(),
): Promise<void> {
	const config = loadForCommand(ctx, configPath);
	if (!config) return;
	const parentModel = ctx.model
		? `${ctx.model.provider}/${ctx.model.id}`
		: "not selected";
	const parentThinking = ctx.thinkingLevel ?? "not set";
	const entries = [...createAgentCatalog(config).values()].map((agent) =>
		[
			agentLabel(config, agent.name),
			`  Role:      ${agent.role}`,
			`  Model:     ${agent.model ?? parentModel}`,
			`  Thinking:  ${agent.thinking ?? parentThinking}`,
			"  Description:",
			...agent.description.split("\n").map((line) => `    ${line}`),
		].join("\n"),
	);
	ctx.ui.notify(entries.join("\n\n"), "info");
}

export function registerAgentCommands(pi: ExtensionAPI): void {
	const commands: Array<
		[
			name: string,
			description: string,
			run: (ctx: AgentCommandContext) => Promise<void>,
		]
	> = [
		["subagent-list", "List all subagents", runAgentList],
		["subagent-add", "Add a custom subagent", runAgentAdd],
		["subagent-edit", "Edit a custom subagent", runAgentEdit],
		["subagent-remove", "Remove a custom subagent", runAgentRemove],
		["subagent-override", "Override any subagent", runAgentOverride],
		["subagent-clone", "Clone any subagent", runAgentClone],
	];
	for (const [name, description, run] of commands) {
		pi.registerCommand(name, {
			description,
			handler: async (_args, ctx: ExtensionCommandContext) => run(ctx),
		});
	}
}
