import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SpawnRequest } from "./schema.js";
import {
	DEFAULT_SUBAGENT_SETTINGS,
	type SubagentAgentDiscoverySettings,
} from "./settings.js";

export const MODEL_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export function isModelThinkingLevel(
	value: unknown,
): value is ModelThinkingLevel {
	return (
		typeof value === "string" &&
		(MODEL_THINKING_LEVELS as readonly string[]).includes(value)
	);
}

export type AgentSource = "user" | "project" | "builtin";

export interface AgentDefinition {
	name: string;
	description: string;
	model?: string;
	thinking?: ModelThinkingLevel;
	tools?: string[];
	skills?: string[];
	systemPrompt: string;
	source: AgentSource;
	sourcePath?: string;
}

export const DEFAULT_AGENT: AgentDefinition = {
	name: "default",
	description:
		"Routine tasks that do not need a specialized role, and tasks with no matching specialist.",
	source: "builtin",
	systemPrompt:
		"Complete the delegated task using the available tools. You do not have the parent conversation; use the supplied prompt and filesystem for context. Follow the task's scope and constraints, preserve unrelated work, and report your findings or changes and any verification performed.",
};

export type AgentDefinitionSummary = Readonly<
	Pick<AgentDefinition, "name" | "description" | "source" | "sourcePath">
>;

export interface RequestedExecutionConfig {
	readonly model?: string;
	readonly thinking?: ModelThinkingLevel;
	readonly skills?: readonly string[];
	readonly tools?: readonly string[];
	readonly cwd?: string;
}

export interface EffectiveExecutionConfig {
	readonly model?: string;
	readonly thinking?: ModelThinkingLevel;
	readonly cwd: string;
	readonly skills: readonly string[];
	readonly tools: readonly string[];
}

export type ExecutionOverrides = Readonly<
	Pick<RequestedExecutionConfig, "model" | "thinking">
>;

export function buildAgentDefinition(
	content: string,
	source: AgentSource,
): AgentDefinition | { error: Error } {
	try {
		const { frontmatter, body } =
			parseFrontmatter<Record<string, unknown>>(content);
		const result: AgentDefinition = {
			name: parseRequiredString(frontmatter["name"], "name"),
			description: parseRequiredString(
				frontmatter["description"],
				"description",
			),
			systemPrompt: body.trim(),
			source,
		};
		const model = parseString(frontmatter["model"], "model");
		if (model !== undefined) result.model = model;
		const thinking = parseThinkingLevel(frontmatter["thinking"]);
		if (thinking !== undefined) result.thinking = thinking;
		const tools = parseCSVStrings(frontmatter["tools"], "tools");
		if (tools !== undefined) result.tools = tools;
		const skills = parseCSVStrings(frontmatter["skills"], "skills");
		if (skills !== undefined) result.skills = skills;

		return result;
	} catch (error) {
		return { error: error as Error };
	}
}

function parseString(val: unknown, field: string): string | undefined {
	if (val == null) return undefined;
	if (typeof val === "string") return val;
	throw new Error(
		`Expected field "${field}" to be a string, but got ${typeof val}.`,
	);
}

function parseRequiredString(val: unknown, field: string): string {
	const value = parseString(val, field);
	if (value === undefined || value.trim() === "") {
		throw new Error(
			`Expected required field "${field}" to be a non-empty string.`,
		);
	}
	return value;
}

function parseThinkingLevel(val: unknown): ModelThinkingLevel | undefined {
	const thinking = parseString(val, "thinking");
	if (thinking === undefined || isModelThinkingLevel(thinking)) return thinking;
	throw new Error(
		`Expected field "thinking" to be one of: ${MODEL_THINKING_LEVELS.join(", ")}.`,
	);
}

function parseCSVStrings(
	val: unknown,
	field: string,
): Array<string> | undefined {
	if (val == null) return undefined;
	if (typeof val != "string") {
		throw new Error(
			`Expected field "${field}" to be a string, but got ${typeof val}.`,
		);
	}

	const trimmed = val.trim();
	if (!trimmed || trimmed == "none") return undefined;

	const items = trimmed
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

	return items.length > 0 ? items : undefined;
}

export interface AgentRegistryOptions {
	discovery?: Partial<SubagentAgentDiscoverySettings>;
	onWarning?: (message: string) => void;
}

export class AgentRegistry {
	private _agents = new Map<string, AgentDefinition>();
	get agents(): Map<string, AgentDefinition> {
		return this._agents;
	}

	/**
	 * Load agent configs from the following directories:
	 *   - Project: <cwd>/.pi/agents/*.md
	 *   - Global:  <pi-dir>/agents/*.md
	 */
	async reload(
		cwd: string = process.cwd(),
		options: AgentRegistryOptions = {},
	): Promise<void> {
		const discovery = {
			...DEFAULT_SUBAGENT_SETTINGS.agentDiscovery,
			...options.discovery,
		};
		const globalDir = discovery.includeUserAgents
			? join(getAgentDir(), "agents")
			: undefined;
		const projectDir =
			discovery.includeProjectAgents &&
			discovery.projectAgentsStrategy !== "off"
				? nearestProjectAgentsDir(cwd)
				: undefined;
		const agents = new Map<string, AgentDefinition>();
		const extensions = new Set(discovery.agentFileExtensions);

		async function loadAgents(
			dir: string | undefined,
			source: AgentSource,
		): Promise<void> {
			if (!dir || !existsSync(dir)) {
				return;
			}
			const all = await readdir(dir);
			const files = all.filter((f) => extensions.has(extname(f)));

			for (const file of files) {
				const path = join(dir, file);
				let content: string;

				try {
					content = await readFile(path, { encoding: "utf-8" });
				} catch (error) {
					if (discovery.warnOnInvalidAgents)
						options.onWarning?.(
							`Failed to read subagent definition ${path}: ${error instanceof Error ? error.message : String(error)}`,
						);
					continue;
				}

				const result = buildAgentDefinition(content, source);
				if ("error" in result) {
					if (discovery.warnOnInvalidAgents)
						options.onWarning?.(
							`Invalid subagent definition ${path}: ${result.error.message}`,
						);
					continue;
				} else {
					agents.set(result.name, { ...result, sourcePath: path });
				}
			}
		}

		const loadOrder: Array<[string | undefined, AgentSource]> =
			discovery.duplicateNamePolicy === "userOverridesProject"
				? [
						[projectDir, "project"],
						[globalDir, "user"],
					]
				: [
						[globalDir, "user"],
						[projectDir, "project"],
					];
		for (const [dir, source] of loadOrder) await loadAgents(dir, source);
		this._agents = agents;
	}

	summarizeAgent(): string {
		return listAgentDefinitions(this)
			.map((agent) => `${agent.name} (${agent.source}) — ${agent.description}`)
			.join("\n");
	}
}

export function serializeAgentDefinition(config: AgentDefinition) {
	return {
		name: config.name,
		description: config.description,
		source: config.source,
		model: config.model,
		thinking: config.thinking,
		tools: config.tools,
		skills: config.skills,
		sourcePath: config.sourcePath,
	};
}

export function listAgentDefinitions(registry: AgentRegistry) {
	return [
		DEFAULT_AGENT,
		...Array.from(registry.agents.values()).filter(
			(agent) => agent.name !== DEFAULT_AGENT.name,
		),
	].map(serializeAgentDefinition);
}

function nearestProjectAgentsDir(cwd: string): string | undefined {
	let dir = cwd;
	while (true) {
		const candidate = join(dir, ".pi", "agents");
		if (statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) {
			return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function summarizeAgentDefinition(
	definition: AgentDefinition,
): AgentDefinitionSummary {
	return {
		name: definition.name,
		description: definition.description,
		source: definition.source,
		...(definition.sourcePath ? { sourcePath: definition.sourcePath } : {}),
	};
}

/** Resolve spawn-over-definition precedence. */
export function resolveRequestedConfig(
	config: AgentDefinition,
	spawn: SpawnRequest,
): RequestedExecutionConfig {
	const skills = spawn.skills ?? config.skills;
	const model = spawn.model ?? config.model;
	const thinking = spawn.thinking ?? config.thinking;
	return {
		...(model !== undefined ? { model } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		...(skills !== undefined ? { skills: [...skills] } : {}),
		...(config.tools !== undefined ? { tools: [...config.tools] } : {}),
		...(spawn.cwd !== undefined ? { cwd: spawn.cwd } : {}),
	};
}
