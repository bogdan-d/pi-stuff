import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ROLE_NAMES } from "./roles.js";
import type { CustomAgentConfig, RoleName } from "./types.js";

export const CONFIG_FILENAME = "pi-delegated-agents.json";

const AGENT_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const ENTRY_FIELDS = new Set([
	"role",
	"description",
	"prompt",
	"model",
	"thinking",
]);
const ROLE_SET = new Set<string>(ROLE_NAMES);
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ModelThinkingLevel[];
const THINKING_SET = new Set<string>(THINKING_LEVELS);

export interface CustomAgentsConfig {
	agents: Record<string, CustomAgentConfig>;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(
	sourcePath: string,
	propertyPath: string,
	expected: string,
): never {
	throw new Error(`Invalid ${sourcePath} at ${propertyPath}: ${expected}`);
}

function requiredString(
	value: unknown,
	sourcePath: string,
	propertyPath: string,
): string {
	if (typeof value !== "string" || !value.trim()) {
		invalid(sourcePath, propertyPath, "expected non-empty string");
	}
	return value.trim();
}

export function parseCustomAgentConfig(
	value: unknown,
	sourcePath: string,
): CustomAgentsConfig {
	if (!record(value)) invalid(sourcePath, "$", "expected object");
	for (const field of Object.keys(value)) {
		if (field !== "agents") invalid(sourcePath, field, "unknown field");
	}
	if (!("agents" in value) || !record(value["agents"])) {
		invalid(sourcePath, "agents", "expected object");
	}

	const agents: Record<string, CustomAgentConfig> = {};
	for (const [name, raw] of Object.entries(value["agents"])) {
		const base = `agents.${name}`;
		if (!AGENT_NAME.test(name)) {
			invalid(sourcePath, base, "name must match ^[a-z][a-z0-9-]{0,63}$");
		}
		if (ROLE_SET.has(name)) {
			invalid(sourcePath, base, "name collides with a built-in agent");
		}
		if (!record(raw)) invalid(sourcePath, base, "expected object");
		for (const field of Object.keys(raw)) {
			if (!ENTRY_FIELDS.has(field)) {
				invalid(sourcePath, `${base}.${field}`, "unknown field");
			}
		}
		if (typeof raw["role"] !== "string" || !ROLE_SET.has(raw["role"])) {
			invalid(sourcePath, `${base}.role`, `expected ${ROLE_NAMES.join("|")}`);
		}
		const description = requiredString(
			raw["description"],
			sourcePath,
			`${base}.description`,
		);
		const prompt = requiredString(raw["prompt"], sourcePath, `${base}.prompt`);
		const model =
			raw["model"] === undefined
				? undefined
				: requiredString(raw["model"], sourcePath, `${base}.model`);
		if (
			raw["thinking"] !== undefined &&
			(typeof raw["thinking"] !== "string" ||
				!THINKING_SET.has(raw["thinking"]))
		) {
			invalid(
				sourcePath,
				`${base}.thinking`,
				`expected ${THINKING_LEVELS.join("|")}`,
			);
		}

		agents[name] = {
			role: raw["role"] as RoleName,
			description,
			prompt,
			...(model ? { model } : {}),
			...(raw["thinking"]
				? { thinking: raw["thinking"] as ModelThinkingLevel }
				: {}),
		};
	}
	return { agents };
}

export function getAgentDirectory(): string {
	return (
		process.env["PI_CODING_AGENT_DIR"]?.trim() ||
		join(homedir(), ".pi", "agent")
	);
}

export function getCustomAgentConfigPath(): string {
	return join(getAgentDirectory(), CONFIG_FILENAME);
}

export function loadCustomAgentConfig(): CustomAgentsConfig {
	const configPath = getCustomAgentConfigPath();
	let source: string;
	try {
		source = readFileSync(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { agents: {} };
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(source) as unknown;
	} catch (error) {
		throw new Error(
			`Invalid ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	return parseCustomAgentConfig(parsed, configPath);
}
