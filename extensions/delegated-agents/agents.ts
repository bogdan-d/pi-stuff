import { type CustomAgentsConfig, loadCustomAgentConfig } from "./config.js";
import { ROLE_NAMES, ROLES } from "./roles.js";
import type { AgentCatalog, AgentSpec } from "./types.js";

export function createAgentCatalog(config: CustomAgentsConfig): AgentCatalog {
	const catalog = new Map<string, AgentSpec>();
	for (const role of ROLE_NAMES) {
		const spec = ROLES[role];
		catalog.set(role, {
			name: role,
			role,
			description: spec.description,
			rolePromptPath: spec.promptPath,
			source: "builtin",
		});
	}

	for (const name of Object.keys(config.agents).sort()) {
		const custom = config.agents[name];
		if (!custom) continue;
		catalog.set(name, {
			name,
			role: custom.role,
			description: custom.description,
			rolePromptPath: ROLES[custom.role].promptPath,
			specializationPrompt: custom.prompt,
			...(custom.model ? { model: custom.model } : {}),
			...(custom.thinking ? { thinking: custom.thinking } : {}),
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

export function formatAgentCatalog(catalog: AgentCatalog): string {
	return [...catalog.values()]
		.map((spec) => `${spec.name} (${spec.role}): ${spec.description}`)
		.join("\n");
}
