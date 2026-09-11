import type { Api, Model, ModelAuth, Provider } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { StoredCredential } from "./account-store.js";
import {
	type AccountProviderAdapter,
	type AccountProviderId,
	requireOAuth,
} from "./oauth.js";

export const RUNTIME_FAIL_CLOSED_API_KEY = "pi-accounts-auth-failed";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

type RuntimeAuthStorage = {
	setRuntimeApiKey(provider: string, apiKey: string): void | Promise<void>;
	removeRuntimeApiKey(provider: string): void | Promise<void>;
};

type RuntimeOverrideState = {
	appliedApiKey: string | undefined;
	generation: number;
	mayHaveOverride: boolean;
	operationTail: Promise<void>;
};

type RuntimeOverrideSnapshot = {
	target: RuntimeAuthStorage & object;
	state: RuntimeOverrideState;
	generation: number;
};

type RuntimeProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];
type RuntimeRegistration = RuntimeProviderConfig | Provider;
type SelectedAuth = { auth: ModelAuth; credential: StoredCredential };
type PiModel = Model<Api>;

type ProviderAccountState = {
	active?: string;
	accounts: Record<string, StoredCredential>;
};

export type RuntimeAccountStore = {
	readProviderAsync(
		providerId: AccountProviderId,
	): Promise<ProviderAccountState>;
	updateProviderAsync(
		providerId: AccountProviderId,
		mutator: (state: ProviderAccountState) => Promise<ProviderAccountState>,
	): Promise<ProviderAccountState>;
};

export type EnsureActiveProviderAuthResult =
	| { status: "inactive"; providerId: AccountProviderId }
	| { status: "active"; providerId: AccountProviderId; accountName: string }
	| {
			status: "error";
			providerId: AccountProviderId;
			accountName: string;
			message: string;
	  };

export class RuntimeAuthCoordinator {
	private readonly controller: RuntimeApiKeyController;
	private readonly overlay: RuntimeProviderOverlay;
	private availableModelIds: ReadonlySet<string> | undefined;
	readonly provider: AccountProviderAdapter;
	private readonly failClosedApiKey: string;

	constructor(
		pi: ExtensionAPI,
		provider: AccountProviderAdapter,
		failClosedApiKey = RUNTIME_FAIL_CLOSED_API_KEY,
	) {
		this.provider = provider;
		this.failClosedApiKey = failClosedApiKey;
		this.controller = new RuntimeApiKeyController(provider.id);
		this.overlay = new RuntimeProviderOverlay(pi, provider, failClosedApiKey);
	}

	async ensureActive(
		ctx: ExtensionContext,
		store: RuntimeAccountStore,
		now = Date.now(),
	): Promise<EnsureActiveProviderAuthResult> {
		const operation = this.overlay.beginOperation();
		const runtimeOverride = this.controller.begin(ctx);
		let state: ProviderAccountState;
		try {
			state = await store.readProviderAsync(this.provider.id);
		} catch (error) {
			return this.failClosed(ctx, operation, runtimeOverride, "unknown", error);
		}
		const active = state.active;
		if (!active) {
			this.availableModelIds = undefined;
			try {
				this.overlay.remove(ctx, operation);
				await this.controller.clear(ctx);
				return { status: "inactive", providerId: this.provider.id };
			} catch (error) {
				return this.failClosed(
					ctx,
					this.overlay.beginOperation(),
					this.controller.begin(ctx),
					"unknown",
					error,
				);
			}
		}

		let credential = getOwnCredential(state.accounts, active);
		if (!credential) {
			let current: ProviderAccountState;
			try {
				current = await store.updateProviderAsync(
					this.provider.id,
					async (latest) => {
						if (
							latest.active !== active ||
							getOwnCredential(latest.accounts, active)
						)
							return latest;
						return { accounts: cloneCredentialMap(latest.accounts) };
					},
				);
			} catch (error) {
				return this.failClosed(ctx, operation, runtimeOverride, active, error);
			}
			if (current.active) return this.ensureActive(ctx, store, now);
			this.availableModelIds = undefined;
			this.overlay.remove(ctx, operation);
			await this.controller.clear(ctx);
			return { status: "inactive", providerId: this.provider.id };
		}

		if (
			credential.type === "oauth" &&
			credential.expires <= now + REFRESH_SKEW_MS
		) {
			let refreshError: unknown;
			let current = state;
			try {
				current = await store.updateProviderAsync(
					this.provider.id,
					async (latest) => {
						const latestCredential = getOwnCredential(latest.accounts, active);
						if (latest.active !== active || !latestCredential) return latest;
						credential = latestCredential;
						if (
							latestCredential.type !== "oauth" ||
							latestCredential.expires > now + REFRESH_SKEW_MS
						)
							return latest;
						try {
							const refreshed = await requireOAuth(this.provider).refresh(
								latestCredential,
								ctx.signal ?? new AbortController().signal,
							);
							credential = refreshed;
							return {
								...latest,
								accounts: defineOwn(latest.accounts, active, refreshed),
							};
						} catch (error) {
							refreshError = error;
							return latest;
						}
					},
				);
			} catch (error) {
				refreshError = error;
				credential = getOwnCredential(current.accounts, active) ?? credential;
			}
			if (
				current.active !== active ||
				!getOwnCredential(current.accounts, active)
			) {
				return this.ensureActive(ctx, store, now);
			}
			if (refreshError !== undefined) {
				const selection = await this.activeCredentialMatches(
					store,
					active,
					credential,
				);
				if (selection.error !== undefined) {
					return this.failClosed(
						ctx,
						operation,
						runtimeOverride,
						active,
						selection.error,
						credential,
					);
				}
				if (!selection.matches) return this.ensureActive(ctx, store, now);
				return this.failClosed(
					ctx,
					operation,
					runtimeOverride,
					active,
					refreshError,
					credential,
				);
			}
		}

		let auth: ModelAuth;
		try {
			auth =
				credential.type === "api_key"
					? { apiKey: credential.key }
					: await requireOAuth(this.provider).toAuth(credential);
			validateModelAuth(auth, this.provider.displayName);
		} catch (error) {
			const selection = await this.activeCredentialMatches(
				store,
				active,
				credential,
			);
			if (selection.error !== undefined) {
				return this.failClosed(
					ctx,
					operation,
					runtimeOverride,
					active,
					selection.error,
					credential,
				);
			}
			if (!selection.matches) return this.ensureActive(ctx, store, now);
			return this.failClosed(
				ctx,
				operation,
				runtimeOverride,
				active,
				error,
				credential,
			);
		}

		const selection = await this.activeCredentialMatches(
			store,
			active,
			credential,
		);
		if (selection.error !== undefined) {
			return this.failClosed(
				ctx,
				operation,
				runtimeOverride,
				active,
				selection.error,
				credential,
			);
		}
		if (!selection.matches) return this.ensureActive(ctx, store, now);

		try {
			const availableModelIds = readAvailableModelIds(credential);
			if (
				!this.overlay.apply(
					ctx,
					operation,
					auth,
					availableModelIds,
					async (signal) => {
						const current = await store.readProviderAsync(this.provider.id);
						const candidate = current.active
							? getOwnCredential(current.accounts, current.active)
							: undefined;
						const latest =
							candidate?.type === "api_key"
								? current
								: await store.updateProviderAsync(
										this.provider.id,
										async (state) => {
											const name = state.active;
											const selected =
												name && getOwnCredential(state.accounts, name);
											if (!name || !selected)
												throw new Error(
													"Selected account is no longer available.",
												);
											if (
												selected.type === "api_key" ||
												selected.expires > Date.now() + REFRESH_SKEW_MS
											)
												return state;
											try {
												const refreshed = await requireOAuth(
													this.provider,
												).refresh(selected, signal);
												return {
													...state,
													accounts: defineOwn(state.accounts, name, refreshed),
												};
											} catch (error) {
												throw new Error(redactCredentialError(error, selected));
											}
										},
									);
						const selected =
							latest.active && getOwnCredential(latest.accounts, latest.active);
						if (!selected)
							throw new Error("Selected account is no longer available.");
						try {
							const resolved =
								selected.type === "api_key"
									? { apiKey: selected.key }
									: await requireOAuth(this.provider).toAuth(selected);
							validateModelAuth(resolved, this.provider.displayName);
							return { auth: resolved, credential: selected };
						} catch (error) {
							throw new Error(redactCredentialError(error, selected));
						}
					},
				)
			) {
				return { status: "inactive", providerId: this.provider.id };
			}
			const applied = await this.controller.apply(
				ctx,
				runtimeOverride,
				auth.apiKey,
			);
			if (applied === "stale")
				return { status: "inactive", providerId: this.provider.id };
			if (applied === "unavailable") {
				throw new Error(
					`Pi did not retain the runtime ${this.provider.displayName} credential.`,
				);
			}
			await this.verifyOverlay(ctx, auth, availableModelIds);
			this.availableModelIds = availableModelIds
				? new Set(availableModelIds)
				: undefined;
			return {
				status: "active",
				providerId: this.provider.id,
				accountName: active,
			};
		} catch (error) {
			return this.failClosed(
				ctx,
				operation,
				runtimeOverride,
				active,
				error,
				credential,
			);
		}
	}

	isModelAvailable(modelId: string): boolean {
		return !this.availableModelIds || this.availableModelIds.has(modelId);
	}

	async forceFailClosed(
		ctx: ExtensionContext,
		accountName: string,
		error: unknown,
		credential?: StoredCredential,
	): Promise<EnsureActiveProviderAuthResult> {
		return this.failClosed(
			ctx,
			this.overlay.beginOperation(),
			this.controller.begin(ctx),
			accountName,
			error,
			credential,
		);
	}

	invalidate(ctx: ExtensionContext): void {
		this.overlay.beginOperation();
		this.controller.invalidate(ctx);
	}

	async clear(ctx: ExtensionContext): Promise<void> {
		const operation = this.overlay.beginOperation();
		this.availableModelIds = undefined;
		// Pi synchronizes auth when removing the key. Restore the default resolver first.
		this.overlay.remove(ctx, operation);
		await this.controller.clear(ctx);
	}

	private async failClosed(
		ctx: ExtensionContext,
		operation: number,
		runtimeOverride: RuntimeOverrideSnapshot | undefined,
		accountName: string,
		error: unknown,
		credential?: StoredCredential,
	): Promise<EnsureActiveProviderAuthResult> {
		let suffix = "";
		try {
			this.overlay.apply(
				ctx,
				operation,
				{},
				credential ? safelyReadAvailableModelIds(credential) : undefined,
			);
		} catch {
			suffix = " Pi could not apply the fail-closed provider overlay.";
		}
		try {
			const applied = await this.controller.apply(
				ctx,
				runtimeOverride,
				this.failClosedApiKey,
			);
			if (applied === "stale")
				return { status: "inactive", providerId: this.provider.id };
			if (applied === "unavailable")
				suffix += " Pi did not accept the fail-closed credential.";
		} catch {
			suffix +=
				" Pi could not apply the fail-closed credential; provider turns will be aborted.";
		}
		const availableModelIds = credential
			? safelyReadAvailableModelIds(credential)
			: undefined;
		this.availableModelIds = availableModelIds
			? new Set(availableModelIds)
			: undefined;
		return {
			status: "error",
			providerId: this.provider.id,
			accountName,
			message: `${credential ? redactCredentialError(error, credential) : redactTokenText(errorMessage(error))}${suffix}`,
		};
	}

	private async activeCredentialMatches(
		store: RuntimeAccountStore,
		accountName: string,
		expected: StoredCredential,
	): Promise<{ matches: boolean; error?: unknown }> {
		try {
			const latest = await store.readProviderAsync(this.provider.id);
			const current = getOwnCredential(latest.accounts, accountName);
			return {
				matches:
					latest.active === accountName &&
					current !== undefined &&
					JSON.stringify(current) === JSON.stringify(expected),
			};
		} catch (error) {
			return { matches: false, error };
		}
	}

	private async verifyOverlay(
		ctx: ExtensionContext,
		auth: ModelAuth,
		availableModelIds?: readonly string[],
	): Promise<void> {
		const registered = getRegisteredProviderConfig(ctx, this.provider.id);
		if (auth.baseUrl && registered?.baseUrl !== auth.baseUrl) {
			throw new Error(
				`Pi did not retain the runtime ${this.provider.displayName} endpoint.`,
			);
		}
		if (auth.headers) {
			for (const [name, value] of Object.entries(auth.headers)) {
				if (value !== null && registered?.headers?.[name] !== value) {
					throw new Error(
						`Pi did not retain the runtime ${this.provider.displayName} headers.`,
					);
				}
				if (
					value === null &&
					registered?.headers &&
					registered.headers[name] !== null &&
					Object.hasOwn(registered.headers, name)
				) {
					throw new Error(
						`Pi did not remove the runtime ${this.provider.displayName} header.`,
					);
				}
			}
		}
		const modelId =
			availableModelIds?.[0] ?? firstProviderModelId(ctx, this.provider.id);
		const model = modelId
			? findProviderModel(ctx, this.provider.id, modelId)
			: undefined;
		if (model && auth.baseUrl && model.baseUrl !== auth.baseUrl) {
			throw new Error(
				`Pi did not apply the runtime ${this.provider.displayName} endpoint.`,
			);
		}
		if (model && auth.headers) {
			const resolved = await getApiKeyAndHeaders(ctx, model);
			if (resolved?.ok === false) {
				throw new Error(
					`Pi could not resolve the runtime ${this.provider.displayName} headers.`,
				);
			}
			for (const [name, value] of Object.entries(auth.headers)) {
				if (value !== null && resolved?.headers?.[name] !== value) {
					throw new Error(
						`Pi did not apply the runtime ${this.provider.displayName} headers.`,
					);
				}
			}
		}
	}
}

class RuntimeProviderOverlay {
	private generation = 0;
	private owned = false;
	private previous: RuntimeRegistration | undefined;
	private applied: RuntimeRegistration | undefined;
	private baseModels: NonNullable<RuntimeProviderConfig["models"]> | undefined;
	private readonly pi: ExtensionAPI;
	private readonly provider: AccountProviderAdapter;
	private readonly fallbackApiKey: string;

	constructor(
		pi: ExtensionAPI,
		provider: AccountProviderAdapter,
		fallbackApiKey: string,
	) {
		this.pi = pi;
		this.provider = provider;
		this.fallbackApiKey = fallbackApiKey;
	}

	beginOperation(): number {
		this.generation += 1;
		return this.generation;
	}

	apply(
		ctx: ExtensionContext,
		generation: number,
		auth: ModelAuth,
		availableModelIds?: readonly string[],
		resolveAuth?: (signal: AbortSignal) => Promise<SelectedAuth>,
	): boolean {
		if (generation !== this.generation) return false;
		const needsOverlay =
			this.provider.requiresApiKeyBridge ||
			getRegisteredNativeProvider(ctx, this.provider.id) !== undefined ||
			auth.baseUrl !== undefined ||
			(auth.headers !== undefined && Object.keys(auth.headers).length > 0) ||
			availableModelIds !== undefined;
		if (!needsOverlay) {
			if (this.owned) this.remove(ctx, generation);
			return true;
		}
		const current = getRegisteredProviderConfig(ctx, this.provider.id);
		if (this.owned && !shallowConfigEqual(current, this.applied)) {
			throw new Error(
				`${this.provider.displayName} provider configuration changed while pi-accounts owned its auth overlay.`,
			);
		}
		if (!this.owned) {
			this.previous = current;
			this.baseModels = readProviderModels(ctx, this.provider.id);
		}

		const next = this.buildConfig(auth, availableModelIds, resolveAuth);
		if (Object.keys(next).length === 0 && !this.owned) return true;
		this.replaceConfig(this.owned ? this.applied : current, next);
		this.owned = true;
		this.applied = next;
		return true;
	}

	remove(ctx: ExtensionContext, generation: number): void {
		if (generation !== this.generation || !this.owned) return;
		const current = getRegisteredProviderConfig(ctx, this.provider.id);
		if (!shallowConfigEqual(current, this.applied)) {
			this.reset();
			return;
		}
		this.replaceConfig(current, this.previous);
		this.reset();
	}

	private buildConfig(
		auth: ModelAuth,
		availableModelIds?: readonly string[],
		resolveAuth?: (signal: AbortSignal) => Promise<SelectedAuth>,
	): RuntimeRegistration {
		if (this.previous && "id" in this.previous) {
			const previous = this.previous;
			let selected: StoredCredential | undefined;
			const resolve = async (signal: AbortSignal): Promise<ModelAuth> => {
				if (!resolveAuth)
					throw new Error("Selected account authentication failed.");
				const result = await resolveAuth(signal);
				selected = result.credential;
				return result.auth;
			};
			return {
				...previous,
				...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
				headers: { ...previous.headers, ...auth.headers },
				auth: {
					...previous.auth,
					...(previous.auth.oauth
						? {
								oauth: {
									...previous.auth.oauth,
									refresh: async () => {
										throw new Error(
											"Standalone OAuth refresh is not permitted while an account is selected.",
										);
									},
									toAuth: () => resolve(new AbortController().signal),
								},
							}
						: {}),
					apiKey: {
						name: "Selected account",
						login:
							previous.auth.apiKey?.login ??
							(async () => {
								throw new Error("Use /accounts to sign in.");
							}),
						check: async () => ({ type: "api_key", source: "pi-accounts" }),
						resolve: async ({ ctx, signal }) => {
							const auth = await resolve(signal);
							if (selected?.type === "api_key" && previous.auth.apiKey) {
								const result = await previous.auth.apiKey.resolve({
									ctx,
									signal,
									credential: selected,
								});
								if (!result)
									throw new Error(
										"Selected API key did not resolve request auth.",
									);
								return { ...result, source: "pi-accounts" };
							}
							return { auth, source: "pi-accounts" };
						},
					},
				},
				...(previous.refreshModels
					? {
							refreshModels: async (context) => {
								await resolve(context.signal);
								if (!selected)
									throw new Error("Selected account is no longer available.");
								await previous.refreshModels?.({
									...context,
									credential: selected,
								});
							},
						}
					: {}),
				...(previous.filterModels
					? {
							filterModels: (models) =>
								previous.filterModels?.(models, selected) ?? models,
						}
					: {}),
				getModels: () => {
					const ids = selected
						? readAvailableModelIds(selected)
						: availableModelIds;
					const allowed = ids && new Set(ids);
					return previous
						.getModels()
						.filter((model) => !allowed || allowed.has(model.id))
						.map((model) =>
							auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
						);
				},
			};
		}
		const next: RuntimeProviderConfig = { ...(this.previous ?? {}) };
		if (this.provider.requiresApiKeyBridge) next.apiKey = this.fallbackApiKey;
		if (auth.baseUrl) next.baseUrl = auth.baseUrl;
		if (auth.headers)
			next.headers = mergeConfigHeaders(this.previous?.headers, auth.headers);
		if (availableModelIds) {
			const allowed = new Set(availableModelIds);
			next.models = (this.baseModels ?? [])
				.filter((model) => allowed.has(model.id))
				.map((model) =>
					auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
				);
		}
		return next;
	}

	private replaceConfig(
		fallback: RuntimeRegistration | undefined,
		next: RuntimeRegistration | undefined,
	): void {
		this.pi.unregisterProvider(this.provider.id);
		try {
			this.register(next);
		} catch (error) {
			this.pi.unregisterProvider(this.provider.id);
			this.register(fallback);
			throw error;
		}
	}

	private register(config: RuntimeRegistration | undefined): void {
		if (!config || Object.keys(config).length === 0) return;
		if ("id" in config) this.pi.registerProvider(config);
		else this.pi.registerProvider(this.provider.id, config);
	}

	private reset(): void {
		this.owned = false;
		this.previous = undefined;
		this.applied = undefined;
		this.baseModels = undefined;
	}
}

class RuntimeApiKeyController {
	private readonly states = new WeakMap<object, RuntimeOverrideState>();
	private readonly providerId: string;

	constructor(providerId: string) {
		this.providerId = providerId;
	}

	begin(ctx: ExtensionContext): RuntimeOverrideSnapshot | undefined {
		const target = getRuntimeAuthStorage(ctx);
		if (!target) return undefined;
		const state = this.getState(target);
		state.generation += 1;
		return { target, state, generation: state.generation };
	}

	async apply(
		ctx: ExtensionContext,
		snapshot: RuntimeOverrideSnapshot | undefined,
		apiKey: string,
	): Promise<"applied" | "stale" | "unavailable"> {
		if (!(await this.set(snapshot, apiKey))) return "stale";
		const matches = await this.matches(ctx, apiKey);
		if (matches !== false) return "applied";
		if (!(await this.set(snapshot, apiKey, true))) return "stale";
		return (await this.matches(ctx, apiKey)) === false
			? "unavailable"
			: "applied";
	}

	invalidate(ctx: ExtensionContext): void {
		const target = getRuntimeAuthStorage(ctx);
		const state = target ? this.states.get(target) : undefined;
		if (state) state.generation += 1;
	}

	async clear(ctx: ExtensionContext): Promise<void> {
		const target = getRuntimeAuthStorage(ctx);
		if (!target) return;
		const state = this.states.get(target);
		if (!state) return;
		state.generation += 1;
		await enqueueMutation(state, async () => {
			if (!state.mayHaveOverride) return;
			await target.removeRuntimeApiKey(this.providerId);
			state.appliedApiKey = undefined;
			state.mayHaveOverride = false;
		});
	}

	private async matches(
		ctx: ExtensionContext,
		expected: string,
	): Promise<boolean | undefined> {
		const registry = ctx.modelRegistry as unknown as {
			getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
		};
		if (typeof registry.getApiKeyForProvider !== "function") return undefined;
		try {
			return (
				(await registry.getApiKeyForProvider(this.providerId)) === expected
			);
		} catch {
			return false;
		}
	}

	private async set(
		snapshot: RuntimeOverrideSnapshot | undefined,
		apiKey: string,
		force = false,
	): Promise<boolean> {
		if (!snapshot)
			throw new Error(
				"This Pi version does not expose runtime provider authentication.",
			);
		const { generation, state, target } = snapshot;
		return enqueueMutation(state, async () => {
			if (state.generation !== generation) return false;
			if (!force && state.appliedApiKey === apiKey) return true;
			state.appliedApiKey = undefined;
			state.mayHaveOverride = true;
			await target.setRuntimeApiKey(this.providerId, apiKey);
			state.appliedApiKey = apiKey;
			return state.generation === generation;
		});
	}

	private getState(target: object): RuntimeOverrideState {
		let state = this.states.get(target);
		if (!state) {
			state = {
				appliedApiKey: undefined,
				generation: 0,
				mayHaveOverride: false,
				operationTail: Promise.resolve(),
			};
			this.states.set(target, state);
		}
		return state;
	}
}

function readProviderModels(
	ctx: ExtensionContext,
	providerId: string,
): NonNullable<RuntimeProviderConfig["models"]> {
	return ctx.modelRegistry
		.getAll()
		.filter((model) => model.provider === providerId)
		.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			baseUrl: model.baseUrl,
			reasoning: model.reasoning,
			...(model.thinkingLevelMap !== undefined
				? { thinkingLevelMap: model.thinkingLevelMap }
				: {}),
			input: [...model.input],
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			...(model.headers !== undefined ? { headers: { ...model.headers } } : {}),
			...(model.compat !== undefined ? { compat: model.compat } : {}),
		}));
}

function mergeConfigHeaders(
	previous: Record<string, string> | undefined,
	headers: Record<string, string | null>,
): Record<string, string> {
	const result = { ...(previous ?? {}) };
	for (const [name, value] of Object.entries(headers)) {
		if (value === null) delete result[name];
		else result[name] = value;
	}
	return result;
}

function validateModelAuth(
	auth: unknown,
	providerName: string,
): asserts auth is ModelAuth & { apiKey: string } {
	if (!isRecord(auth))
		throw new Error(`${providerName} OAuth returned invalid request auth.`);
	if (typeof auth["apiKey"] !== "string" || !auth["apiKey"]) {
		throw new Error(`${providerName} OAuth returned no API key.`);
	}
	if (auth["baseUrl"] !== undefined) {
		if (typeof auth["baseUrl"] !== "string") {
			throw new Error(`${providerName} OAuth returned an invalid endpoint.`);
		}
		let endpoint: URL;
		try {
			endpoint = new URL(auth["baseUrl"]);
		} catch {
			throw new Error(`${providerName} OAuth returned an invalid endpoint.`);
		}
		if (
			endpoint.protocol !== "https:" ||
			endpoint.username ||
			endpoint.password
		) {
			throw new Error(`${providerName} OAuth returned an unsafe endpoint.`);
		}
	}
	if (auth["headers"] !== undefined) {
		if (!isRecord(auth["headers"])) {
			throw new Error(`${providerName} OAuth returned invalid headers.`);
		}
		for (const [name, value] of Object.entries(auth["headers"])) {
			if (
				!name ||
				/[\r\n]/.test(name) ||
				(value !== null && typeof value !== "string")
			) {
				throw new Error(`${providerName} OAuth returned invalid headers.`);
			}
			if (typeof value === "string" && /[\r\n]/.test(value)) {
				throw new Error(`${providerName} OAuth returned invalid headers.`);
			}
		}
	}
}

function readAvailableModelIds(
	credential: StoredCredential,
): string[] | undefined {
	if (
		credential.type !== "oauth" ||
		!Object.hasOwn(credential, "availableModelIds")
	)
		return undefined;
	const value = credential["availableModelIds"];
	if (
		!Array.isArray(value) ||
		value.length > 1_000 ||
		!value.every(
			(id) => typeof id === "string" && id.length > 0 && id.length <= 256,
		)
	) {
		throw new Error("OAuth credential has invalid availableModelIds metadata.");
	}
	return [...new Set(value)];
}

function safelyReadAvailableModelIds(
	credential: StoredCredential,
): string[] | undefined {
	try {
		return readAvailableModelIds(credential);
	} catch {
		return undefined;
	}
}

function firstProviderModelId(
	ctx: ExtensionContext,
	providerId: string,
): string | undefined {
	return readProviderModels(ctx, providerId)[0]?.id;
}

function findProviderModel(
	ctx: ExtensionContext,
	providerId: string,
	modelId: string,
): PiModel | undefined {
	return ctx.modelRegistry.find(providerId, modelId);
}

async function getApiKeyAndHeaders(
	ctx: ExtensionContext,
	model: PiModel,
): ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]> {
	return ctx.modelRegistry.getApiKeyAndHeaders(model);
}

function defineOwn(
	accounts: Record<string, StoredCredential>,
	name: string,
	credential: StoredCredential,
): Record<string, StoredCredential> {
	const next = Object.assign(Object.create(null), accounts) as Record<
		string,
		StoredCredential
	>;
	Object.defineProperty(next, name, {
		configurable: true,
		enumerable: true,
		value: credential,
		writable: true,
	});
	return next;
}

function cloneCredentialMap(
	accounts: Record<string, StoredCredential>,
): Record<string, StoredCredential> {
	return Object.assign(Object.create(null), accounts) as Record<
		string,
		StoredCredential
	>;
}

function getOwnCredential(
	accounts: Record<string, StoredCredential>,
	name: string,
): StoredCredential | undefined {
	return Object.hasOwn(accounts, name) ? accounts[name] : undefined;
}

function getRegisteredProviderConfig(
	ctx: ExtensionContext,
	providerId: string,
): RuntimeRegistration | undefined {
	const native = getRegisteredNativeProvider(ctx, providerId);
	if (native) return native;
	const registry = ctx.modelRegistry as unknown as {
		getRegisteredProviderConfig?: (
			provider: string,
		) => RuntimeProviderConfig | undefined;
		registeredProviders?: Map<string, RuntimeProviderConfig>;
	};
	if (typeof registry.getRegisteredProviderConfig === "function") {
		return registry.getRegisteredProviderConfig(providerId);
	}
	return registry.registeredProviders instanceof Map
		? registry.registeredProviders.get(providerId)
		: undefined;
}

function shallowConfigEqual(
	left: RuntimeRegistration | undefined,
	right: RuntimeRegistration | undefined,
): boolean {
	if (left === right) return true;
	if (!left || !right) return !left && !right;
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) {
		if (
			!Object.is(
				(left as unknown as Record<string, unknown>)[key],
				(right as unknown as Record<string, unknown>)[key],
			)
		)
			return false;
	}
	return true;
}

function getRegisteredNativeProvider(
	ctx: ExtensionContext,
	providerId: string,
): Provider | undefined {
	return ctx.modelRegistry.getRegisteredNativeProvider?.(providerId);
}

function enqueueMutation<T>(
	state: RuntimeOverrideState,
	mutate: () => Promise<T>,
): Promise<T> {
	const operation = state.operationTail.then(mutate);
	state.operationTail = operation.then(
		() => undefined,
		() => undefined,
	);
	return operation;
}

function getRuntimeAuthStorage(
	ctx: ExtensionContext,
): (RuntimeAuthStorage & object) | undefined {
	const registry = ctx.modelRegistry as unknown as {
		authStorage?: unknown;
		runtime?: unknown;
	};
	for (const candidate of [registry, registry.runtime, registry.authStorage]) {
		if (isRuntimeAuthStorage(candidate)) return candidate;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRuntimeAuthStorage(
	value: unknown,
): value is RuntimeAuthStorage & object {
	return (
		!!value &&
		typeof value === "object" &&
		"setRuntimeApiKey" in value &&
		typeof value.setRuntimeApiKey === "function" &&
		"removeRuntimeApiKey" in value &&
		typeof value.removeRuntimeApiKey === "function"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function redactCredentialError(
	error: unknown,
	credential: StoredCredential,
): string {
	return redactTokenText(
		error instanceof Error ? error.message : String(error),
		credential.type === "api_key"
			? [credential.key]
			: [credential.access, credential.refresh],
	);
}

export function redactTokenText(
	text: string,
	exactSecrets: readonly string[] = [],
): string {
	const secrets = [...new Set(exactSecrets.filter(Boolean))].sort(
		(a, b) => b.length - a.length,
	);
	const exact = secrets.length
		? new RegExp(secrets.map((secret) => escapeRegExp(secret)).join("|"), "g")
		: undefined;
	return (exact ? text.replace(exact, "<redacted>") : text)
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
		.replace(
			/"(access|refresh|access_token|refresh_token|token)"\s*:\s*"[^"]+"/gi,
			'"$1":"<redacted>"',
		)
		.replace(/\b(access|refresh)[_-][A-Za-z0-9._~+/=-]+/gi, "$1-<redacted>");
}

const escapeRegExp = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
