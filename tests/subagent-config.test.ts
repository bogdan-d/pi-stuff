import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	createAgentCatalog,
	getAgentNames,
	getEnabledAgentCatalog,
} from "../extensions/subagent/agents.js";
import { parseCustomAgentConfig } from "../extensions/subagent/config.js";
import {
	renderSubagentCall,
	renderSubagentResult,
} from "../extensions/subagent/render.js";
import { buildChildArgs } from "../extensions/subagent/runner.js";
import { createSubagentTool } from "../extensions/subagent/tool.js";

const source = "/tmp/pi-subagent.json";

function parse(agents: Record<string, unknown>) {
	return parseCustomAgentConfig({ agents }, source);
}

describe("subagent config", () => {
	test("parses valid agents and catalogs them deterministically", () => {
		const config = parse({
			"z-reviewer": {
				role: "review",
				description: " Reviews Rust. ",
				prompt: " Check ownership. ",
				thinking: "high",
			},
			"a-implementer": {
				role: "implementation",
				description: " Implements TypeScript. ",
				prompt: " Keep strict types. ",
				model: " provider/model ",
			},
		});

		expect(config.agents["a-implementer"]).toEqual({
			role: "implementation",
			description: "Implements TypeScript.",
			prompt: "Keep strict types.",
			model: "provider/model",
		});
		expect(config.agents["z-reviewer"]).not.toHaveProperty("model");
		expect(getAgentNames(createAgentCatalog(config))).toEqual([
			"explore-shallow",
			"explore-deep",
			"planning",
			"implementation",
			"verification",
			"review",
			"a-implementer",
			"z-reviewer",
		]);
	});

	test("accepts an empty agents object", () => {
		expect(parse({})).toEqual({ agents: {} });
	});

	test("publishes built-in and custom names in the tool schema", () => {
		const catalog = createAgentCatalog(
			parse({
				custom: {
					role: "review",
					description: "Reviews custom code.",
					prompt: "Check custom invariants.",
				},
			}),
		);
		const tool = createSubagentTool(catalog, {} as never);

		expect(tool.parameters.properties.agent.enum).toEqual([
			"explore-shallow",
			"explore-deep",
			"planning",
			"implementation",
			"verification",
			"review",
			"custom",
		]);
		expect(tool.description).toContain("custom (review): Reviews custom code.");
		expect(tool.parameters.properties).not.toHaveProperty("profile");
		expect(tool.parameters.properties).toHaveProperty("background");
		expect(tool.parameters.properties).toHaveProperty("allowConcurrentWrites");
		expect(tool.executionMode).toBe("parallel");
		expect(tool.promptGuidelines?.join("\n")).toContain("explore-shallow");
		expect(tool.promptGuidelines?.join("\n")).toContain("explore-deep");
		expect(tool.promptGuidelines?.join("\n")).not.toContain("explore_subagent");
	});

	test("applies built-in overrides and explore role defaults", () => {
		const config = parseCustomAgentConfig(
			{
				overrides: {
					planning: { model: "custom/planner" },
					"explore-deep": { thinking: "high" },
				},
				agents: {
					"domain-explorer": {
						role: "explore-deep",
						description: "Maps one domain.",
						prompt: "Focus on protocol boundaries.",
					},
				},
			},
			source,
		);
		const catalog = createAgentCatalog(config);

		expect(catalog.get("planning")).toMatchObject({
			model: "custom/planner",
		});
		expect(catalog.get("explore-shallow")).toMatchObject({
			model: "openai-codex/gpt-5.6-luna",
			thinking: "low",
		});
		expect(catalog.get("explore-deep")).toMatchObject({
			model: "openai-codex/gpt-5.6-terra",
			thinking: "high",
		});
		expect(catalog.get("domain-explorer")).toMatchObject({
			role: "explore-deep",
			model: "openai-codex/gpt-5.6-terra",
			thinking: "low",
		});
	});

	test("applies custom overrides and filters disabled agents", () => {
		const config = parseCustomAgentConfig(
			{
				overrides: {
					planning: { disabled: true },
					custom: { model: "override/model", disabled: false },
				},
				agents: {
					custom: {
						role: "review",
						description: "Custom reviewer.",
						prompt: "Review it.",
						model: "definition/model",
					},
				},
			},
			source,
		);
		const catalog = createAgentCatalog(config);

		expect(catalog.get("planning")?.disabled).toBe(true);
		expect(catalog.get("custom")).toMatchObject({
			model: "override/model",
			disabled: false,
		});
		expect(getAgentNames(getEnabledAgentCatalog(catalog))).not.toContain(
			"planning",
		);
	});

	test("supports disabling the entire subagent catalog", () => {
		const overrides = Object.fromEntries(
			[
				"planning",
				"implementation",
				"verification",
				"review",
				"explore-shallow",
				"explore-deep",
			].map((name) => [name, { disabled: true }]),
		);
		const catalog = createAgentCatalog(
			parseCustomAgentConfig({ agents: {}, overrides }, source),
		);

		expect(getEnabledAgentCatalog(catalog).size).toBe(0);
	});

	test("handles inherited-key agent names as own properties", () => {
		const config = parseCustomAgentConfig(
			JSON.parse(`{
				"agents": {
					"constructor": { "role": "review", "description": "A", "prompt": "A" }
				},
				"overrides": {
					"constructor": { "disabled": true }
				}
			}`),
			source,
		);

		expect(Object.hasOwn(config.agents, "constructor")).toBe(true);
		expect(Object.hasOwn(config.overrides!, "constructor")).toBe(true);
		expect(config.overrides?.constructor).toEqual({ disabled: true });
	});

	test("rejects prototype-key overrides without matching agents", () => {
		for (const name of ["constructor", "__proto__"]) {
			const value = JSON.parse(
				`{"agents":{},"overrides":{"${name}":{"disabled":true}}}`,
			);
			expect(() => parseCustomAgentConfig(value, source)).toThrow(
				"expected an existing agent name",
			);
		}
	});

	test.each([
		[{ overrides: [], agents: {} }, "overrides", "expected object"],
		[
			{ overrides: { unknown: { model: "x" } }, agents: {} },
			"overrides.unknown",
			"expected an existing agent name",
		],
		[
			{ overrides: { review: {} }, agents: {} },
			"overrides.review",
			"expected model, thinking, and/or disabled",
		],
		[
			{ overrides: { review: { model: undefined } }, agents: {} },
			"overrides.review",
			"expected model, thinking, and/or disabled",
		],
		[
			{ overrides: { review: { model: " " } }, agents: {} },
			"overrides.review.model",
			"non-empty string",
		],
		[
			{ overrides: { review: { thinking: "huge" } }, agents: {} },
			"overrides.review.thinking",
			"expected off|minimal|low|medium|high|xhigh|max",
		],
		[
			{ overrides: { review: { prompt: "replace" } }, agents: {} },
			"overrides.review.prompt",
			"unknown field",
		],
		[
			{ overrides: { review: { disabled: "yes" } }, agents: {} },
			"overrides.review.disabled",
			"expected boolean",
		],
	] as const)(
		"rejects invalid built-in overrides %#",
		(value, path, message) => {
			expect(() => parseCustomAgentConfig(value, source)).toThrow(path);
			expect(() => parseCustomAgentConfig(value, source)).toThrow(message);
		},
	);

	test("renders background launch as running work", () => {
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		const rendered = renderSubagentResult(
			{
				content: [],
				details: {
					mode: "background",
					id: "abc",
					status: "running",
					agent: "review",
					role: "review",
					task: "task",
					cwd: "/tmp",
					model: "model",
					createdAt: 1,
				},
			},
			{ expanded: true, isPartial: false },
			theme,
			"task",
		)
			.render(120)
			.join("\n");
		expect(rendered).toContain("Running");
		expect(rendered).not.toContain("Done");
		expect(rendered).toContain("subagent_result");
	});

	test("dispatches foreground ownership and detaches background ownership", async () => {
		const catalog = createAgentCatalog(parse({}));
		const foregroundCalls: any[] = [];
		const backgroundCalls: any[] = [];
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		};
		const manager = {
			async runForeground(options: any) {
				foregroundCalls.push(options);
				const details = {
					agent: "review",
					role: "review",
					task: "task",
					cwd: "/tmp",
					model: "provider/model",
					messages: [],
					stderr: "",
					usage,
				};
				return {
					id: "foreground",
					details,
					finalized: {
						output: "(no output)",
						failed: false,
						details: {
							agent: details.agent,
							role: details.role,
							cwd: details.cwd,
							model: details.model,
							usage,
							truncated: false,
						},
					},
				};
			},
			startBackground(options: any) {
				backgroundCalls.push(options);
				return {
					mode: "background",
					id: "abc",
					status: "running",
					agent: "review",
					role: "review",
					task: "task",
					cwd: "/tmp",
					model: "provider/model",
					createdAt: 1,
				};
			},
		};
		const tool = createSubagentTool(catalog, manager as never);
		const signal = new AbortController().signal;
		const onUpdate = () => {};
		const context = {
			cwd: "/tmp",
			model: { provider: "provider", id: "model" },
		} as any;
		await tool.execute(
			"call",
			{ agent: "review", task: "task" },
			signal,
			onUpdate,
			context,
		);
		await tool.execute(
			"call",
			{ agent: "review", task: "task", background: true },
			signal,
			onUpdate,
			context,
		);
		expect(foregroundCalls[0].run.signal).toBe(signal);
		expect(foregroundCalls[0].run.onUpdate).toBe(onUpdate);
		expect(backgroundCalls[0].run).not.toHaveProperty("signal");
		expect(backgroundCalls[0].run).not.toHaveProperty("onUpdate");
	});

	test("appends specialization after the role prompt", () => {
		const spec = createAgentCatalog(
			parse({
				custom: {
					role: "implementation",
					description: "Implements custom code.",
					prompt: "CUSTOM MARKER",
				},
			}),
		).get("custom");
		expect(spec).toBeDefined();
		if (!spec) throw new Error("custom agent missing");
		expect(buildChildArgs(spec, "high")).toEqual([
			"--no-session",
			"--no-skills",
			"--append-system-prompt",
			spec.rolePromptPath,
			"--append-system-prompt",
			"Custom subagent specialization:\nCUSTOM MARKER",
			"--thinking",
			"high",
		]);
	});

	test("uses the ported discovery prompts", () => {
		const catalog = createAgentCatalog(parse({}));
		const shallow = catalog.get("explore-shallow");
		const deep = catalog.get("explore-deep");
		expect(shallow).toBeDefined();
		expect(deep).toBeDefined();
		if (!shallow || !deep) throw new Error("explore agents missing");

		const shallowPrompt = readFileSync(shallow.rolePromptPath, "utf8");
		const deepPrompt = readFileSync(deep.rolePromptPath, "utf8");
		expect(shallowPrompt).toContain("# Shallow Summary");
		expect(shallowPrompt).toContain("Do not invoke further subagents");
		expect(deepPrompt).toContain("# Deep Summary");
		expect(deepPrompt).toContain("Follow key relationships through callers");
		expect(buildChildArgs(shallow, shallow.thinking)).toContain("--no-session");
		expect(buildChildArgs(deep, deep.thinking)).toContain("--no-skills");
	});

	test("renders historical profile calls and results", () => {
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		};

		expect(
			renderSubagentCall({ profile: "review", task: "Old task" }, theme)
				.render(120)
				.join("\n"),
		).toContain("subagent [review]");
		expect(
			renderSubagentResult(
				{
					content: [{ type: "text", text: "Old output" }],
					details: {
						profile: "review",
						cwd: "/tmp",
						model: "provider/model",
						usage,
					},
				},
				{ expanded: false, isPartial: false },
				theme,
				"Old task",
			)
				.render(120)
				.join("\n"),
		).toContain("Done review · Review provider/model");
	});

	test.each([
		[null, "$", "expected object"],
		[{}, "agents", "expected object"],
		[{ agents: [] }, "agents", "expected object"],
		[{ agents: {}, extra: true }, "extra", "unknown field"],
	] as const)("rejects invalid root config %#", (value, property, message) => {
		expect(() => parseCustomAgentConfig(value, source)).toThrow(
			`Invalid ${source} at ${property}: ${message}`,
		);
	});

	test.each([
		[
			"Bad_name",
			{ role: "review", description: "x", prompt: "x" },
			"agents.Bad_name",
			"name must match",
		],
		[
			"review",
			{ role: "review", description: "x", prompt: "x" },
			"agents.review",
			"collides",
		],
		[
			"custom",
			{ role: "unknown", description: "x", prompt: "x" },
			"agents.custom.role",
			"expected explore-shallow|explore-deep|planning|implementation|verification|review",
		],
		[
			"custom",
			{ role: "review", description: " ", prompt: "x" },
			"agents.custom.description",
			"non-empty string",
		],
		[
			"custom",
			{ role: "review", description: "x", prompt: "" },
			"agents.custom.prompt",
			"non-empty string",
		],
		[
			"custom",
			{ role: "review", description: "x", prompt: "x", model: " " },
			"agents.custom.model",
			"non-empty string",
		],
		[
			"custom",
			{ role: "review", description: "x", prompt: "x", thinking: "huge" },
			"agents.custom.thinking",
			"expected off|minimal|low|medium|high|xhigh|max",
		],
		[
			"custom",
			{ role: "review", description: "x", prompt: "x", typo: true },
			"agents.custom.typo",
			"unknown field",
		],
	] as const)(
		"rejects invalid agent config %#",
		(name, value, property, message) => {
			expect(() => parse({ [name]: value })).toThrow(property);
			expect(() => parse({ [name]: value })).toThrow(message);
		},
	);
});
