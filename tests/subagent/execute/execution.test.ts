import { expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	Conversation,
	completedGeneration,
} from "../../../extensions/subagent/conversation.js";
import {
	DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
	executeGeneration,
	resolveModel,
	resolveRequestedSkills,
	resolveTaskCwd,
} from "../../../extensions/subagent/execute.js";
import { eventually } from "../helpers/eventually.js";

const config = {
	name: "worker",
	description: "",
	systemPrompt: "",
	source: "project",
} as any;
function resumable(
	messages: any[],
	prompt: () => Promise<void>,
	abort = mock(),
) {
	const agent = new Conversation(
		"amber-acorn" as any,
		config,
		{ kind: "spawn", agent: "worker", prompt: "first", label: "first" },
		() => {},
	);
	const session = { messages, subscribe: () => () => {}, prompt, abort } as any;
	agent.bindSession(agent.latestGeneration, session);
	completedGeneration(agent, agent.latestGeneration, "first");
	agent.markCollected(agent.latestGeneration, "model");
	const attempt = agent.beginResume("continue");
	return { agent, attempt, session, abort };
}

test("resume completes with the final assistant text", async () => {
	const f = resumable(
		[{ role: "assistant", content: [{ type: "text", text: "finished" }] }],
		async () => {},
	);
	await expect(
		executeGeneration({} as any, f.agent, f.attempt),
	).resolves.toMatchObject({
		status: { kind: "done", outcome: "completed", output: "finished" },
	});
});

test("child session lifecycle observers span finalized tool execution events", async () => {
	const listeners: Array<(event: any) => void> = [];
	const session = {
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "finished" }] },
		],
		subscribe(listener: (event: any) => void) {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		async prompt() {
			const start = {
				type: "tool_execution_start",
				toolCallId: "child-call",
				toolName: "subagent",
				args: { action: "inspect", subagentIds: ["amber-acorn"] },
			};
			const end = {
				type: "tool_execution_end",
				toolCallId: "child-call",
				toolName: "subagent",
				result: {
					details: {
						response: {
							action: "inspect",
							results: [{ subagentId: "amber-acorn", status: "completed" }],
						},
						observedGenerations: [
							{ conversationId: "amber-acorn", generation: 1 },
						],
					},
				},
			};
			for (const listener of [...listeners]) listener(start);
			for (const listener of [...listeners]) listener(end);
		},
		abort: mock(),
	} as any;
	const agent = new Conversation(
		"amber-acorn" as any,
		config,
		{ kind: "spawn", agent: "worker", prompt: "first", label: "first" },
		() => {},
	);
	agent.bindSession(agent.latestGeneration, session);
	completedGeneration(agent, agent.latestGeneration, "first");
	agent.markCollected(agent.latestGeneration, "model");
	const attempt = agent.beginResume("continue");
	const observed: any[] = [];

	await executeGeneration({} as any, agent, attempt, undefined, {
		...DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
		childSessionEvent: (_agent: any, _generation: any, event: any) =>
			observed.push(event),
	} as any);

	expect(observed.map((event) => event.type)).toEqual([
		"tool_execution_start",
		"tool_execution_end",
	]);
	expect(listeners).toHaveLength(0);
});

test("assistant errors and prompt failures terminalize the generation as errors", async () => {
	const modelError = resumable(
		[
			{
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				stopReason: "error",
				errorMessage: "model failed",
			},
		],
		async () => {},
	);
	await expect(
		executeGeneration({} as any, modelError.agent, modelError.attempt),
	).resolves.toMatchObject({
		status: { kind: "done", outcome: "error", error: "model failed" },
	});
	const thrown = resumable([], async () => {
		throw new Error("transport failed");
	});
	await expect(
		executeGeneration({} as any, thrown.agent, thrown.attempt),
	).resolves.toMatchObject({
		status: { kind: "done", outcome: "error", error: "transport failed" },
	});
});

test("cancellation aborts the SDK session and records interruption", async () => {
	let reject!: (error: Error) => void;
	const f = resumable(
		[],
		() =>
			new Promise<void>((_, r) => {
				reject = r;
			}),
	);
	const controller = new AbortController();
	const result = executeGeneration(
		{} as any,
		f.agent,
		f.attempt,
		controller.signal,
	);
	await eventually(() => expect(reject).toBeTypeOf("function"));
	controller.abort();
	reject(new Error("cancelled"));
	await expect(result).resolves.toMatchObject({
		status: { kind: "done", outcome: "interrupted", error: "cancelled" },
	});
	expect(f.abort).toHaveBeenCalled();
});

function model(provider: string, id: string) {
	return { provider, id } as any;
}

function registry(...models: any[]) {
	return { getAll: () => models } as any;
}

test("resolves canonical and unique bare model references", () => {
	const parent = model("parent-provider", "parent-model");
	const qualified = model("other-provider", "shared");
	const unique = model("other-provider", "other-model");
	const models = registry(qualified, unique);

	expect(resolveModel("other-provider/shared", parent, models)).toEqual({
		ok: true,
		value: qualified,
	});
	expect(resolveModel("other-model", parent, models)).toEqual({
		ok: true,
		value: unique,
	});
});

test("resolves canonical references whose model IDs contain slashes", () => {
	const canonical = model("openrouter", "anthropic/claude-3-haiku");
	const bareCollision = model(
		"parent-provider",
		"openrouter/anthropic/claude-3-haiku",
	);
	const parent = model("parent-provider", "parent-model");

	expect(
		resolveModel(
			"openrouter/anthropic/claude-3-haiku",
			parent,
			registry(bareCollision, canonical),
		),
	).toEqual({
		ok: true,
		value: canonical,
	});
});

test("treats the complete reference as a bare model ID when it is not canonical", () => {
	const slashId = model("gateway", "anthropic/claude-3-haiku");
	expect(
		resolveModel("anthropic/claude-3-haiku", undefined, registry(slashId)),
	).toEqual({
		ok: true,
		value: slashId,
	});
});

test("uses the parent provider to disambiguate a bare model ID", () => {
	const parent = model("parent-provider", "parent-model");
	const preferred = model("parent-provider", "shared");
	const other = model("other-provider", "shared");

	expect(resolveModel("shared", parent, registry(other, preferred))).toEqual({
		ok: true,
		value: preferred,
	});
});

test("rejects an ambiguous bare model ID without a parent-provider match", () => {
	const first = model("first-provider", "shared");
	const second = model("second-provider", "shared");
	const parent = model("unmatched-provider", "parent-model");

	expect(resolveModel("shared", parent, registry(first, second))).toEqual({
		ok: false,
		error:
			'Ambiguous model "shared": matches first-provider/shared, second-provider/shared. Use a provider-qualified model reference.',
	});
});

test("inherits the parent model only when no model is requested", () => {
	const parent = model("parent-provider", "parent-model");
	expect(resolveModel(undefined, parent, registry())).toEqual({
		ok: true,
		value: parent,
	});
});

test.each(["", "   ", "/", "/model", "provider/", "provider//model"])(
	"rejects malformed model %j",
	(requested) => {
		expect(resolveModel(requested, undefined, registry())).toMatchObject({
			ok: false,
			error: expect.stringContaining("Invalid model"),
		});
	},
);

test.each(["missing", "provider/missing", "provider/model/extra"])(
	"rejects unknown model %j without falling back",
	(requested) => {
		const parent = model("parent-provider", "parent-model");
		expect(resolveModel(requested, parent, registry(parent))).toEqual({
			ok: false,
			error: `Unknown model: ${requested}`,
		});
	},
);

test("does not reinterpret an unknown qualified reference as a different bare model ID", () => {
	const modelWithSameSuffix = model("known-provider", "known-model");
	expect(
		resolveModel(
			"unknown-provider/known-model",
			undefined,
			registry(modelWithSameSuffix),
		),
	).toEqual({
		ok: false,
		error: "Unknown model: unknown-provider/known-model",
	});
});

test("Generation terminalizes an invalid requested model before session allocation", async () => {
	const parent = model("parent-provider", "parent-model");
	const invalidConfig = { ...config, model: "missing" };
	const agent = new Conversation(
		"amber-acorn" as any,
		invalidConfig,
		{ kind: "spawn", agent: "worker", prompt: "first", label: "first" },
		() => {},
	);

	await expect(
		executeGeneration(
			{
				cwd: "/unvalidated-parent",
				model: parent,
				modelRegistry: registry(parent),
			} as any,
			agent,
			agent.requireCurrentGeneration(),
		),
	).resolves.toMatchObject({
		status: { kind: "done", outcome: "error", error: "Unknown model: missing" },
	});
});

test("resolves requested skills and reports discovery and read failures", () => {
	const skill = {
		name: "review",
		filePath: "/skills/review/SKILL.md",
		baseDir: "/skills/review",
		disableModelInvocation: true,
	} as any;
	const dependencies = {
		getAgentDir: () => "/agent",
		loadSkills: () => ({ skills: [skill] }),
		readSkillFile: () => "---\nname: review\n---\nReview carefully.",
	} as any;

	expect(resolveRequestedSkills("/work", ["review"], dependencies)).toEqual({
		ok: true,
		value: [
			'<skill name="review" location="/skills/review/SKILL.md">\nReferences are relative to /skills/review.\n\nReview carefully.\n</skill>',
		],
	});
	expect(resolveRequestedSkills("/work", ["missing"], dependencies)).toEqual({
		ok: false,
		error: "Unknown skill: missing",
	});
	expect(
		resolveRequestedSkills("/work", ["review"], {
			...dependencies,
			loadSkills: () => {
				throw new Error("catalog unavailable");
			},
		}),
	).toEqual({
		ok: false,
		error: "Could not discover requested skills: catalog unavailable",
	});
	expect(
		resolveRequestedSkills("/work", ["review"], {
			...dependencies,
			readSkillFile: () => {
				throw new Error("permission denied");
			},
		}),
	).toEqual({
		ok: false,
		error: "Could not load requested skill: permission denied",
	});
});

test("child startup keeps skill catalog hidden while preserving explicit preloads", async () => {
	let loaderOptions: any;
	let sessionOptions: any;
	let authReady = false;
	class ResourceLoader {
		constructor(options: any) {
			loaderOptions = options;
		}
		async reload() {}
	}
	const review = {
		name: "review",
		description: "Review metadata.",
		filePath: "/skills/review/SKILL.md",
		baseDir: "/skills/review",
		disableModelInvocation: true,
	} as any;
	const hidden = {
		name: "hidden-catalog-skill",
		description: "Must not appear in the child prompt.",
		filePath: "/skills/hidden/SKILL.md",
		baseDir: "/skills/hidden",
	} as any;
	const agent = new Conversation(
		"amber-acorn" as any,
		{
			...config,
			systemPrompt: "Worker prompt.",
			skills: ["review"],
			tools: ["read"],
		},
		{ kind: "spawn", agent: "worker", prompt: "work", label: "work" },
		() => {},
	);
	const result = await executeGeneration(
		{
			cwd: "/work",
			model: model("test", "known"),
			modelRegistry: registry(model("test", "known")),
		} as any,
		agent,
		agent.latestGeneration,
		undefined,
		{
			...DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
			ResourceLoader: ResourceLoader as any,
			getAgentDir: () => "/agent",
			loadSkills: () => ({ skills: [review, hidden] }),
			readSkillFile: () =>
				"---\nname: review\ndescription: Review metadata.\n---\nReview instructions.",
			loadExtensionPaths: async () => [],
			childToolsFor: () => [
				{ name: "subagent" } as any,
				{ name: "load_skill" } as any,
			],
			createAgentSession: async (options: any) => {
				sessionOptions = options;
				return {
					session: {
						bindExtensions: async () => {
							authReady = true;
						},
						model: model("test", "known"),
						thinkingLevel: "medium",
						messages: [
							{
								role: "assistant",
								content: [{ type: "text", text: "done" }],
							},
						],
						subscribe: () => () => {},
						prompt: async () => {
							expect(authReady).toBe(true);
						},
						abort: async () => {},
						getActiveToolNames: () => ["subagent", "load_skill"],
					} as any,
					extensionsResult: {} as any,
				};
			},
		} as any,
	);

	expect(result.status).toMatchObject({ kind: "done", outcome: "completed" });
	expect(loaderOptions.noSkills).toBe(true);
	const systemPrompt = loaderOptions.systemPromptOverride();
	expect(systemPrompt).toContain("Review instructions.");
	expect(systemPrompt).not.toContain("hidden-catalog-skill");
	expect(systemPrompt).not.toContain("Must not appear");
	expect(sessionOptions.customTools.map((tool: any) => tool.name)).toEqual([
		"subagent",
		"load_skill",
	]);
	expect(sessionOptions.tools).toEqual(["read", "load_skill"]);
});

test("resolves and validates relative and absolute requested working directories", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "generation-cwd-"));
	const relative = path.join("nested", "task");
	const absolute = path.join(root, "absolute");
	await mkdir(path.join(root, relative), { recursive: true });
	await mkdir(absolute);

	expect(resolveTaskCwd(root, relative)).toEqual({
		ok: true,
		value: path.join(root, relative),
	});
	expect(resolveTaskCwd(path.join(root, "unused"), absolute)).toEqual({
		ok: true,
		value: absolute,
	});
});

test("does not revalidate the inherited parent working directory", () => {
	const parentCwd = path.join(
		tmpdir(),
		"generation-parent-does-not-need-to-exist",
	);
	expect(resolveTaskCwd(parentCwd, undefined)).toEqual({
		ok: true,
		value: parentCwd,
	});
});

test("rejects missing working directories and files", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "generation-invalid-cwd-"));
	const missing = path.join(root, "missing");
	const file = path.join(root, "file.txt");
	await writeFile(file, "not a directory");

	expect(resolveTaskCwd(root, "missing")).toEqual({
		ok: false,
		error: `Working directory does not exist: ${missing}`,
	});
	expect(resolveTaskCwd(root, "file.txt")).toEqual({
		ok: false,
		error: `Working directory is not a directory: ${file}`,
	});
});
