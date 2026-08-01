import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ROLE_NAMES } from "./roles.js";
import type { AgentOverride, CustomAgentConfig, RoleName } from "./types.js";

export const CONFIG_FILENAME = "pi-delegated-agents.json";

export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ENTRY_FIELDS = new Set([
	"role",
	"description",
	"prompt",
	"model",
	"thinking",
]);
const OVERRIDE_FIELDS = new Set(["model", "thinking", "disabled"]);
const ROLE_SET = new Set<string>(ROLE_NAMES);
export const THINKING_LEVELS = [
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
	overrides?: Record<string, AgentOverride>;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setOwn<T>(record: Record<string, T>, name: string, value: T): void {
	Object.defineProperty(record, name, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
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
		if (field !== "agents" && field !== "overrides")
			invalid(sourcePath, field, "unknown field");
	}
	if (!("agents" in value) || !record(value["agents"])) {
		invalid(sourcePath, "agents", "expected object");
	}

	const agents: Record<string, CustomAgentConfig> = {};
	for (const [name, raw] of Object.entries(value["agents"])) {
		const base = `agents.${name}`;
		if (!AGENT_NAME_PATTERN.test(name)) {
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

		setOwn(agents, name, {
			role: raw["role"] as RoleName,
			description,
			prompt,
			...(model ? { model } : {}),
			...(raw["thinking"]
				? { thinking: raw["thinking"] as ModelThinkingLevel }
				: {}),
		});
	}

	let overrides: Record<string, AgentOverride> | undefined;
	if ("overrides" in value) {
		if (!record(value["overrides"]))
			invalid(sourcePath, "overrides", "expected object");
		overrides = {};
		for (const [name, raw] of Object.entries(value["overrides"])) {
			const base = `overrides.${name}`;
			if (!ROLE_SET.has(name) && !Object.hasOwn(agents, name))
				invalid(sourcePath, base, "expected an existing agent name");
			if (!record(raw)) invalid(sourcePath, base, "expected object");
			for (const field of Object.keys(raw)) {
				if (!OVERRIDE_FIELDS.has(field))
					invalid(sourcePath, `${base}.${field}`, "unknown field");
			}
			const model =
				raw["model"] === undefined
					? undefined
					: requiredString(raw["model"], sourcePath, `${base}.model`);
			const thinking = raw["thinking"];
			if (
				thinking !== undefined &&
				(typeof thinking !== "string" || !THINKING_SET.has(thinking))
			)
				invalid(
					sourcePath,
					`${base}.thinking`,
					`expected ${THINKING_LEVELS.join("|")}`,
				);
			const disabled = raw["disabled"];
			if (disabled !== undefined && typeof disabled !== "boolean")
				invalid(sourcePath, `${base}.disabled`, "expected boolean");
			if (!model && thinking === undefined && disabled === undefined)
				invalid(sourcePath, base, "expected model, thinking, and/or disabled");
			setOwn(overrides, name, {
				...(model ? { model } : {}),
				...(thinking ? { thinking: thinking as ModelThinkingLevel } : {}),
				...(disabled !== undefined ? { disabled } : {}),
			});
		}
	}
	return { ...(overrides ? { overrides } : {}), agents };
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

export function loadCustomAgentConfig(
	configPath: string = getCustomAgentConfigPath(),
): CustomAgentsConfig {
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

export function writeCustomAgentConfig(
	config: CustomAgentsConfig,
	configPath: string = getCustomAgentConfigPath(),
): void {
	const normalized = parseCustomAgentConfig(config, configPath);
	const sorted: CustomAgentsConfig = {
		...(normalized.overrides
			? {
					overrides: Object.fromEntries(
						Object.entries(normalized.overrides).sort(([left], [right]) =>
							left.localeCompare(right),
						),
					) as Record<string, AgentOverride>,
				}
			: {}),
		agents: Object.fromEntries(
			Object.entries(normalized.agents).sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
	};
	const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(temporaryPath, `${JSON.stringify(sorted, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(temporaryPath, configPath);
	} catch (error) {
		try {
			rmSync(temporaryPath, { force: true });
		} catch {
			// Preserve the original write error.
		}
		throw error;
	}
}
