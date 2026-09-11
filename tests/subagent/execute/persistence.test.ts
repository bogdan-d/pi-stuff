import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Conversation } from "../../../extensions/subagent/conversation.js";
import {
	DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
	executeGeneration,
} from "../../../extensions/subagent/execute.js";
import { normalizeSettings } from "../../../extensions/subagent/settings.js";

test("session saving is opt-in and rejects non-boolean settings", () => {
	expect(normalizeSettings({}).settings.runtime.saveSessions).toBe(false);
	expect(
		normalizeSettings({ runtime: { saveSessions: true } }).settings.runtime
			.saveSessions,
	).toBe(true);
	const invalid = normalizeSettings({ runtime: { saveSessions: "true" } });
	expect(invalid.settings.runtime.saveSessions).toBe(false);
	expect(invalid.warning).toContain("saveSessions");
});

test.each([false, true])(
	"saving %s keeps one native session through follow-ups",
	async (saveSessions) => {
		const dir = await mkdtemp(join(tmpdir(), "subagent-persistence-"));
		const agent = new Conversation(
			"amber-acorn" as any,
			{
				name: "worker",
				description: "",
				systemPrompt: "",
				source: "project",
			} as any,
			{ kind: "spawn", agent: "worker", label: "work", prompt: "first" },
			() => {},
			{
				saveSessions,
				rootSessionId: "root-session",
			},
		);
		let manager!: SessionManager;
		let creations = 0;
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			stopReason: "stop",
		} as any;
		const dependencies = {
			...DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
			getAgentDir: () => dir,
			ResourceLoader: class {
				async reload() {}
			} as any,
			settingsManager: () => SettingsManager.inMemory(),
			loadExtensionPaths: async () => [],
			createAgentSession: async (options: any) => {
				creations++;
				manager = options.sessionManager;
				return {
					session: {
						sessionManager: manager,
						messages: [assistant],
						bindExtensions: async () => {},
						subscribe: () => () => {},
						prompt: async (prompt: string) => {
							manager.appendMessage({
								role: "user",
								content: prompt,
								timestamp: Date.now(),
							});
							manager.appendMessage(assistant);
						},
					},
				} as any;
			},
		};
		await executeGeneration(
			{ cwd: dir } as any,
			agent,
			agent.latestGeneration,
			undefined,
			dependencies,
		);
		const file = agent.snapshot().sessionFile;
		expect(Boolean(file)).toBe(saveSessions);
		agent.markCollected(agent.latestGeneration, "model");
		await executeGeneration(
			{} as any,
			agent,
			agent.beginResume("follow-up"),
			undefined,
			dependencies,
		);
		expect(creations).toBe(1);
		expect(agent.snapshot().sessionFile).toBe(file);
		if (file) {
			expect(
				file.startsWith(join(dir, "subagent", "sessions", "root-session")),
			).toBe(true);
			expect(await readFile(file, "utf8")).toContain("follow-up");
			const reopened = SessionManager.open(file);
			expect(reopened.buildSessionContext().messages).toHaveLength(4);
		} else {
			expect(manager.getSessionFile()).toBeUndefined();
		}
	},
);
