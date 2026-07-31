import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AgentCommandContext,
	registerAgentCommands,
	runAgentAdd,
	runAgentEdit,
	runAgentRemove,
} from "../extensions/delegated-agents/commands.js";
import {
	loadCustomAgentConfig,
	writeCustomAgentConfig,
} from "../extensions/delegated-agents/config.js";

const directories: string[] = [];

function configPath(): string {
	const directory = mkdtempSync(
		join(tmpdir(), "delegated-agent-command-test-"),
	);
	directories.push(directory);
	return join(directory, "pi-delegated-agents.json");
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

class FakeContext implements AgentCommandContext {
	hasUI = true;
	inputs: Array<string | undefined> = [];
	editors: Array<string | undefined> = [];
	selections: Array<string | undefined> = [];
	confirmations: boolean[] = [];
	notifications: Array<{ message: string; type?: string }> = [];
	reloads = 0;

	ui = {
		input: async () => this.inputs.shift(),
		editor: async () => this.editors.shift(),
		select: async () => this.selections.shift(),
		confirm: async () => this.confirmations.shift() ?? false,
		notify: (message: string, type?: "info" | "warning" | "error") => {
			this.notifications.push({ message, ...(type ? { type } : {}) });
		},
	};

	async reload(): Promise<void> {
		this.reloads++;
	}
}

describe("delegated agent commands", () => {
	test("adds a validated agent and reloads", async () => {
		const path = configPath();
		const ctx = new FakeContext();
		ctx.inputs.push("", "Bad_name", "rust-implementer");
		ctx.selections.push("implementation", "high");
		ctx.editors.push(
			"",
			"Implements Rust.",
			"Prefer idiomatic Rust.",
			"provider/model",
		);
		ctx.confirmations.push(true);

		await runAgentAdd(ctx, path);

		expect(loadCustomAgentConfig(path).agents["rust-implementer"]).toEqual({
			role: "implementation",
			description: "Implements Rust.",
			prompt: "Prefer idiomatic Rust.",
			model: "provider/model",
			thinking: "high",
		});
		expect(ctx.reloads).toBe(1);
		expect(ctx.notifications.map(({ message }) => message)).toContain(
			"Value is required.",
		);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("edits all fields and clears optional overrides", async () => {
		const path = configPath();
		writeCustomAgentConfig(
			{
				agents: {
					rust: {
						role: "implementation",
						description: "Old description",
						prompt: "Old prompt",
						model: "old/model",
						thinking: "high",
					},
				},
			},
			path,
		);
		const ctx = new FakeContext();
		ctx.selections.push("rust", "review", "inherit");
		ctx.editors.push("New description", "New prompt", "");
		ctx.confirmations.push(true);

		await runAgentEdit(ctx, path);

		expect(loadCustomAgentConfig(path).agents.rust).toEqual({
			role: "review",
			description: "New description",
			prompt: "New prompt",
		});
		expect(ctx.reloads).toBe(1);
	});

	test("removes the final agent but keeps an empty config", async () => {
		const path = configPath();
		writeCustomAgentConfig(
			{
				agents: {
					rust: {
						role: "implementation",
						description: "Rust",
						prompt: "Rust",
					},
				},
			},
			path,
		);
		const ctx = new FakeContext();
		ctx.selections.push("rust");
		ctx.confirmations.push(true);

		await runAgentRemove(ctx, path);

		expect(loadCustomAgentConfig(path)).toEqual({ agents: {} });
		expect(readFileSync(path, "utf8")).toContain('"agents": {}');
		expect(ctx.reloads).toBe(1);
	});

	test("escape discards edit draft without touching the file", async () => {
		const path = configPath();
		writeCustomAgentConfig(
			{
				agents: {
					rust: {
						role: "implementation",
						description: "Rust",
						prompt: "Rust",
					},
				},
			},
			path,
		);
		const before = readFileSync(path, "utf8");
		const ctx = new FakeContext();
		ctx.selections.push("rust", undefined);

		await runAgentEdit(ctx, path);

		expect(readFileSync(path, "utf8")).toBe(before);
		expect(ctx.reloads).toBe(0);
	});

	test("malformed config blocks changes", async () => {
		const path = configPath();
		writeFileSync(path, "{broken", "utf8");
		const ctx = new FakeContext();

		await runAgentAdd(ctx, path);

		expect(readFileSync(path, "utf8")).toBe("{broken");
		expect(ctx.notifications.at(-1)?.type).toBe("error");
		expect(ctx.reloads).toBe(0);
	});

	test("registers all three slash commands", () => {
		const names: string[] = [];
		registerAgentCommands({
			registerCommand: (name: string) => names.push(name),
		} as unknown as ExtensionAPI);
		expect(names).toEqual(["agent-add", "agent-edit", "agent-remove"]);
	});
});
