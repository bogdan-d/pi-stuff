import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import accountsExtension, {
	AccountStore,
	InMemoryAccountStorageBackend,
} from "../../extensions/accounts/accounts.js";
import { Conversation } from "../../extensions/subagent/conversation.js";
import {
	DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
	executeGeneration,
} from "../../extensions/subagent/execute.js";
import { createMockContext } from "../support.js";

test("SDK startup recovers accounts-only auth and child preflight uses the selected key", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "accounts-startup-"));
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		refreshOnCreate: false,
		credentials: {
			read: async () => undefined,
			list: async () => [],
			modify: async () => {
				throw new Error("Must not write native credentials");
			},
			delete: async () => {
				throw new Error("Must not delete native credentials");
			},
		},
	});
	const registry = new ModelRegistry(runtime);
	const model = registry.getAll().find((model) => model.provider === "zai");
	assert.ok(model);
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.updateProvider("zai", () => ({
		active: "second",
		accounts: {
			first: { type: "api_key", key: "synthetic-first" },
			second: { type: "api_key", key: "synthetic-second" },
		},
	}));
	const settings = SettingsManager.inMemory();
	class Loader extends DefaultResourceLoader {
		constructor(
			options: ConstructorParameters<typeof DefaultResourceLoader>[0],
		) {
			super({
				...options,
				settingsManager: settings,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [
					(pi) =>
						accountsExtension(pi, {
							store,
							providers: [],
							selection: {
								storage: new InMemoryAccountStorageBackend(),
								args: {},
								defaults: () => ({
									provider: model.provider,
									model: model.id,
									thinking: "medium",
								}),
							},
						}),
				],
			});
		}
	}
	const loader = new Loader({ cwd, agentDir: cwd });
	await loader.reload();
	const initial = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRuntime: runtime,
		resourceLoader: loader,
		settingsManager: settings,
		sessionManager: SessionManager.inMemory(cwd),
	});
	try {
		assert.equal(initial.session.model?.provider, "unknown");
		assert.ok(initial.modelFallbackMessage?.includes("No models available"));
		const ui = createMockContext({ mode: "tui" });
		await initial.session.bindExtensions({ mode: "tui", uiContext: ui.ctx.ui });
		assert.equal(initial.session.model?.id, model.id);
		assert.equal(
			await registry.getApiKeyForProvider("zai"),
			"synthetic-second",
		);
		assert.deepEqual(ui.notifications, []);
		await initial.session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "quit",
		});
	} finally {
		initial.session.dispose();
	}
	assert.equal(await registry.getApiKeyForProvider("zai"), undefined);
	const agent = new Conversation(
		"test-child" as never,
		{
			name: "worker",
			description: "",
			systemPrompt: "",
			source: "project",
		} as never,
		{ kind: "spawn", agent: "worker", prompt: "hi", label: "test" },
		() => {},
	);
	let child:
		| Awaited<ReturnType<typeof createAgentSession>>["session"]
		| undefined;
	const sent: Array<string | null> = [];
	try {
		const { ctx } = createMockContext({ cwd, model, modelRegistry: registry });
		const result = await executeGeneration(
			ctx,
			agent,
			agent.latestGeneration,
			undefined,
			{
				...DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
				ResourceLoader: Loader,
				getAgentDir: () => cwd,
				loadExtensionPaths: async () => [],
				settingsManager: () => settings,
				createAgentSession: async (options) => {
					const created = await createAgentSession({
						...options,
						modelRuntime: runtime,
					});
					child = created.session;
					await assert.rejects(
						child.prompt("auth preflight"),
						/No API key found for zai/,
					);
					child.agent.streamFunction = (model, context, options) =>
						runtime.streamSimple(model, context, {
							...options,
							fetch: async (input, init) => {
								sent.push(
									new Request(input, init).headers.get("authorization"),
								);
								return new Response(
									'data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
									{ headers: { "content-type": "text/event-stream" } },
								);
							},
						});
					return created;
				},
			},
		);
		assert.equal(result.status.kind, "done");
		assert.ok(
			"outcome" in result.status && result.status.outcome === "completed",
			JSON.stringify(result.status),
		);
		assert.deepEqual(sent, ["Bearer synthetic-second"]);
	} finally {
		await child?.extensionRunner.emit({
			type: "session_shutdown",
			reason: "quit",
		});
		child?.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
});
