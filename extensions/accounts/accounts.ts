import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	AccountStore,
	consumeMigrationNotice,
	defineOwn,
	defineOwnMap,
	getOwnCredential,
	normalizeStoredCredential,
	parseAccountName,
	type StoredOAuthCredential,
} from "./account-store.js";
import {
	type AccountProviderAdapter,
	type AccountProviderId,
	createBuiltinProviderAdapters,
	createOAuthInteraction,
	SUPPORTED_PROVIDER_IDS,
} from "./oauth.js";
import {
	type EnsureActiveProviderAuthResult,
	RUNTIME_FAIL_CLOSED_API_KEY,
	RuntimeAuthCoordinator,
	redactTokenText,
} from "./runtime-auth.js";

export {
	ACCOUNTS_FILE,
	AccountStore,
	type AccountsData,
	InMemoryAccountStorageBackend,
	LEGACY_CODEX_ACCOUNTS_FILE,
	migrateLegacyCodexAccountsFile,
	type ProviderAccountsData,
	parseAccountName,
	parseAccountsData,
	type StoredOAuthCredential,
} from "./account-store.js";

export const ACCOUNTS_STATUS_KEY = "accounts";
export const FAIL_CLOSED_API_KEY = RUNTIME_FAIL_CLOSED_API_KEY;
export const DEFAULT_PI_LOGIN_LABEL = "(default pi login)";

export type AccountsDependencies = {
	store?: AccountStore;
	providers?: readonly AccountProviderAdapter[];
	closeCodexWebSockets?: (sessionId?: string) => unknown | Promise<unknown>;
};

export default function accountsExtension(
	pi: ExtensionAPI,
	dependencies: AccountsDependencies = {},
): void {
	const store = dependencies.store ?? new AccountStore();
	let migrationNotice = dependencies.store
		? undefined
		: consumeMigrationNotice();
	const builtinOptions = dependencies.closeCodexWebSockets
		? { closeCodexWebSockets: dependencies.closeCodexWebSockets }
		: {};
	const providers = [
		...(dependencies.providers ??
			createBuiltinProviderAdapters(builtinOptions)),
	];
	validateProviderSet(providers);
	const adapters = new Map(
		providers.map((provider) => [provider.id, provider]),
	);
	const coordinators = new Map(
		providers.map((provider) => [
			provider.id,
			new RuntimeAuthCoordinator(pi, provider),
		]),
	);
	const results = new Map<AccountProviderId, EnsureActiveProviderAuthResult>();
	const appliedIdentities = new Map<AccountProviderId, string>();
	const abortProviders = new Set<AccountProviderId>();
	const syncTasks = new Map<
		AccountProviderId,
		Promise<EnsureActiveProviderAuthResult>
	>();
	let sessionGeneration = 0;
	let menuController = new AbortController();

	const syncProvider = (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
		model = ctx.model,
	): Promise<EnsureActiveProviderAuthResult> => {
		let task!: Promise<EnsureActiveProviderAuthResult>;
		task = (async () => {
			const adapter = requireAdapter(adapters, providerId);
			const coordinator = coordinators.get(providerId);
			if (!coordinator)
				throw new Error(`Missing runtime coordinator for ${providerId}.`);
			let result = await coordinator.ensureActive(ctx, store);
			let latest = syncTasks.get(providerId);
			if (latest && latest !== task) return latest;
			try {
				const identity = await authIdentity(store, result);
				latest = syncTasks.get(providerId);
				if (latest && latest !== task) return latest;
				const previousIdentity = appliedIdentities.get(providerId);
				const shouldInvalidate =
					previousIdentity !== identity &&
					!(previousIdentity === undefined && identity === "default");
				if (shouldInvalidate) {
					await adapter.invalidateConnections?.(
						ctx.sessionManager.getSessionId(),
					);
					latest = syncTasks.get(providerId);
					if (latest && latest !== task) return latest;
				}
				appliedIdentities.set(providerId, identity);
			} catch (error) {
				latest = syncTasks.get(providerId);
				if (latest && latest !== task) return latest;
				const credential = await selectedCredential(store, providerId, result);
				latest = syncTasks.get(providerId);
				if (latest && latest !== task) return latest;
				result = await coordinator.forceFailClosed(
					ctx,
					result.status === "inactive" ? "unknown" : result.accountName,
					error,
					credential,
				);
			}
			latest = syncTasks.get(providerId);
			if (latest && latest !== task) return latest;
			results.set(providerId, result);
			updateStatus(ctx, results, model);
			return result;
		})();
		syncTasks.set(providerId, task);
		return task;
	};

	const syncAll = async (ctx: ExtensionContext): Promise<void> => {
		for (const provider of providers) {
			const result = await syncProvider(provider.id, ctx);
			if (result.status === "error") {
				ctx.ui.notify(
					`${provider.displayName} account "${result.accountName}" failed closed: ${result.message}`,
					"error",
				);
			}
		}
		updateStatus(ctx, results);
	};

	const accountCommand = createAccountCommand(
		pi,
		store,
		adapters,
		syncProvider,
		() => {
			const generation = sessionGeneration;
			return {
				signal: menuController.signal,
				isCurrent: () =>
					generation === sessionGeneration && !menuController.signal.aborted,
			};
		},
	);
	pi.registerCommand("accounts", accountCommand);

	pi.on("session_start", async (_event, ctx) => {
		sessionGeneration += 1;
		menuController.abort(
			new DOMException("Accounts session replaced", "AbortError"),
		);
		menuController = new AbortController();
		if (migrationNotice) {
			ctx.ui.notify(migrationNotice, "warning");
			migrationNotice = undefined;
		}
		await syncAll(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		const providerId = toProviderId(event.model.provider);
		if (providerId) await syncProvider(providerId, ctx, event.model);
		else updateStatus(ctx, results, event.model);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		abortProviders.clear();
		const providerId = toProviderId(ctx.model?.provider);
		if (!providerId) return;
		try {
			const result = await syncProvider(providerId, ctx);
			const coordinator = coordinators.get(providerId);
			if (result.status === "error") abortProviders.add(providerId);
			if (
				result.status === "active" &&
				ctx.model &&
				coordinator &&
				!coordinator.isModelAvailable(ctx.model.id)
			) {
				abortProviders.add(providerId);
				ctx.ui.notify(
					`${requireAdapter(adapters, providerId).displayName} model ${ctx.model.id} is not available to account "${result.accountName}".`,
					"error",
				);
			}
		} catch (error) {
			abortProviders.add(providerId);
			throw error;
		}
	});

	pi.on("turn_start", (_event, ctx) => {
		const providerId = toProviderId(ctx.model?.provider);
		if (!providerId || !abortProviders.has(providerId)) return;
		abortProviders.delete(providerId);
		ctx.abort();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionGeneration += 1;
		menuController.abort(
			new DOMException("Accounts session shut down", "AbortError"),
		);
		abortProviders.clear();
		await Promise.allSettled(
			[...coordinators.values()].map(async (coordinator) => {
				coordinator.invalidate(ctx);
				await coordinator.clear(ctx);
			}),
		);
		setStatus(ctx, undefined);
	});
}

function createAccountCommand(
	pi: ExtensionAPI,
	store: AccountStore,
	adapters: Map<AccountProviderId, AccountProviderAdapter>,
	syncProvider: (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
	) => Promise<EnsureActiveProviderAuthResult>,
	getMenuOwner: () => { signal: AbortSignal; isCurrent(): boolean },
) {
	return {
		description: "Open the interactive subscription account manager",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await showAccountsMenu(
				pi,
				ctx,
				store,
				adapters,
				syncProvider,
				getMenuOwner(),
			);
		},
	};
}

const LOGIN_ACTION = "Login new account";
const REMOVE_ACTION = "Remove account";
const SWITCH_PROVIDER_ACTION = "Switch provider account";
const SWITCH_ANOTHER_PROVIDER_ACTION = "Switch another provider’s account";

type ProviderMenuState = {
	id: AccountProviderId;
	adapter: AccountProviderAdapter;
	active: string | undefined;
	accounts: Record<string, StoredOAuthCredential>;
};

async function showAccountsMenu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapters: Map<AccountProviderId, AccountProviderAdapter>,
	syncProvider: (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
	) => Promise<EnsureActiveProviderAuthResult>,
	owner: { signal: AbortSignal; isCurrent(): boolean },
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"/accounts requires interactive UI (TUI or RPC mode).",
			"error",
		);
		return;
	}
	while (owner.isCurrent()) {
		const states = await readProviderMenuStates(store, adapters);
		if (!owner.isCurrent()) return;
		const currentProviderId = toProviderId(ctx.model?.provider);
		const currentState = currentProviderId
			? states.get(currentProviderId)
			: undefined;
		const hasAnyStoredAccount = [...states.values()].some(
			(state) => accountNames(state).length > 0,
		);
		const mainItems = buildAccountMainItems(
			states,
			currentState,
			hasAnyStoredAccount,
		);
		const action = await ctx.ui.select(
			formatAccountsMenuTitle(ctx, states, hasAnyStoredAccount).replaceAll(
				"\n  ",
				"\n",
			),
			mainItems.map((item) => item.label),
			{ signal: owner.signal },
		);
		if (action === undefined || !owner.isCurrent()) return;
		const selected = mainItems.find((item) => item.label === action);
		if (!selected) continue;

		if (selected.action === "login-route") {
			const providerName = await ctx.ui.select(
				"Select provider",
				sortedProviderStates(states).map(
					(provider) => provider.adapter.displayName,
				),
				{ signal: owner.signal },
			);
			if (providerName === undefined || !owner.isCurrent()) return;
			const provider = sortedProviderStates(states).find(
				(candidate) => candidate.adapter.displayName === providerName,
			);
			if (!provider) continue;
			const name = await ctx.ui.input(
				`Name this ${provider.adapter.displayName} account:`,
				"work",
				{ signal: owner.signal },
			);
			if (name === undefined || !owner.isCurrent()) return;
			await loginAccount(
				pi,
				ctx,
				store,
				provider.adapter,
				name,
				syncProvider,
				owner.isCurrent,
			);
			return;
		}

		if (
			selected.action === "switch-current" ||
			selected.action === "switch-route"
		) {
			let provider = currentState;
			if (selected.action === "switch-route") {
				const candidates = providerStatesWithAccounts(
					states,
					currentProviderId,
				);
				const providerName = await ctx.ui.select(
					"Select provider",
					candidates.map((candidate) => candidate.adapter.displayName),
					{ signal: owner.signal },
				);
				if (providerName === undefined || !owner.isCurrent()) return;
				provider = candidates.find(
					(candidate) => candidate.adapter.displayName === providerName,
				);
			}
			if (!provider || !owner.isCurrent()) return;
			const accountOptions = switchAccountOptions(
				provider.active,
				Object.keys(provider.accounts),
			);
			const accountOption = await ctx.ui.select(
				`Switch ${provider.adapter.displayName} account`,
				accountOptions,
				{ signal: owner.signal },
			);
			if (accountOption === undefined || !owner.isCurrent()) return;
			const accountName = accountOptions
				.map(stripActiveMarker)
				.find((name) => name === stripActiveMarker(accountOption));
			if (!accountName) return;
			await switchAccount(
				ctx,
				store,
				provider.adapter,
				accountName,
				syncProvider,
			);
			return;
		}

		if (selected.action === "remove-route") {
			const options = removeAccountOptions(states, currentProviderId);
			const accountOption = await ctx.ui.select(
				"Remove account",
				options.map((option) => option.label),
				{ signal: owner.signal },
			);
			if (accountOption === undefined || !owner.isCurrent()) return;
			const option = options.find(
				(candidate) => candidate.label === accountOption,
			);
			if (!option) return;
			const confirmed = await ctx.ui.confirm(
				"Remove account",
				`Remove ${option.adapter.displayName} account "${option.accountName}"?`,
				{ signal: owner.signal },
			);
			if (!confirmed || !owner.isCurrent()) return;
			await removeAccount(
				ctx,
				store,
				option.adapter,
				option.accountName,
				syncProvider,
			);
			return;
		}
	}
}

async function readProviderMenuStates(
	store: AccountStore,
	adapters: Map<AccountProviderId, AccountProviderAdapter>,
): Promise<Map<AccountProviderId, ProviderMenuState>> {
	const states = new Map<AccountProviderId, ProviderMenuState>();
	for (const id of SUPPORTED_PROVIDER_IDS) {
		const state = await store.readProviderAsync(id);
		states.set(id, {
			id,
			adapter: requireAdapter(adapters, id),
			active: state.active,
			accounts: state.accounts,
		});
	}
	return states;
}

function formatAccountsMenuTitle(
	ctx: ExtensionCommandContext,
	states: Map<AccountProviderId, ProviderMenuState>,
	hasAnyStoredAccount: boolean,
): string {
	if (!hasAnyStoredAccount)
		return "Accounts\n\nNo saved accounts yet.\n\nWhat do you want to do?";
	const activeLines = sortedProviderStates(states).map(
		(state) => `  ${state.adapter.displayName}: ${state.active ?? "default"}`,
	);
	return [
		"Accounts",
		"",
		"Current model:",
		`  ${formatCurrentModel(ctx)}`,
		"",
		"Active accounts:",
		...activeLines,
		"",
		"What do you want to do?",
	].join("\n");
}

function formatCurrentModel(ctx: ExtensionCommandContext): string {
	if (!ctx.model) return "(none)";
	const providerId = toProviderId(ctx.model.provider);
	const providerName = providerId
		? providerDisplayName(providerId)
		: ctx.model.provider;
	return `${providerName} / ${ctx.model.id}`;
}

function buildAccountMainItems(
	states: Map<AccountProviderId, ProviderMenuState>,
	currentState: ProviderMenuState | undefined,
	hasAnyStoredAccount: boolean,
): Array<{
	id: string;
	label: string;
	action: "login-route" | "switch-current" | "switch-route" | "remove-route";
}> {
	if (!hasAnyStoredAccount) {
		return [{ id: "login", label: LOGIN_ACTION, action: "login-route" }];
	}
	const currentHasAccounts = currentState
		? accountNames(currentState).length > 0
		: false;
	if (currentState && currentHasAccounts) {
		return [
			{
				id: currentState.id,
				label: switchCurrentProviderAction(currentState.adapter),
				action: "switch-current",
			},
			{ id: "login", label: LOGIN_ACTION, action: "login-route" },
			{ id: "remove", label: REMOVE_ACTION, action: "remove-route" },
			...(providerStatesWithAccounts(states, currentState.id).length > 0
				? [
						{
							id: "switch-other",
							label: SWITCH_ANOTHER_PROVIDER_ACTION,
							action: "switch-route" as const,
						},
					]
				: []),
		];
	}
	return [
		{ id: "login", label: LOGIN_ACTION, action: "login-route" },
		{
			id: "switch-provider",
			label: currentState
				? SWITCH_ANOTHER_PROVIDER_ACTION
				: SWITCH_PROVIDER_ACTION,
			action: "switch-route",
		},
		{ id: "remove", label: REMOVE_ACTION, action: "remove-route" },
	];
}

function switchCurrentProviderAction(adapter: AccountProviderAdapter): string {
	return `Switch ${adapter.displayName} account`;
}

function sortedProviderStates(
	states: Map<AccountProviderId, ProviderMenuState>,
): ProviderMenuState[];
function sortedProviderStates(
	states: readonly ProviderMenuState[],
): ProviderMenuState[];
function sortedProviderStates(
	states:
		| Map<AccountProviderId, ProviderMenuState>
		| readonly ProviderMenuState[],
): ProviderMenuState[] {
	const values = Array.isArray(states) ? [...states] : [...states.values()];
	return values.sort((left, right) =>
		left.adapter.displayName.localeCompare(right.adapter.displayName),
	);
}

function providerStatesWithAccounts(
	states: Map<AccountProviderId, ProviderMenuState>,
	excludeProviderId?: AccountProviderId,
): ProviderMenuState[] {
	return sortedProviderStates(states).filter(
		(state) => state.id !== excludeProviderId && accountNames(state).length > 0,
	);
}

function accountNames(state: ProviderMenuState): string[] {
	return Object.keys(state.accounts).sort();
}

function switchAccountOptions(
	activeName: string | undefined,
	names: string[],
): string[] {
	const active = activeName ?? "default";
	const sortedNames = [...names].sort();
	const options = [formatSwitchAccountOption(active, true)];
	for (const name of sortedNames) {
		if (name !== active) options.push(formatSwitchAccountOption(name, false));
	}
	if (active !== "default")
		options.push(formatSwitchAccountOption("default", false));
	return options;
}

function formatSwitchAccountOption(name: string, active: boolean): string {
	return active ? `✓ ${name}` : name;
}

function stripActiveMarker(value: string): string {
	return value.replace(/^✓\s+/, "");
}

function removeAccountOptions(
	states: Map<AccountProviderId, ProviderMenuState>,
	currentProviderId?: AccountProviderId,
): Array<{
	label: string;
	adapter: AccountProviderAdapter;
	accountName: string;
}> {
	const providerStates = providerStatesWithAccounts(states);
	if (currentProviderId) {
		const currentIndex = providerStates.findIndex(
			(state) => state.id === currentProviderId,
		);
		if (currentIndex > 0) {
			const [current] = providerStates.splice(currentIndex, 1);
			if (current) providerStates.unshift(current);
		}
	}
	return providerStates.flatMap((state) =>
		accountNames(state).map((accountName) => ({
			label: `${state.adapter.displayName} · ${accountName}`,
			adapter: state.adapter,
			accountName,
		})),
	);
}

function providerDisplayName(providerId: AccountProviderId): string {
	switch (providerId) {
		case "anthropic":
			return "Anthropic";
		case "github-copilot":
			return "GitHub Copilot";
		case "openai-codex":
			return "OpenAI Codex";
	}
}

async function loginAccount(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapter: AccountProviderAdapter,
	nameArg: string,
	syncProvider: (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
	) => Promise<EnsureActiveProviderAuthResult>,
	isCurrent: () => boolean,
): Promise<void> {
	const parsed = parseAccountName(nameArg);
	if (!parsed.ok) return ctx.ui.notify(parsed.error, "warning");
	if (isDefaultPiLoginArg(parsed.name)) {
		ctx.ui.notify('"default" is reserved for Pi\'s built-in login.', "warning");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("Account login requires interactive UI.", "error");
		return;
	}
	const state = await store.readProviderAsync(adapter.id);
	if (!isCurrent()) return;
	if (getOwnCredential(state.accounts, parsed.name)) {
		const confirmed = await ctx.ui.confirm(
			"Replace account",
			`${adapter.displayName} account "${parsed.name}" already exists. Replace it?`,
		);
		if (!confirmed || !isCurrent()) return;
	}
	ctx.ui.notify(
		`Starting ${adapter.displayName} login for "${parsed.name}".`,
		"info",
	);
	try {
		const credential = normalizeStoredCredential(
			await adapter.oauth.login(
				createOAuthInteraction(ctx, adapter.displayName),
			),
			parsed.name,
		);
		if (!isCurrent()) return;
		await store.updateProvider(adapter.id, (state) =>
			isCurrent()
				? {
						active: parsed.name,
						accounts: defineOwn(state.accounts, parsed.name, credential),
					}
				: state,
		);
		if (!isCurrent()) return;
		const result = await syncProvider(adapter.id, ctx);
		if (!isCurrent()) return;
		await selectDefaultModelIfUnknown(pi, ctx, adapter);
		if (!isCurrent()) return;
		ctx.ui.notify(
			formatActivationMessage("Logged in", adapter, parsed.name, result),
			result.status === "active" ? "info" : "error",
		);
	} catch (error) {
		if (!isCurrent()) return;
		ctx.ui.notify(
			`${adapter.displayName} login failed: ${redactTokenText(errorMessage(error))}`,
			"error",
		);
	}
}

async function switchAccount(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapter: AccountProviderAdapter,
	nameArg: string,
	syncProvider: (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
	) => Promise<EnsureActiveProviderAuthResult>,
): Promise<void> {
	const name = nameArg.trim();
	if (!name) {
		ctx.ui.notify(
			`Select a ${adapter.displayName} account from /accounts.`,
			"warning",
		);
		return;
	}
	if (isDefaultPiLoginArg(name)) {
		await store.updateProvider(adapter.id, (state) => ({
			accounts: defineOwnMap(state.accounts),
		}));
		const result = await syncProvider(adapter.id, ctx);
		if (result.status === "error") {
			ctx.ui.notify(
				`Could not restore default Pi ${adapter.displayName} login; requests will fail closed: ${result.message}`,
				"error",
			);
			return;
		}
		ctx.ui.notify(`Using default Pi ${adapter.displayName} login.`, "info");
		return;
	}
	const parsed = parseAccountName(name);
	if (!parsed.ok) return ctx.ui.notify(parsed.error, "warning");
	let found = false;
	await store.updateProvider(adapter.id, (state) => {
		if (!getOwnCredential(state.accounts, parsed.name)) return state;
		found = true;
		return { ...state, active: parsed.name };
	});
	if (!found) {
		ctx.ui.notify(
			`${adapter.displayName} account "${parsed.name}" was not found.`,
			"warning",
		);
		return;
	}
	const result = await syncProvider(adapter.id, ctx);
	ctx.ui.notify(
		formatActivationMessage("Activated", adapter, parsed.name, result),
		result.status === "active" ? "info" : "error",
	);
}

async function removeAccount(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapter: AccountProviderAdapter,
	nameArg: string,
	syncProvider: (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
	) => Promise<EnsureActiveProviderAuthResult>,
): Promise<void> {
	const parsed = parseAccountName(nameArg);
	if (!parsed.ok) return ctx.ui.notify(parsed.error, "warning");
	let removed = false;
	let removedActive = false;
	await store.updateProvider(adapter.id, (state) => {
		if (!getOwnCredential(state.accounts, parsed.name)) return state;
		removed = true;
		removedActive = state.active === parsed.name;
		const accounts = defineOwnMap(state.accounts);
		delete accounts[parsed.name];
		return removedActive || state.active === undefined
			? { accounts }
			: { active: state.active, accounts };
	});
	if (!removed) {
		ctx.ui.notify(
			`${adapter.displayName} account "${parsed.name}" was not found.`,
			"warning",
		);
		return;
	}
	if (removedActive) {
		const result = await syncProvider(adapter.id, ctx);
		if (result.status === "error") {
			ctx.ui.notify(
				`Removed ${adapter.displayName} account "${parsed.name}", but default auth restoration failed closed: ${result.message}`,
				"error",
			);
			return;
		}
	}
	ctx.ui.notify(
		`Removed ${adapter.displayName} account "${parsed.name}".`,
		"info",
	);
}

function validateProviderSet(
	providers: readonly AccountProviderAdapter[],
): void {
	const ids = new Set<AccountProviderId>();
	for (const provider of providers) {
		if (ids.has(provider.id))
			throw new Error(`Duplicate account provider: ${provider.id}`);
		ids.add(provider.id);
	}
	for (const id of SUPPORTED_PROVIDER_IDS) {
		if (!ids.has(id))
			throw new Error(`Missing required account provider: ${id}`);
	}
}

function requireAdapter(
	adapters: Map<AccountProviderId, AccountProviderAdapter>,
	providerId: AccountProviderId,
): AccountProviderAdapter {
	const adapter = adapters.get(providerId);
	if (!adapter) throw new Error(`Unsupported account provider: ${providerId}`);
	return adapter;
}

function toProviderId(
	value: string | undefined,
): AccountProviderId | undefined {
	return value && isAccountProviderId(value) ? value : undefined;
}

function isAccountProviderId(value: string): value is AccountProviderId {
	return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value);
}

function isDefaultPiLoginArg(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return (
		normalized === "default" ||
		normalized === "--default" ||
		normalized === DEFAULT_PI_LOGIN_LABEL
	);
}

function formatActivationMessage(
	action: "Logged in" | "Activated",
	adapter: AccountProviderAdapter,
	name: string,
	result: EnsureActiveProviderAuthResult,
): string {
	if (
		result.status !== "inactive" &&
		result.accountName !== "unknown" &&
		result.accountName !== name
	) {
		return `${action} ${adapter.displayName} account "${name}" was superseded by "${result.accountName}" before activation.`;
	}
	if (result.status === "error") {
		return `${action} ${adapter.displayName} account "${name}", but authentication failed; requests will fail closed: ${result.message}`;
	}
	if (result.status === "inactive") {
		return `${action} ${adapter.displayName} account "${name}" was superseded before activation.`;
	}
	return `${action} ${adapter.displayName} account "${name}".`;
}

async function selectedCredential(
	store: AccountStore,
	providerId: AccountProviderId,
	result: EnsureActiveProviderAuthResult,
): Promise<StoredOAuthCredential | undefined> {
	if (result.status === "inactive") return undefined;
	try {
		const state = await store.readProviderAsync(providerId);
		return getOwnCredential(state.accounts, result.accountName);
	} catch {
		return undefined;
	}
}

async function authIdentity(
	store: AccountStore,
	result: EnsureActiveProviderAuthResult,
): Promise<string> {
	if (result.status === "inactive") return "default";
	if (result.status === "error") return `error:${result.accountName}`;
	const state = await store.readProviderAsync(result.providerId);
	return `${result.accountName}:${getOwnCredential(state.accounts, result.accountName)?.access ?? "missing"}`;
}

function updateStatus(
	ctx: ExtensionContext,
	results: Map<AccountProviderId, EnsureActiveProviderAuthResult>,
	model = ctx.model,
): void {
	const providerId = toProviderId(model?.provider);
	const result = providerId ? results.get(providerId) : undefined;
	if (!result || result.status === "inactive") {
		setStatus(ctx, undefined);
		return;
	}
	if (result.status === "active") {
		setStatus(ctx, `account:${result.accountName}`);
		return;
	}
	setStatus(ctx, `account:${result.accountName} auth error`);
}

function setStatus(ctx: ExtensionContext, value: string | undefined): void {
	try {
		ctx.ui.setStatus(ACCOUNTS_STATUS_KEY, value);
	} catch (error) {
		if (!isStaleContextError(error)) throw error;
	}
}

async function selectDefaultModelIfUnknown(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	adapter: AccountProviderAdapter,
): Promise<void> {
	if (!adapter.defaultModelId || !isUnknownModel(ctx.model)) return;
	const model = ctx.modelRegistry.find(adapter.id, adapter.defaultModelId);
	if (!model) {
		ctx.ui.notify(
			`Logged in, but ${adapter.id}/${adapter.defaultModelId} was not found.`,
			"warning",
		);
		return;
	}
	if (!(await pi.setModel(model))) {
		ctx.ui.notify(
			`Logged in, but selecting ${adapter.defaultModelId} failed.`,
			"warning",
		);
	}
}

function isUnknownModel(
	model: NonNullable<ExtensionContext["model"]> | undefined,
): boolean {
	return (
		model?.provider === "unknown" &&
		model.id === "unknown" &&
		model.api === "unknown"
	);
}

function isStaleContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes(
			"This extension ctx is stale after session replacement or reload",
		)
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
