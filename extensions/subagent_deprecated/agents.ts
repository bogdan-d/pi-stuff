import { type CustomAgentsConfig, loadCustomAgentConfig } from "./config.js";
import { ROLE_NAMES, ROLES } from "./roles.js";
import type { AgentCatalog, AgentSpec } from "./types.js";

export function createAgentCatalog(config: CustomAgentsConfig): AgentCatalog {
	const catalog = new Map<string, AgentSpec>();
	for (const role of ROLE_NAMES) {
		const spec = ROLES[role];
		const override = config.overrides?.[role];
		const model = override?.model ?? spec.model;
		const thinking = override?.thinking ?? spec.thinking;
		catalog.set(role, {
			name: role,
			role,
			description: spec.description,
			rolePromptPath: spec.promptPath,
			...(model ? { model } : {}),
			...(thinking ? { thinking } : {}),
			disabled: override?.disabled ?? false,
			source: "builtin",
		});
	}

	for (const name of Object.keys(config.agents).sort()) {
		const custom = config.agents[name];
		if (!custom) continue;
		const role = ROLES[custom.role];
		const override = config.overrides?.[name];
		const model = override?.model ?? custom.model ?? role.model;
		const thinking = override?.thinking ?? custom.thinking ?? role.thinking;
		catalog.set(name, {
			name,
			role: custom.role,
			description: custom.description,
			rolePromptPath: role.promptPath,
			specializationPrompt: custom.prompt,
			...(model ? { model } : {}),
			...(thinking ? { thinking } : {}),
			disabled: override?.disabled ?? false,
			source: "config",
		});
	}
	return catalog;
}

export function loadAgentCatalog(): AgentCatalog {
	return createAgentCatalog(loadCustomAgentConfig());
}

export function getAgentNames(catalog: AgentCatalog): string[] {
	return [...catalog.keys()];
}

export function getEnabledAgentCatalog(catalog: AgentCatalog): AgentCatalog {
	return new Map([...catalog].filter(([, spec]) => !spec.disabled));
}

export function formatAgentCatalog(catalog: AgentCatalog): string {
	return [...catalog.values()]
		.map((spec) => `${spec.name} (${spec.role}): ${spec.description}`)
		.join("\n");
}
