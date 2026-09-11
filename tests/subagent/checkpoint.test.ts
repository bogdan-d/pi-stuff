import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	generationEntryOffsets,
	readSavedSession,
} from "../../extensions/subagent/checkpoint.js";
import { ZERO_USAGE } from "./helpers/fake-agent.js";

async function savedSession() {
	const dir = await mkdtemp(join(tmpdir(), "subagent-checkpoint-"));
	const session = SessionManager.create(dir, dir);
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "saved answer" }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
	session.appendMessage(message);
	return { dir, session, file: session.getSessionFile()!, message };
}

test("saved session identity is independent of location and mismatches never modify the file", async () => {
	const { dir, session, file } = await savedSession();
	const moved = join(dir, "moved.jsonl");
	await copyFile(file, moved);
	expect(readSavedSession(moved, session.getSessionId()).getSessionId()).toBe(
		session.getSessionId(),
	);
	const before = await readFile(file, "utf8");
	expect(() => readSavedSession(file, "another-session")).toThrow(
		"does not match",
	);
	expect(() => readSavedSession(file, undefined)).toThrow(
		"no child session ID",
	);
	expect(await readFile(file, "utf8")).toBe(before);
});

test("malformed entries, duplicate IDs and broken parent chains are rejected without repair", async () => {
	const { session, file } = await savedSession();
	const original = await readFile(file, "utf8");
	const entry = session.getEntries()[0]!;
	const badEntries = [
		{},
		{ ...entry },
		{ ...entry, id: "missing-parent", parentId: "absent" },
		{ ...entry, id: "self-cycle", parentId: "self-cycle" },
		{ ...entry, id: "no-id", parentId: 1 },
		{ ...entry, id: "second-header", type: "session" },
	];
	for (const bad of badEntries) {
		const damaged = `${original}${JSON.stringify(bad)}\n`;
		await writeFile(file, damaged);
		expect(() => readSavedSession(file, session.getSessionId())).toThrow();
		expect(await readFile(file, "utf8")).toBe(damaged);
	}
	await writeFile(file, `${JSON.stringify(session.getHeader())}\n`);
	expect(() => readSavedSession(file, session.getSessionId())).toThrow(
		"no entries",
	);
});

test("native branches remain valid when parents are earlier entries rather than the previous line", async () => {
	const { session, file, message } = await savedSession();
	const root = session.getLeafId()!;
	session.appendMessage({
		role: "user",
		content: "old branch",
		timestamp: Date.now(),
	});
	session.branch(root);
	session.appendMessage({
		role: "user",
		content: "new branch",
		timestamp: Date.now(),
	});
	session.appendMessage(message);
	const restored = readSavedSession(file, session.getSessionId());
	expect(restored.getEntries()).toHaveLength(4);
	expect(JSON.stringify(restored.buildSessionContext().messages)).toContain(
		"new branch",
	);
	expect(JSON.stringify(restored.buildSessionContext().messages)).not.toContain(
		"old branch",
	);
});

test("generation boundaries reject missing or reversed IDs but preserve empty generations", () => {
	const entries = [{ id: "first" }, { id: "second" }, { id: "third" }];
	const boundaries = (ids: Array<string | null>) =>
		ids.map((entryStart) => ({ entryStart }));
	expect(
		generationEntryOffsets(
			entries,
			boundaries([null, "second", "second", "third"]),
		),
	).toEqual([0, 2, 2, 3]);
	expect(() =>
		generationEntryOffsets(entries, boundaries([null, "absent"])),
	).toThrow("Missing generation boundary");
	expect(() =>
		generationEntryOffsets(entries, boundaries(["third", "first"])),
	).toThrow("out of order");
	expect(() =>
		generationEntryOffsets(entries, boundaries(["first", null])),
	).toThrow("out of order");
});
