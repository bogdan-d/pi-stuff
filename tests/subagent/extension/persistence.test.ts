import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	CHECKPOINT_TYPE,
	parseCheckpoint,
	readSavedSession,
} from "../../../extensions/subagent/checkpoint.js";
import { Conversation } from "../../../extensions/subagent/conversation.js";
import {
	DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
	executeGeneration,
} from "../../../extensions/subagent/execute.js";
import { registerSubagentPersistence } from "../../../extensions/subagent/persistence.js";
import { SubagentRuntime } from "../../../extensions/subagent/runtime.js";
import { createDefaultSubagentSettings } from "../../../extensions/subagent/settings.js";
import { eventually } from "../helpers/eventually.js";
import { ZERO_USAGE } from "../helpers/fake-agent.js";

const definition = {
	name: "worker",
	description: "worker",
	systemPrompt: "Preserved instructions",
	source: "project",
} as const;
const assistant = (text: string) =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	}) as any;

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "subagent-restore-"));
	const parent = SessionManager.create(dir, join(dir, "parents"));
	parent.appendMessage(assistant("parent"));
	const settings = createDefaultSubagentSettings();
	settings.runtime.saveSessions = true;
	settings.runtime.restoreSubagents = true;
	const allocated: Conversation[] = [];
	const sessions: SessionManager[] = [];
	const dependencies = {
		...DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
		getAgentDir: () => dir,
		ResourceLoader: class {
			async reload() {}
		} as any,
		settingsManager: () => SettingsManager.inMemory(),
		loadExtensionPaths: async () => [],
		createAgentSession: async (options: any) => {
			const manager: SessionManager = options.sessionManager;
			sessions.push(manager);
			const listeners = new Set<(event: any) => void>();
			const emit = (event: any) => {
				for (const listener of listeners) listener(event);
			};
			let finish: (() => void) | undefined;
			const message = (value: any) => {
				manager.appendMessage(value);
				emit({ type: "message_end", message: value });
			};
			return {
				session: {
					sessionManager: manager,
					get messages() {
						return manager.buildSessionContext().messages;
					},
					bindExtensions: async () => {},
					subscribe(listener: (event: any) => void) {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
					async prompt(prompt: string) {
						message({ role: "user", content: prompt, timestamp: Date.now() });
						const id = `call-${manager.getEntries().length}`;
						message({
							...assistant(""),
							content: [
								{
									type: "toolCall",
									id,
									name: "read",
									arguments: { path: `${prompt}.txt` },
								},
							],
							stopReason: "toolUse",
						});
						emit({
							type: "tool_execution_start",
							toolCallId: id,
							toolName: "read",
							args: { path: `${prompt}.txt` },
						});
						const content = [{ type: "text", text: `result for ${prompt}` }];
						message({
							role: "toolResult",
							toolCallId: id,
							toolName: "read",
							content,
							isError: false,
							timestamp: Date.now(),
						});
						emit({
							type: "tool_execution_end",
							toolCallId: id,
							toolName: "read",
							result: { content },
							isError: false,
						});
						if (prompt === "wait")
							await new Promise<void>((resolve) => {
								finish = resolve;
							});
						message(assistant(`answer ${prompt}`));
					},
					abort: async () => {
						finish?.();
					},
					dispose() {},
				},
			} as any;
		},
	};
	const createRuntime = () =>
		new SubagentRuntime(
			{ agents: new Map([["worker", definition]]) } as any,
			4,
			(ctx, agent, generation, signal) => {
				allocated.push(agent);
				return executeGeneration(ctx, agent, generation, signal, dependencies);
			},
			100,
			100,
			async () => [],
		);
	const attach = async (runtime: SubagentRuntime, session = parent) => {
		const handlers = new Map<string, Array<(...args: any[]) => any>>();
		const warnings: string[] = [];
		const ctx = {
			cwd: dir,
			sessionManager: session,
			hasUI: true,
			ui: { notify: (message: string) => warnings.push(message) },
		} as any;
		registerSubagentPersistence(
			{
				on(name: string, fn: (...args: any[]) => any) {
					handlers.set(name, [...(handlers.get(name) ?? []), fn]);
				},
				appendEntry: (type: string, data: unknown) =>
					session.appendCustomEntry(type, data),
			} as any,
			runtime,
			{ load: async () => ({ settings }) },
			() => {},
		);
		const emit = async (name: string) => {
			for (const fn of handlers.get(name) ?? []) await fn({}, ctx);
		};
		await emit("session_start");
		return {
			ctx,
			warnings,
			stop: async () => {
				await emit("session_shutdown");
				await runtime.shutdown();
			},
		};
	};
	return { dir, parent, settings, allocated, sessions, createRuntime, attach };
}

test("restores generations, receipts and full tool history, then lazily resumes the same file", async () => {
	const f = await fixture();
	const original = f.createRuntime();
	const first = await f.attach(original);
	const run = original.startTasks(first.ctx, [
		{ kind: "spawn", agent: "worker", label: "task", prompt: "first" },
	]);
	await run.completion;
	const id = original.listConversations()[0]!.conversationId;
	original.collectSubagentForUser(id);
	expect(original.conversation(id).resumeAllowed).toBe(false);
	const collected = original.bindSubagentJoin([id]);
	collected.markCollected("model");
	collected.release();
	await original.startTasks(first.ctx, [
		{ kind: "resume", subagentId: id, prompt: "second" },
	]).completion;
	const file = original.conversation(id).sessionFile!;
	await first.stop();
	const restored = f.createRuntime();
	const second = await f.attach(
		restored,
		SessionManager.open(f.parent.getSessionFile()!),
	);
	expect(f.sessions).toHaveLength(1);
	const snapshot = restored.conversation(id);
	expect(snapshot.generations.map((generation) => generation.prompt)).toEqual([
		"first",
		"second",
	]);
	expect(snapshot.generations[0]!.receipts).toEqual({
		user: true,
		model: true,
	});
	expect(snapshot.generations[1]!.receipts).toEqual({
		user: false,
		model: false,
	});
	const bodies = snapshot.generations.map((generation) =>
		generation.activity.transcript!.map((entry) => entry.body).join("\n"),
	);
	expect(bodies[0]).toContain("first.txt");
	expect(bodies[0]).not.toContain("second.txt");
	expect(bodies[1]).toContain("result for second");
	expect(snapshot.resumeAllowed).toBe(false);
	const join = restored.bindSubagentJoin([id]);
	join.markCollected("model");
	join.release();
	await restored.startTasks(second.ctx, [
		{ kind: "resume", subagentId: id, prompt: "third" },
	]).completion;
	expect(f.sessions).toHaveLength(2);
	expect(restored.conversation(id).sessionFile).toBe(file);
	expect(restored.conversation(id).generations[2]!.restored).toBeUndefined();
	expect(await readFile(file, "utf8")).toContain("answer third");
	expect(await restored.removeConversation(id)).toMatchObject({ ok: true });
	await second.stop();
	const empty = f.createRuntime();
	const third = await f.attach(
		empty,
		SessionManager.open(f.parent.getSessionFile()!),
	);
	expect(empty.listConversations()).toEqual([]);
	expect(await readFile(file, "utf8")).toContain("answer first");
	await third.stop();
});

test("shutdown restores active nested work as interrupted without restarting or writing late checkpoints", async () => {
	const f = await fixture();
	const runtime = f.createRuntime();
	const first = await f.attach(runtime);
	const run = runtime.startTasks(first.ctx, [
		{ kind: "spawn", agent: "worker", label: "parent", prompt: "wait" },
	]);
	await eventually(() => expect(f.allocated[0]?.status.kind).toBe("running"));
	const parent = f.allocated[0]!;
	const child = runtime.startTasks(
		first.ctx,
		[{ kind: "spawn", agent: "worker", label: "child", prompt: "wait" }],
		{ caller: { conversation: parent, generation: parent.latestGeneration } },
	);
	await eventually(() => expect(f.allocated[1]?.status.kind).toBe("running"));
	const entryCount = f.parent.getEntries().length;
	await first.stop();
	await run.completion;
	await child.completion;
	expect(f.parent.getEntries()).toHaveLength(entryCount);
	const restored = f.createRuntime();
	const updates: string[] = [];
	restored.onConversationUpdate((_conversation, kind) => updates.push(kind));
	const second = await f.attach(restored);
	expect(f.sessions).toHaveLength(2);
	const conversations = restored.listConversations();
	expect(conversations).toHaveLength(2);
	expect(conversations[1]!.parentConversationId).toBe(parent.conversationId);
	expect(conversations[1]!.spawnedInGeneration).toBe(1);
	for (const conversation of conversations)
		expect(conversation.generations[0]!.status).toMatchObject({
			kind: "done",
			outcome: "interrupted",
		});
	expect(updates).toEqual([]);
	const interrupted = f.parent
		.getEntries()
		.slice(entryCount)
		.map((entry) => parseCheckpoint(entry.data));
	expect(
		interrupted.map((checkpoint) => checkpoint.generations[0]!.status),
	).toEqual(
		conversations.map((conversation) => conversation.generations[0]!.status),
	);
	expect(interrupted).toHaveLength(2);
	await second.stop();
	const nextRuntime = f.createRuntime();
	const reopened = SessionManager.open(f.parent.getSessionFile()!);
	const beforeReopen = reopened.getEntries().length;
	const third = await f.attach(nextRuntime, reopened);
	expect(
		nextRuntime
			.listConversations()
			.map((conversation) => conversation.generations[0]!.status),
	).toEqual(
		conversations.map((conversation) => conversation.generations[0]!.status),
	);
	expect(reopened.getEntries()).toHaveLength(beforeReopen);
	await third.stop();
});

test.each(["identity", "boundary"])(
	"lazy resume revalidates %s after the modal restored the file",
	async (damage) => {
		const f = await fixture();
		const runtime = f.createRuntime();
		const first = await f.attach(runtime);
		await runtime.startTasks(first.ctx, [
			{ kind: "spawn", agent: "worker", label: "task", prompt: "first" },
		]).completion;
		const id = runtime.listConversations()[0]!.conversationId;
		const collected = runtime.bindSubagentJoin([id]);
		collected.markCollected("model");
		collected.release();
		const file = runtime.conversation(id).sessionFile!;
		await first.stop();
		const restored = f.createRuntime();
		const second = await f.attach(restored);
		expect(restored.conversation(id).resumeAllowed).toBe(true);
		const replacement =
			damage === "identity"
				? await readFile(f.parent.getSessionFile()!, "utf8")
				: `${(await readFile(file, "utf8")).trimEnd().split("\n").slice(0, -1).join("\n")}\n`;
		await writeFile(file, replacement);
		await restored.startTasks(second.ctx, [
			{ kind: "resume", subagentId: id, prompt: "must not run" },
		]).completion;
		expect(restored.conversation(id).generations.at(-1)!.status).toMatchObject({
			kind: "done",
			outcome: "error",
			error: expect.stringContaining(
				damage === "identity"
					? "does not match"
					: "Missing generation boundary",
			),
		});
		expect(f.sessions).toHaveLength(1);
		expect(await readFile(file, "utf8")).toBe(replacement);
		await second.stop();
	},
);

test("invalid boundaries and legacy identity remain visible as unavailable subagents", async () => {
	const f = await fixture();
	const original = f.createRuntime();
	const first = await f.attach(original);
	await original.startTasks(first.ctx, [
		{ kind: "spawn", agent: "worker", label: "task", prompt: "first" },
	]).completion;
	const checkpoint = f.allocated[0]!.checkpoint();
	await first.stop();
	for (const legacy of [false, true]) {
		const invalid = {
			...checkpoint,
			...(legacy
				? { sessionId: undefined }
				: {
						generations: checkpoint.generations.map((generation) => ({
							...generation,
							entryStart: "absent-boundary",
						})),
					}),
		};
		f.parent.appendCustomEntry(
			CHECKPOINT_TYPE,
			JSON.parse(JSON.stringify(invalid)),
		);
		const restored = f.createRuntime();
		const next = await f.attach(restored);
		const snapshot = restored.listConversations()[0]!;
		expect(snapshot.conversationId).toBe(checkpoint.conversationId);
		expect(snapshot.restorationError).toContain(
			legacy ? "no child session ID" : "Missing generation boundary",
		);
		expect(snapshot.resumeAllowed).toBe(false);
		await next.stop();
	}
});

test("queued follow-ups restore without taking the preceding generation's trace", async () => {
	const f = await fixture();
	const runtime = f.createRuntime();
	const original = await f.attach(runtime);
	await runtime.startTasks(original.ctx, [
		{ kind: "spawn", agent: "worker", label: "task", prompt: "first" },
	]).completion;
	const agent = f.allocated[0]!;
	agent.markCollected(agent.latestGeneration, "model");
	agent.beginResume("queued follow-up");
	const restored = Conversation.restore(
		parseCheckpoint(agent.checkpoint()),
		readSavedSession(
			agent.snapshot().sessionFile!,
			agent.checkpoint().sessionId,
		),
		undefined,
		() => {},
	);
	const generations = restored.snapshot().generations;
	expect(
		generations[0]!.activity.transcript!.map((entry) => entry.body).join("\n"),
	).toContain("result for first");
	expect(generations[1]!.activity.transcript).toEqual([]);
	expect(generations[1]!.status).toMatchObject({
		kind: "done",
		outcome: "interrupted",
	});
	agent.settle(agent.latestGeneration, "interrupted");
	await original.stop();
});

test("restore toggle and parent identity isolate saved subagents, damaged files remain untouched", async () => {
	const f = await fixture();
	const original = f.createRuntime();
	const first = await f.attach(original);
	await original.startTasks(first.ctx, [
		{ kind: "spawn", agent: "worker", label: "task", prompt: "first" },
	]).completion;
	const checkpoint = parseCheckpoint(
		f.parent
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom" && entry.customType === CHECKPOINT_TYPE,
			)
			.at(-1)!.data,
	);
	await first.stop();
	f.settings.runtime.restoreSubagents = false;
	const off = f.createRuntime();
	const disabled = await f.attach(off);
	expect(off.listConversations()).toHaveLength(0);
	await disabled.stop();
	f.settings.runtime.restoreSubagents = true;
	const fork = SessionManager.inMemory(f.dir);
	fork.appendCustomEntry(CHECKPOINT_TYPE, checkpoint);
	const forked = f.createRuntime();
	const other = await f.attach(forked, fork);
	expect(forked.listConversations()).toHaveLength(0);
	await other.stop();
	await writeFile(checkpoint.sessionFile!, "broken JSON");
	const damaged = f.createRuntime();
	const recovery = await f.attach(damaged);
	expect(damaged.listConversations()[0]!.restorationError).toContain(
		"Session unavailable",
	);
	expect(damaged.listConversations()[0]!.resumeAllowed).toBe(false);
	expect(await readFile(checkpoint.sessionFile!, "utf8")).toBe("broken JSON");
	expect(() =>
		readSavedSession(join(f.dir, "missing.jsonl"), checkpoint.sessionId),
	).toThrow();
	await expect(readFile(join(f.dir, "missing.jsonl"))).rejects.toThrow();
	expect(() =>
		parseCheckpoint({
			...checkpoint,
			generations: [{ ...checkpoint.generations[0], generation: 2 }],
		}),
	).toThrow();
	await recovery.stop();
});
