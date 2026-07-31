import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	createAgentCatalog,
	getAgentNames,
} from "../extensions/delegated-agents/agents.js";
import { parseCustomAgentConfig } from "../extensions/delegated-agents/config.js";
import {
	renderDelegateCall,
	renderDelegateResult,
} from "../extensions/delegated-agents/render.js";
import { buildChildArgs } from "../extensions/delegated-agents/runner.js";
import { createDelegateAgentTool } from "../extensions/delegated-agents/tool.js";

const source = "/tmp/pi-delegated-agents.json";

function parse(agents: Record<string, unknown>) {
	return parseCustomAgentConfig({ agents }, source);
}

describe("delegated agent config", () => {
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
		const tool = createDelegateAgentTool(catalog);

		expect(tool.parameters.properties.agent.enum).toEqual([
			"planning",
			"implementation",
			"verification",
			"review",
			"custom",
		]);
		expect(tool.description).toContain("custom (review): Reviews custom code.");
		expect(tool.parameters.properties).not.toHaveProperty("profile");
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
			"Custom delegated-agent specialization:\nCUSTOM MARKER",
			"--thinking",
			"high",
		]);
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
			renderDelegateCall({ profile: "review", task: "Old task" }, theme)
				.render(120)
				.join("\n"),
		).toContain("delegate_agent [review]");
		expect(
			renderDelegateResult(
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
			"expected planning|implementation|verification|review",
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
