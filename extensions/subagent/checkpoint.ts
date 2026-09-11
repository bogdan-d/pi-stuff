import { readFileSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	parseSessionEntries,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { MODEL_THINKING_LEVELS } from "./agents.js";
import { isConversationId } from "./identifiers.js";

const time = Type.Number({ minimum: 0 });
const number = Type.Integer({ minimum: 1 });
const strings = Type.Array(Type.String());
const execution = {
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(StringEnum(MODEL_THINKING_LEVELS)),
	skills: Type.Optional(strings),
	tools: Type.Optional(strings),
	cwd: Type.Optional(Type.String()),
};
const cost = Type.Object({
	input: time,
	output: time,
	cacheRead: time,
	cacheWrite: time,
	total: time,
});
const status = Type.Union([
	Type.Object({ kind: Type.Literal("queued"), queuedAt: time }),
	Type.Object({ kind: Type.Literal("running"), startedAt: time }),
	Type.Object({
		kind: Type.Literal("done"),
		outcome: StringEnum([
			"completed",
			"error",
			"aborted",
			"interrupted",
			"skipped",
		] as const),
		completedAt: time,
		startedAt: Type.Optional(time),
		output: Type.Optional(Type.String()),
		error: Type.Optional(Type.String()),
	}),
]);
const generation = Type.Object({
	generation: number,
	prompt: Type.String(),
	createdAt: time,
	initiatedBy: StringEnum(["user", "model"] as const),
	startedInParentGeneration: Type.Optional(number),
	entryStart: Type.Union([Type.String(), Type.Null()]),
	status,
	receipts: Type.Object({ user: Type.Boolean(), model: Type.Boolean() }),
	cost,
});
const checkpoint = Type.Object({
	version: Type.Literal(1),
	rootSessionId: Type.String(),
	conversationId: Type.String(),
	parentConversationId: Type.Optional(Type.String()),
	label: Type.String(),
	createdAt: time,
	saveSessions: Type.Boolean(),
	sessionFile: Type.Optional(Type.String()),
	definition: Type.Object({
		...execution,
		name: Type.String(),
		description: Type.String(),
		systemPrompt: Type.String(),
		source: StringEnum(["user", "project"] as const),
		sourcePath: Type.Optional(Type.String()),
	}),
	requestedConfig: Type.Object(execution),
	requestedOverrides: Type.Optional(
		Type.Object({ model: execution.model, thinking: execution.thinking }),
	),
	resolvedSkillBlocks: Type.Optional(strings),
	effectiveConfig: Type.Optional(
		Type.Object({
			...execution,
			cwd: Type.String(),
			skills: strings,
			tools: strings,
		}),
	),
	generations: Type.Array(generation, { minItems: 1 }),
});

export type ConversationCheckpoint = Static<typeof checkpoint>;
export const CHECKPOINT_TYPE = "subagent-conversation";

export function parseCheckpoint(data: unknown): ConversationCheckpoint {
	if (
		!Value.Check(checkpoint, data) ||
		!isConversationId(data.conversationId) ||
		(data.parentConversationId !== undefined &&
			!isConversationId(data.parentConversationId)) ||
		data.generations.some((item, index) => item.generation !== index + 1)
	)
		throw new Error("Invalid subagent conversation checkpoint.");
	return data;
}

/** Inspect without SessionManager.open(), which can create or rewrite a missing/damaged file. */
export function readSavedSession(file: string): SessionManager {
	const content = readFileSync(file, "utf8");
	for (const line of content.split("\n")) if (line.trim()) JSON.parse(line);
	const entries = parseSessionEntries(content);
	const header = entries[0];
	if (
		!header ||
		header.type !== "session" ||
		typeof header.cwd !== "string" ||
		typeof header.id !== "string"
	)
		throw new Error("Invalid Pi session header.");
	return SessionManager.inMemory(header.cwd, { id: header.id }, entries);
}
