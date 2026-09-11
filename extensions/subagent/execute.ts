import { readFileSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultPackageManager,
	DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	loadSkills,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
	type Skill,
	stripFrontmatter,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { generationEntryOffsets, readSavedSession } from "./checkpoint.js";
import {
	Conversation,
	completedGeneration,
	errorGeneration,
	type Generation,
	type GenerationSnapshot,
	interruptedGeneration,
	skippedGeneration,
} from "./conversation.js";
import { timingAsync } from "./timing.js";

const ownExtensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));

export async function discoverInheritedExtensionPaths(
	cwd: string,
	agentDir: string,
): Promise<string[]> {
	const resolved = await discoverInheritedResourcePaths(cwd, agentDir);
	const ownCanonicalPath = await canonicalPath(ownExtensionPath);
	const seen = new Set<string>();
	const inherited: string[] = [];

	for (const entry of resolved.extensions) {
		if (!entry.enabled) continue;
		const canonical = await canonicalPath(entry.path);
		if (canonical === ownCanonicalPath || seen.has(canonical)) continue;
		seen.add(canonical);
		inherited.push(entry.path);
	}

	return inherited;
}

export async function discoverInheritedSkillPaths(
	cwd: string,
	agentDir: string = getAgentDir(),
): Promise<string[]> {
	const resolved = await discoverInheritedResourcePaths(cwd, agentDir);
	return resolved.skills
		.filter((entry) => entry.enabled)
		.map((entry) => entry.path);
}

async function discoverInheritedResourcePaths(cwd: string, agentDir: string) {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	await settingsManager.reload();

	const packageManager = new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager,
	});
	return packageManager.resolve();
}

async function canonicalPath(file: string): Promise<string> {
	try {
		return await realpath(file);
	} catch {
		return path.resolve(file);
	}
}

export interface ExecuteGenerationDependencies {
	ResourceLoader: typeof DefaultResourceLoader;
	getAgentDir: typeof getAgentDir;
	createAgentSession: typeof createAgentSession;
	sessionManager: typeof SessionManager.inMemory;
	settingsManager: typeof SettingsManager.create;
	loadSkills: typeof loadSkills;
	readSkillFile: typeof readFileSync;
	loadExtensionPaths: (cwd: string, agentDir: string) => Promise<string[]>;
	childToolsFor?: (agent: Conversation) => readonly ToolDefinition[];
	childSessionEvent?: (
		agent: Conversation,
		generation: Generation,
		event: AgentSessionEvent,
	) => void;
}

export const DEFAULT_EXECUTE_GENERATION_DEPENDENCIES: ExecuteGenerationDependencies =
	{
		ResourceLoader: DefaultResourceLoader,
		getAgentDir,
		createAgentSession,
		sessionManager: SessionManager.inMemory,
		settingsManager: SettingsManager.create,
		loadSkills,
		readSkillFile: readFileSync,
		loadExtensionPaths: discoverInheritedExtensionPaths,
	};

export async function executeGeneration(
	ctx: ExtensionContext,
	agent: Conversation,
	generation: Generation,
	signal?: AbortSignal,
	dependencies: ExecuteGenerationDependencies = DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
): Promise<GenerationSnapshot> {
	if (generation.kind === "resume") {
		const session = agent.sessionForResume();
		if (!session && !agent.sessionFileForResume) {
			throw new Error(`Cannot resume an agent without a conversation session.`);
		}
		if (session) {
			agent.bindSession(generation, session);
			return promptAgent(
				session,
				agent,
				generation,
				signal,
				dependencies.childSessionEvent,
			);
		}
	}

	if (signal?.aborted) return skippedGeneration(agent, generation);

	const generationData = {
		agent: agent.agentName,
		conversationId: agent.conversationId,
		parentConversationId: agent.parentConversationId,
		spawnedInGeneration: agent.spawnedInGeneration,
	};
	const requestedConfig =
		generation.kind === "resume"
			? (agent.snapshot().effectiveConfig ?? agent.requestedConfig)
			: agent.requestedConfig;
	const cwdResolution = resolveTaskCwd(ctx.cwd, requestedConfig.cwd);
	if (!cwdResolution.ok)
		return errorGeneration(agent, generation, cwdResolution.error);
	const modelResolution = resolveModel(
		requestedConfig.model,
		ctx.model,
		ctx.modelRegistry,
	);
	if (!modelResolution.ok)
		return errorGeneration(agent, generation, modelResolution.error);

	const cwd = cwdResolution.value;
	const selectedModel = modelResolution.value;
	const agentDir = dependencies.getAgentDir();

	const requestedSkills = requestedConfig.skills ?? [];
	let skillBlocks = agent.resolvedSkillBlocks;
	if (skillBlocks === undefined) {
		const skillResolution = resolveRequestedSkills(
			cwd,
			requestedSkills,
			dependencies,
		);
		if (!skillResolution.ok)
			return errorGeneration(agent, generation, skillResolution.error);
		skillBlocks = skillResolution.value;
	}
	let systemPrompt = agent.definition.systemPrompt;
	if (skillBlocks.length > 0) {
		systemPrompt = `${systemPrompt}\n\n${skillBlocks.join("\n\n")}`;
	}

	const inheritedExtensionPaths = await dependencies.loadExtensionPaths(
		cwd,
		agentDir,
	);
	const childTools = dependencies.childToolsFor?.(agent) ?? [];

	const resourceLoader = new dependencies.ResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		additionalExtensionPaths: inheritedExtensionPaths,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
	});

	await timingAsync(
		"generation.resourceLoader.reload",
		{ ...generationData, cwd },
		() => resourceLoader.reload(),
	);
	if (signal?.aborted) return skippedGeneration(agent, generation);

	const requestedThinking = requestedConfig.thinking;
	const savedFile =
		generation.kind === "resume" ? agent.sessionFileForResume : undefined;
	if (savedFile) {
		const checkpoint = agent.checkpoint();
		const saved = readSavedSession(savedFile, checkpoint.sessionId);
		generationEntryOffsets(saved.getEntries(), checkpoint.generations);
	}
	const sessionManager = savedFile
		? SessionManager.open(savedFile)
		: agent.saveSessions
			? SessionManager.create(
					cwd,
					path.join(
						agentDir,
						"subagent",
						"sessions",
						agent.rootSessionId ?? ctx.sessionManager.getSessionId(),
					),
				)
			: dependencies.sessionManager(cwd);
	const settingsManager = dependencies.settingsManager(cwd, agentDir);
	const sessionOptions = {
		cwd,
		agentDir,
		resourceLoader,
		customTools: [...childTools],
		sessionManager,
		settingsManager,
		...(selectedModel ? { model: selectedModel } : {}),
		...(requestedThinking ? { thinkingLevel: requestedThinking } : {}),
		...(requestedConfig.tools
			? { tools: [...new Set([...requestedConfig.tools, "load_skill"])] }
			: {}),
	};
	const { session } = await timingAsync(
		"generation.createAgentSession",
		{
			...generationData,
			cwd,
			model: selectedModel
				? `${selectedModel.provider}/${selectedModel.id}`
				: undefined,
		},
		() => dependencies.createAgentSession(sessionOptions),
	);

	// Loading extensions does not emit session_start. Auth must be ready before
	// prompt() performs its preflight check, which precedes before_agent_start.
	try {
		let startupFailed = false;
		await session.bindExtensions({
			mode: "print",
			onError: () => {
				startupFailed = true;
			},
		});
		if (startupFailed) throw new Error("Child extension startup failed.");
	} catch (error) {
		await session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "quit",
		});
		session.dispose();
		throw error;
	}

	const effectiveModel = session.model ?? selectedModel;
	const effectiveThinking = session.thinkingLevel ?? requestedThinking;
	const activeTools =
		typeof session.getActiveToolNames === "function"
			? session.getActiveToolNames()
			: (requestedConfig.tools ?? []);
	agent.setEffectiveConfig({
		...(effectiveModel
			? { model: `${effectiveModel.provider}/${effectiveModel.id}` }
			: {}),
		...(effectiveThinking
			? { thinking: effectiveThinking as ModelThinkingLevel }
			: {}),
		cwd,
		skills: requestedSkills,
		tools: activeTools,
	});

	if (signal?.aborted) {
		await AbortSession(session);
		await session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "quit",
		});
		session.dispose();
		return skippedGeneration(agent, generation);
	}

	agent.bindSession(generation, session);
	return promptAgent(
		session,
		agent,
		generation,
		signal,
		dependencies.childSessionEvent,
	);
}

async function promptAgent(
	session: AgentSession,
	agent: Conversation,
	generation: Generation,
	signal?: AbortSignal,
	onSessionEvent?: (
		agent: Conversation,
		generation: Generation,
		event: AgentSessionEvent,
	) => void,
): Promise<GenerationSnapshot> {
	const prompt = generation.prompt;
	const onAbort = () => {
		void AbortSession(session);
	};

	if (signal?.aborted) {
		await AbortSession(session);
		return interruptedGeneration(agent, generation, "Agent interrupted.");
	}

	signal?.addEventListener("abort", onAbort, { once: true });
	const unsubscribe = onSessionEvent
		? session.subscribe((event) => onSessionEvent(agent, generation, event))
		: undefined;

	try {
		await timingAsync(
			"generation.session.prompt",
			{
				agent: agent.agentName,
				conversationId: agent.conversationId,
				promptLength: prompt.length,
			},
			() => session.prompt(prompt),
		);
		const finalMessage = GetFinalAssistantMessage(session);
		if (finalMessage.stopReason === "aborted") {
			return interruptedGeneration(
				agent,
				generation,
				finalMessage.errorMessage || "Agent interrupted.",
			);
		}
		if (finalMessage.stopReason === "error") {
			return errorGeneration(
				agent,
				generation,
				finalMessage.errorMessage || finalMessage.response || "Agent failed.",
			);
		}

		return completedGeneration(agent, generation, finalMessage.response);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return signal?.aborted
			? interruptedGeneration(agent, generation, message)
			: errorGeneration(agent, generation, message);
	} finally {
		unsubscribe?.();
		signal?.removeEventListener("abort", onAbort);
	}
}

async function AbortSession(session: AgentSession) {
	await Promise.resolve(session.abort()).catch(() => undefined);
}

export type GenerationExecutionResolution<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: string };

type SkillResolutionDependencies = Pick<
	ExecuteGenerationDependencies,
	"getAgentDir" | "loadSkills" | "readSkillFile"
>;

export interface SkillCatalog {
	readonly skills: readonly Skill[];
	readonly error?: string;
}

export function discoverSkillCatalog(
	cwd: string,
	dependencies: SkillResolutionDependencies = DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
	skillPaths: readonly string[] = [],
): SkillCatalog {
	try {
		const agentDir = dependencies.getAgentDir();
		return {
			skills: dependencies.loadSkills({
				cwd,
				agentDir,
				skillPaths: [...skillPaths],
				includeDefaults: true,
			}).skills,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			skills: [],
			error: `Could not discover requested skills: ${message}`,
		};
	}
}

export function mergeSkillCatalogs(
	...catalogs: readonly SkillCatalog[]
): SkillCatalog {
	const skills: Skill[] = [];
	const names = new Set<string>();
	for (const catalog of catalogs) {
		for (const skill of catalog.skills) {
			if (names.has(skill.name)) continue;
			names.add(skill.name);
			skills.push(skill);
		}
	}
	const error = catalogs.find((catalog) => catalog.error)?.error;
	return { skills, ...(error ? { error } : {}) };
}

export function loadSkillFromCatalog(
	catalog: SkillCatalog,
	name: string,
	dependencies: Pick<
		SkillResolutionDependencies,
		"readSkillFile"
	> = DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
): GenerationExecutionResolution<string> {
	const found = catalog.skills.find((skill) => skill.name === name);
	if (!found)
		return {
			ok: false,
			error: catalog.error ?? `Unknown skill: ${name}`,
		};

	try {
		const content = dependencies.readSkillFile(found.filePath, "utf-8");
		const body = stripFrontmatter(content).trim();
		return {
			ok: true,
			value: `<skill name="${found.name}" location="${found.filePath}">\nReferences are relative to ${found.baseDir}.\n\n${body}\n</skill>`,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Could not load requested skill: ${message}` };
	}
}

export function resolveRequestedSkillsFromCatalog(
	requestedSkills: readonly string[],
	catalog: SkillCatalog,
	dependencies: Pick<
		SkillResolutionDependencies,
		"readSkillFile"
	> = DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
): GenerationExecutionResolution<readonly string[]> {
	const blocks: string[] = [];
	for (const name of requestedSkills) {
		const loaded = loadSkillFromCatalog(catalog, name, dependencies);
		if (!loaded.ok) return loaded;
		blocks.push(loaded.value);
	}
	return { ok: true, value: blocks };
}

export function resolveRequestedSkills(
	cwd: string,
	requestedSkills: readonly string[],
	dependencies: SkillResolutionDependencies = DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
	skillPaths: readonly string[] = [],
): GenerationExecutionResolution<readonly string[]> {
	if (requestedSkills.length === 0) return { ok: true, value: [] };
	return resolveRequestedSkillsFromCatalog(
		requestedSkills,
		discoverSkillCatalog(cwd, dependencies, skillPaths),
		dependencies,
	);
}

export function resolveTaskCwd(
	parentCwd: string,
	requestedCwd: string | undefined,
): GenerationExecutionResolution<string> {
	if (requestedCwd === undefined) return { ok: true, value: parentCwd };

	const cwd = path.resolve(parentCwd, requestedCwd);
	try {
		if (!statSync(cwd).isDirectory()) {
			return {
				ok: false,
				error: `Working directory is not a directory: ${cwd}`,
			};
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT")
			return { ok: false, error: `Working directory does not exist: ${cwd}` };
		if (code === "ENOTDIR")
			return {
				ok: false,
				error: `Working directory is not a directory: ${cwd}`,
			};
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: `Could not access working directory ${cwd}: ${message}`,
		};
	}

	return { ok: true, value: cwd };
}

export function resolveModel(
	requestedModel: string | undefined,
	parentModel: Model<any> | undefined,
	registry: ModelRegistry,
): GenerationExecutionResolution<Model<any> | undefined> {
	if (requestedModel === undefined) return { ok: true, value: parentModel };

	const parts = requestedModel.split("/");
	if (parts.some((part) => part.trim().length === 0)) {
		return {
			ok: false,
			error: `Invalid model "${requestedModel}": model references cannot be blank or contain empty slash-delimited parts.`,
		};
	}

	const models = registry.getAll();
	const canonical = models.find(
		(model) => `${model.provider}/${model.id}` === requestedModel,
	);
	if (canonical) return { ok: true, value: canonical };

	const candidates = models.filter((model) => model.id === requestedModel);
	const sameProvider = candidates.find(
		(model) => model.provider === parentModel?.provider,
	);
	if (sameProvider) return { ok: true, value: sameProvider };
	if (candidates.length === 1) return { ok: true, value: candidates[0] };
	if (candidates.length > 1) {
		const matches = candidates
			.map((model) => `${model.provider}/${model.id}`)
			.join(", ");
		return {
			ok: false,
			error: `Ambiguous model "${requestedModel}": matches ${matches}. Use a provider-qualified model reference.`,
		};
	}

	return { ok: false, error: `Unknown model: ${requestedModel}` };
}

function GetFinalAssistantMessage(session: AgentSession): {
	response: string;
	stopReason?: string;
	errorMessage?: string;
} {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const msg = session.messages[i];
		if (!msg || msg.role !== "assistant") continue;
		const assistant = msg as {
			content: readonly { type: string; text?: string }[];
			stopReason?: string;
			errorMessage?: string;
		};
		{
			return {
				response:
					assistant.content
						.filter((part) => part.type === "text")
						.map((part) => part.text ?? "")
						.join("\n")
						.trim() ?? "",
				...(assistant.stopReason !== undefined
					? { stopReason: assistant.stopReason }
					: {}),
				...(assistant.errorMessage !== undefined
					? { errorMessage: assistant.errorMessage }
					: {}),
			};
		}
	}
	return { response: "" };
}
