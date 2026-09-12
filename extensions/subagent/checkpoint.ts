import { readFileSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CURRENT_SESSION_VERSION,
	parseSessionEntries,
	type SessionEntry,
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
	sessionId: Type.Optional(Type.String({ minLength: 1 })),
	definition: Type.Object({
		...execution,
		name: Type.String(),
		description: Type.String(),
		systemPrompt: Type.String(),
		source: StringEnum(["user", "project", "builtin"] as const),
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

const sessionHeader = Type.Object({
	type: Type.Literal("session"),
	version: Type.Integer({ minimum: 2, maximum: CURRENT_SESSION_VERSION }),
	id: Type.String({ minLength: 1 }),
	cwd: Type.String(),
	timestamp: Type.String(),
});
const entryBase = Type.Object({
	type: Type.String({ minLength: 1 }),
	id: Type.String({ minLength: 1 }),
	parentId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
	timestamp: Type.String(),
});

/** Inspect without SessionManager.open(), which can create or rewrite a missing/damaged file. */
export function readSavedSession(
	file: string,
	expectedSessionId: string | undefined,
): SessionManager {
	// Older checkpoints cannot establish file identity. Never adopt the ID from the file being checked.
	if (!expectedSessionId)
		throw new Error(
			"Saved checkpoint has no child session ID. Open the file standalone instead.",
		);
	const content = readFileSync(file, "utf8");
	const raw: unknown[] = content
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
	const header = raw[0];
	if (!Value.Check(sessionHeader, header))
		throw new Error("Invalid Pi session header.");
	if (header.id !== expectedSessionId)
		throw new Error("Saved child session ID does not match the session file.");
	const ids = new Set<string>();
	for (const entry of raw.slice(1)) {
		if (!Value.Check(entryBase, entry) || entry.type === "session")
			throw new Error("Invalid Pi session entry.");
		if (ids.has(entry.id))
			throw new Error(`Duplicate session entry ID: ${entry.id}.`);
		if (entry.parentId !== null && !ids.has(entry.parentId))
			throw new Error(`Invalid parent for session entry ${entry.id}.`);
		ids.add(entry.id);
	}
	if (!ids.size) throw new Error("Saved session has no entries.");
	const entries = parseSessionEntries(content);
	const session = SessionManager.inMemory(
		header.cwd,
		{ id: header.id },
		entries,
	);
	if (!session.buildSessionContext().messages.length)
		throw new Error("Saved session has no conversation history.");
	return session;
}

/** Equal boundaries are valid when a generation did not append any entries. */
export function generationEntryOffsets(
	entries: readonly Pick<SessionEntry, "id">[],
	generations: readonly { entryStart: string | null }[],
): number[] {
	const positions = new Map(
		entries.map((entry, index) => [entry.id, index + 1]),
	);
	let previous = 0;
	return generations.map(({ entryStart }) => {
		const offset = entryStart === null ? 0 : positions.get(entryStart);
		if (offset === undefined)
			throw new Error(`Missing generation boundary: ${entryStart}.`);
		if (offset < previous)
			throw new Error("Generation boundaries are out of order.");
		previous = offset;
		return offset;
	});
}
