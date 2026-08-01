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
	runAgentClone,
	runAgentEdit,
	runAgentList,
	runAgentOverride,
	runAgentRemove,
} from "../extensions/delegated-agents/commands.js";
import {
	loadCustomAgentConfig,
	writeCustomAgentConfig,
} from "../extensions/delegated-agents/config.js";
import { ROLES } from "../extensions/delegated-agents/roles.js";

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
	model = { provider: "parent", id: "active" };
	modelRegistry = {
		getAvailable: () => [
			{ provider: "provider", id: "model" },
			{ provider: "definition", id: "model" },
		],
	};
	thinkingLevel = "medium" as const;
	inputs: Array<string | undefined> = [];
	editors: Array<string | undefined> = [];
	selections: Array<string | undefined> = [];
	confirmations: boolean[] = [];
	notifications: Array<{ message: string; type?: string }> = [];
	selectCalls: Array<{ title: string; options: string[] }> = [];
	reloads = 0;

	ui = {
		input: async () => this.inputs.shift(),
		editor: async () => this.editors.shift(),
		select: async (title: string, options: string[]) => {
			this.selectCalls.push({ title, options });
			return this.selections.shift();
		},
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
		ctx.selections.push("implementation", "provider/model", "high");
		ctx.editors.push("", "Implements Rust.", "Prefer idiomatic Rust.");
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
		expect(
			ctx.selectCalls.find(({ title }) => title === "Model")?.options,
		).toEqual(["role/parent default", "definition/model", "provider/model"]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("edits all fields and clears optional overrides", async () => {
		const path = configPath();
		writeCustomAgentConfig(
			{
				overrides: {
					planning: { thinking: "high" },
					"explore-deep": { model: "custom/deep", thinking: "medium" },
				},
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
		ctx.selections.push(
			"rust",
			"review",
			"role/parent default",
			"role/parent default",
			"enabled",
		);
		ctx.editors.push("New description", "New prompt");
		ctx.confirmations.push(true);

		await runAgentEdit(ctx, path);

		expect(loadCustomAgentConfig(path).agents.rust).toEqual({
			role: "review",
			description: "New description",
			prompt: "New prompt",
		});
		expect(loadCustomAgentConfig(path).overrides).toEqual({
			"explore-deep": { model: "custom/deep", thinking: "medium" },
			planning: { thinking: "high" },
		});
		const written = readFileSync(path, "utf8");
		expect(written.indexOf('"explore-deep"')).toBeLessThan(
			written.indexOf('"planning"'),
		);
		expect(ctx.reloads).toBe(1);
	});

	test("overrides and disables any agent", async () => {
		const path = configPath();
		writeCustomAgentConfig({ agents: {} }, path);
		const ctx = new FakeContext();
		ctx.selections.push(
			"planning",
			"role/parent default",
			"role/parent default",
			"disabled",
		);
		ctx.confirmations.push(true);

		await runAgentOverride(ctx, path);

		expect(loadCustomAgentConfig(path).overrides).toEqual({
			planning: { disabled: true },
		});
		expect(ctx.reloads).toBe(1);
	});

	test("custom edit clears runtime model and thinking overrides", async () => {
		const path = configPath();
		writeCustomAgentConfig(
			{
				overrides: {
					custom: { model: "override/model", thinking: "high", disabled: true },
				},
				agents: {
					custom: {
						role: "review",
						description: "Old",
						prompt: "Old",
					},
				},
			},
			path,
		);
		const ctx = new FakeContext();
		ctx.selections.push(
			"custom [disabled]",
			"review",
			"definition/model",
			"medium",
			"disabled",
		);
		ctx.editors.push("New", "New prompt");
		ctx.confirmations.push(true);

		await runAgentEdit(ctx, path);

		const config = loadCustomAgentConfig(path);
		expect(config.agents.custom).toMatchObject({
			model: "definition/model",
			thinking: "medium",
		});
		expect(config.overrides).toEqual({ custom: { disabled: true } });
	});

	test("clones explicit fields without source overrides", async () => {
		const path = configPath();
		writeCustomAgentConfig(
			{
				overrides: { source: { model: "override/model", disabled: true } },
				agents: {
					source: {
						role: "implementation",
						description: "Source",
						prompt: "Source prompt",
						model: "definition/model",
						thinking: "high",
					},
				},
			},
			path,
		);
		const ctx = new FakeContext();
		ctx.selections.push(
			"source [disabled]",
			"implementation",
			"definition/model",
			"high",
		);
		ctx.inputs.push("clone");
		ctx.editors.push("Source", "Source prompt");
		ctx.confirmations.push(true);

		await runAgentClone(ctx, path);

		expect(loadCustomAgentConfig(path).agents.clone).toEqual({
			role: "implementation",
			description: "Source",
			prompt: "Source prompt",
			model: "definition/model",
			thinking: "high",
		});
		expect(loadCustomAgentConfig(path).overrides?.clone).toBeUndefined();
	});

	test("requires changing a built-in role prompt before cloning", async () => {
		const path = configPath();
		writeCustomAgentConfig({ agents: {} }, path);
		const copiedPrompt = readFileSync(ROLES.review.promptPath, "utf8").trim();
		const ctx = new FakeContext();
		ctx.selections.push(
			"review",
			"review",
			"role/parent default",
			"role/parent default",
		);
		ctx.inputs.push("review-copy");
		ctx.editors.push(
			ROLES.review.description,
			copiedPrompt,
			"Focus on API compatibility.",
		);
		ctx.confirmations.push(true);

		await runAgentClone(ctx, path);

		expect(loadCustomAgentConfig(path).agents["review-copy"]?.prompt).toBe(
			"Focus on API compatibility.",
		);
		expect(ctx.notifications.map(({ message }) => message)).toContain(
			"Modify the copied role prompt to avoid running it twice.",
		);
	});

	test("reports built-in clone prompt read failures without saving", async () => {
		const path = configPath();
		writeCustomAgentConfig({ agents: {} }, path);
		const before = readFileSync(path, "utf8");
		const ctx = new FakeContext();
		ctx.selections.push("review");
		ctx.inputs.push("review-copy");

		await runAgentClone(ctx, path, () => {
			throw new Error("unreadable");
		});

		expect(readFileSync(path, "utf8")).toBe(before);
		expect(ctx.notifications.at(-1)).toMatchObject({
			message: expect.stringContaining("unreadable"),
			type: "error",
		});
		expect(ctx.reloads).toBe(0);
	});

	test("lists all agents and marks disabled entries", async () => {
		const path = configPath();
		writeCustomAgentConfig(
			{
				overrides: { planning: { disabled: true } },
				agents: {
					custom: {
						role: "review",
						description: "Custom reviewer.",
						prompt: "Review.",
					},
				},
			},
			path,
		);
		const ctx = new FakeContext();

		await runAgentList(ctx, path);

		const output = ctx.notifications.at(-1)?.message;
		expect(output).toContain(
			[
				"planning [disabled]",
				"  Role:      planning",
				"  Model:     parent/active",
				"  Thinking:  medium",
				"  Description:",
			].join("\n"),
		);
		expect(output).toContain(
			[
				"custom",
				"  Role:      review",
				"  Model:     parent/active",
				"  Thinking:  medium",
				"  Description:",
				"    Custom reviewer.",
			].join("\n"),
		);
		expect(output).toContain(
			"explore-shallow\n  Role:      explore-shallow\n  Model:     openai-codex/gpt-5.6-luna\n  Thinking:  low",
		);
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

	test("registers subagent slash commands without legacy aliases", () => {
		const names: string[] = [];
		registerAgentCommands({
			registerCommand: (name: string) => names.push(name),
		} as unknown as ExtensionAPI);
		expect(names).toEqual([
			"subagent-add",
			"subagent-edit",
			"subagent-remove",
			"subagent-override",
			"subagent-clone",
			"subagent-list",
		]);
	});
});
