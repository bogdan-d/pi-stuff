import { test } from "bun:test";
import assert from "node:assert/strict";
import type { OAuthCredential, Provider } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	ModelRegistry,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { RuntimeAuthCoordinator } from "../../extensions/accounts/runtime-auth.js";

test("native overlays retain streams and resolve direct compaction auth from the selected store", async () => {
	let standaloneRefreshes = 0;
	let refreshes = 0;
	let refreshFails = false;
	let state = {
		active: "selected",
		accounts: {
			selected: {
				type: "oauth",
				access: "synthetic-selected",
				refresh: "synthetic-refresh",
				expires: Date.now() + 3600000,
			} as OAuthCredential,
		},
	};
	const store = {
		readProviderAsync: async () => state,
		updateProviderAsync: async (
			_id: string,
			mutate: (value: typeof state) => Promise<typeof state>,
		) => (state = await mutate(state)),
	};
	const oauth = {
		login: async () => state.accounts.selected,
		refresh: async (credential: OAuthCredential) => {
			if (refreshFails) throw new Error("Selected refresh failed");
			assert.equal(credential.refresh, "synthetic-refresh");
			refreshes++;
			return {
				...credential,
				access: "synthetic-refreshed",
				expires: Date.now() + 3600000,
			};
		},
		toAuth: async (credential: OAuthCredential) => ({
			apiKey: credential.access,
			headers: { "ChatGPT-Account-Id": "selected" },
			baseUrl: "https://selected.example",
		}),
	};
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		refreshOnCreate: false,
		credentials: {
			read: async () => ({
				type: "oauth",
				access: "invalid",
				refresh: "invalid",
				expires: 0,
			}),
			list: async () => [],
			modify: async () => {
				standaloneRefreshes++;
				throw new Error("invalid standalone OAuth");
			},
			delete: async () => {},
		},
	});
	const registry = new ModelRegistry(runtime);
	const model = { ...runtime.getModels("openai-codex")[0]!, id: "gpt-6-astra" };
	const stream = () => {
		throw new Error("No network in this test");
	};
	const native: Provider = {
		id: "openai-codex",
		name: "Conversion",
		auth: { oauth },
		getModels: () => [model],
		stream,
		streamSimple: stream,
		filterModels: (models, credential) =>
			credential?.type === "oauth" ? models : [],
	};
	registry.registerProvider(native);
	let reject = false;
	let rollback: Provider | undefined;
	const pi = {
		registerProvider(provider: Provider) {
			if (reject && provider !== native && provider !== rollback)
				throw new Error("rejected");
			registry.registerProvider(provider);
		},
		unregisterProvider: (id: string) => registry.unregisterProvider(id),
	} as ExtensionAPI;
	const ctx = { modelRegistry: registry } as ExtensionContext;
	const coordinator = new RuntimeAuthCoordinator(pi, {
		id: "openai-codex",
		displayName: "Codex",
		requiresApiKeyBridge: true,
		oauth,
	});
	assert.equal((await coordinator.ensureActive(ctx, store)).status, "active");
	const applied = registry.getRegisteredNativeProvider(native.id)!;
	assert.equal(applied.stream, stream);
	assert.equal(applied.streamSimple, stream);
	assert.equal(registry.getRegisteredProviderConfig(native.id), undefined);
	state.accounts.selected.expires = 0;
	const auth = await registry.getApiKeyAndHeaders(model);
	assert.equal(auth.ok, true);
	if (!auth.ok) throw new Error(auth.error);
	assert.equal(auth.apiKey, "synthetic-refreshed");
	assert.equal(auth.headers?.["ChatGPT-Account-Id"], "selected");
	assert.equal(auth.baseUrl, "https://selected.example");
	assert.equal(refreshes, 1);
	assert.equal(standaloneRefreshes, 0);
	assert.equal((await runtime.getAvailable(native.id)).length, 1);
	refreshFails = true;
	state.accounts.selected.expires = 0;
	assert.equal((await registry.getApiKeyAndHeaders(model)).ok, false);
	assert.equal(standaloneRefreshes, 0);
	refreshFails = false;
	state.accounts.selected.expires = Date.now() + 3600000;
	rollback = applied;
	reject = true;
	assert.equal((await coordinator.ensureActive(ctx, store)).status, "error");
	assert.equal(registry.getRegisteredNativeProvider(native.id), applied);
	reject = false;
	await coordinator.clear(ctx);
	assert.equal(registry.getRegisteredNativeProvider(native.id), native);
	reject = true;
	assert.equal((await coordinator.ensureActive(ctx, store)).status, "error");
	assert.equal(registry.getRegisteredNativeProvider(native.id), native);
	reject = false;
	await coordinator.ensureActive(ctx, store);
	const foreign = { ...native, name: "Foreign" };
	registry.registerProvider(foreign);
	assert.equal((await coordinator.ensureActive(ctx, store)).status, "error");
	assert.equal(registry.getRegisteredNativeProvider(native.id), foreign);
	await coordinator.clear(ctx);
	assert.equal(registry.getRegisteredNativeProvider(native.id), foreign);
});
