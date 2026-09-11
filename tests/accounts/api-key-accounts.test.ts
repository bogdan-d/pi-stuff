import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Credential } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { normalizeStoredCredential } from "../../extensions/accounts/account-store.js";
import accountsExtension, {
	AccountStore,
	InMemoryAccountStorageBackend,
	parseAccountsData,
} from "../../extensions/accounts/accounts.js";
import { createMockContext, createMockPi } from "../support.js";

for (const native of [false, true]) {
	test(`Z.AI named keys switch without writing Pi login (${native ? "native" : "builtin"} provider)`, async () => {
		const defaultCredential: Credential = {
			type: "api_key",
			key: "synthetic-default",
		};
		const runtime = await ModelRuntime.create({
			modelsPath: null,
			refreshOnCreate: false,
			credentials: {
				read: async (id) => (id === "zai" ? defaultCredential : undefined),
				list: async () => [{ providerId: "zai", type: "api_key" }],
				modify: async () => {
					throw new Error("Must not write Pi credentials");
				},
				delete: async () => {
					throw new Error("Must not delete Pi credentials");
				},
			},
		});
		const registry = new ModelRegistry(runtime);
		const original = registry.getProvider("zai");
		assert.ok(original?.auth.apiKey?.login);
		if (native) registry.registerProvider(original);
		const mock = createMockPi();
		mock.pi.registerProvider = registry.registerProvider.bind(registry);
		mock.pi.unregisterProvider = registry.unregisterProvider.bind(registry);
		const store = new AccountStore(new InMemoryAccountStorageBackend());
		accountsExtension(mock.pi, { store, providers: [] });
		const model = registry.getAll().find((model) => model.provider === "zai");
		assert.ok(model);
		const choices: string[] = [];
		const inputs: Array<string | undefined> = [];
		const { ctx, notifications, statuses } = createMockContext({
			hasUI: true,
			model,
			modelRegistry: registry,
			select: async (_title: string, options: string[]) => {
				const choice = choices.shift();
				if (choice)
					assert.ok(options.includes(choice), `Missing option: ${choice}`);
				return choice;
			},
			input: async () => inputs.shift(),
		});
		const command = mock.commands.get("accounts");
		assert.ok(command);
		const login = async (name: string, key: string | undefined) => {
			choices.push("Login new account", "Z.AI");
			inputs.push(name, key);
			await command.handler("", ctx);
		};
		const switchTo = async (name: string) => {
			choices.push("Switch Z.AI account", name);
			await command.handler("", ctx);
		};
		const assertRequestKey = async (expected: string) => {
			await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
			const sentKeys: Array<string | null> = [];
			const result = await runtime
				.streamSimple(
					model,
					{
						messages: [
							{ role: "user", content: "Synthetic request", timestamp: 0 },
						],
					},
					{
						maxRetries: 0,
						fetch: async (input, init) => {
							const request = new Request(input, init);
							sentKeys.push(request.headers.get("authorization"));
							return new Response(
								'data: {"id":"synthetic","object":"chat.completion.chunk","created":0,"model":"glm-4.7","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"synthetic","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
								{ headers: { "Content-Type": "text/event-stream" } },
							);
						},
					},
				)
				.result();
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.deepEqual(sentKeys, [`Bearer ${expected}`]);
		};
		await login("primary", "synthetic-primary");
		await assertRequestKey("synthetic-primary");
		assert.equal(
			await registry.getApiKeyForProvider("zai"),
			"synthetic-primary",
		);
		await login("backup", "synthetic-backup");
		await assertRequestKey("synthetic-backup");
		assert.equal(
			await registry.getApiKeyForProvider("zai"),
			"synthetic-backup",
		);
		await switchTo("primary");
		await assertRequestKey("synthetic-primary");
		assert.equal(
			await registry.getApiKeyForProvider("zai"),
			"synthetic-primary",
		);
		assert.equal(statuses.get("accounts"), "account:primary");
		await login("cancelled", undefined);
		assert.equal((await store.readProviderAsync("zai")).active, "primary");
		assert.equal(
			(await store.readProviderAsync("zai")).accounts.cancelled,
			undefined,
		);
		await switchTo("default");
		assert.equal(
			await registry.getApiKeyForProvider("zai"),
			"synthetic-default",
		);
		assert.equal(
			registry.getRegisteredNativeProvider("zai"),
			native ? original : undefined,
		);
		assert.equal(
			mock.setModels.length,
			0,
			"Same-provider key switches keep the model",
		);
		const codexModel = registry
			.getAll()
			.find((candidate) => candidate.provider === "openai-codex");
		assert.ok(codexModel);
		const crossProviderContext = { ...ctx, model: codexModel };
		choices.push("Switch provider account", "Z.AI", "primary", model.id);
		await command.handler("", crossProviderContext);
		assert.deepEqual(
			mock.setModels.at(-1),
			model,
			"Choosing a Z.AI account from Codex must offer and select a GLM model",
		);
		assert.equal(
			await registry.getApiKeyForProvider("zai"),
			"synthetic-primary",
		);
		const modelSelections = mock.setModels.length;
		choices.push("Switch provider account", "Z.AI", "backup");
		await command.handler("", crossProviderContext);
		assert.equal(
			mock.setModels.length,
			modelSelections,
			"Cancelling the model picker leaves the current model unchanged",
		);
		await switchTo("✓ backup");
		choices.push("Remove account", "Z.AI · backup");
		await command.handler("", ctx);
		assert.equal(
			await registry.getApiKeyForProvider("zai"),
			"synthetic-default",
		);
		assert.equal(
			(await store.readProviderAsync("zai")).accounts.backup,
			undefined,
		);
		assert.equal(
			registry.getRegisteredNativeProvider("zai"),
			native ? original : undefined,
		);
		assert.ok(!JSON.stringify(notifications).includes("synthetic-"));
		assert.deepEqual(
			Object.keys((await store.readProviderAsync("zai")).accounts),
			["primary"],
		);
	});
}

test("a provider with both login methods keeps OAuth and API-key accounts independently", async () => {
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		refreshOnCreate: false,
		credentials: {
			read: async () => undefined,
			list: async () => [],
			modify: async () => {
				throw new Error("Must not write Pi credentials");
			},
			delete: async () => {
				throw new Error("Must not delete Pi credentials");
			},
		},
	});
	const registry = new ModelRegistry(runtime);
	const mock = createMockPi();
	mock.pi.registerProvider = registry.registerProvider.bind(registry);
	mock.pi.unregisterProvider = registry.unregisterProvider.bind(registry);
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	accountsExtension(mock.pi, {
		store,
		providers: [
			{
				id: "anthropic",
				displayName: "Anthropic",
				requiresApiKeyBridge: false,
				oauth: {
					login: async () => ({
						type: "oauth",
						access: "synthetic-oauth",
						refresh: "synthetic-refresh",
						expires: Date.now() + 3600000,
					}),
					refresh: async () => {
						throw new Error(
							"Must not refresh API keys or fresh OAuth credentials",
						);
					},
					toAuth: async (credential) => {
						assert.equal(credential.type, "oauth");
						return { apiKey: credential.access };
					},
				},
			},
		],
	});
	const choices = [
		"Login new account",
		"Anthropic",
		"OAuth",
		"Login new account",
		"Anthropic",
		"API key",
		"Switch Anthropic account",
		"subscription",
	];
	const inputs = ["subscription", "paid", "synthetic-paid"];
	const { ctx } = createMockContext({
		hasUI: true,
		model: registry.getAll().find((model) => model.provider === "anthropic"),
		modelRegistry: registry,
		select: async (_title: string, options: string[]) => {
			const choice = choices.shift();
			assert.ok(choice && options.includes(choice));
			return choice;
		},
		input: async () => inputs.shift(),
	});
	const command = mock.commands.get("accounts");
	assert.ok(command);
	await command.handler("", ctx);
	assert.equal(
		await registry.getApiKeyForProvider("anthropic"),
		"synthetic-oauth",
	);
	await command.handler("", ctx);
	assert.equal(
		await registry.getApiKeyForProvider("anthropic"),
		"synthetic-paid",
	);
	await command.handler("", ctx);
	assert.equal(
		await registry.getApiKeyForProvider("anthropic"),
		"synthetic-oauth",
	);
	assert.deepEqual(
		Object.keys((await store.readProviderAsync("anthropic")).accounts),
		["subscription", "paid"],
	);
});

test("API-key storage preserves OAuth accounts and rejects invalid keys without exposing them", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			anthropic: {
				active: "key",
				accounts: {
					key: { type: "api_key", key: "synthetic-key" },
					subscription: {
						type: "oauth",
						access: "synthetic-access",
						refresh: "synthetic-refresh",
						expires: 123,
					},
				},
			},
		},
	});
	assert.equal(
		(await store.readProviderAsync("anthropic")).accounts.key?.type,
		"api_key",
	);
	assert.equal(
		(await store.readProviderAsync("anthropic")).accounts.subscription?.type,
		"oauth",
	);
	for (const key of [undefined, "", "  ", 42, "synthetic-secret\ninvalid"]) {
		assert.throws(
			() => normalizeStoredCredential({ type: "api_key", key }, "work"),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.ok(!error.message.includes("synthetic-secret"));
				return true;
			},
		);
	}
	const parsed = parseAccountsData(
		'{"version":1,"providers":{"__proto__":{"accounts":{"constructor":{"type":"api_key","key":"synthetic-safe"}}}}}',
	);
	assert.equal(Object.getPrototypeOf(parsed.providers), null);
	assert.equal(
		parsed.providers["__proto__"]?.accounts["constructor"]?.type,
		"api_key",
	);
});
