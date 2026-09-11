import type { Usage } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentSessionEvent,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	GenerationActivity,
	type GenerationActivityListener,
} from "./activity.js";
import type {
	AgentDefinition,
	AgentDefinitionSummary,
	EffectiveExecutionConfig,
	ExecutionOverrides,
	RequestedExecutionConfig,
} from "./agents.js";
import { resolveRequestedConfig, summarizeAgentDefinition } from "./agents.js";
import {
	type ConversationCheckpoint,
	generationEntryOffsets,
} from "./checkpoint.js";
import type { ConversationId } from "./identifiers.js";
import { isConversationId } from "./identifiers.js";
import type { SpawnRequest } from "./schema.js";
import type { TranscriptEntry } from "./transcript.js";

export type GenerationKind = "spawn" | "resume";
export type GenerationInitiator = "user" | "model";
export type CollectionAudience = "user" | "model";
export interface CollectionReceipts {
	readonly user: boolean;
	readonly model: boolean;
}

export const GENERATION_OUTCOME_STATUSES = [
	"completed",
	"error",
	"aborted",
	"interrupted",
	"skipped",
] as const;
export const GENERATION_STATUSES = [
	"queued",
	"running",
	...GENERATION_OUTCOME_STATUSES,
] as const;
export type GenerationOutcomeStatus =
	(typeof GENERATION_OUTCOME_STATUSES)[number];
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export class GenerationSteerError extends Error {
	readonly generation: number;
	readonly status: GenerationStatus | "stopping";

	constructor(generation: number, status: GenerationStatus | "stopping") {
		super(`Generation ${generation} is ${status} and cannot be steered.`);
		this.generation = generation;
		this.status = status;
	}
}

export type ConversationUpdateKind =
	| "status"
	| "message"
	| "tool"
	| "turn"
	| "usage"
	| "compaction"
	| "collection"
	| "activeCollection"
	| "nestedJoin"
	| "steer"
	| "phase"
	| "removed";

export type SteerState = "queued" | "delivered" | "processed" | "discarded";
export interface SteerReceipt {
	readonly id: number;
	readonly state: SteerState;
	readonly acceptedAt: number;
	readonly deliveredAt?: number;
	readonly processedAt?: number;
}
interface TrackedSteerReceipt extends SteerReceipt {
	deliveryText: string;
	sentBy: GenerationInitiator;
	state: SteerState;
	deliveredAt?: number;
	processedAt?: number;
}

export type GenerationPhase =
	| "starting"
	| "thinking"
	| "processing_steer"
	| "responding"
	| "executing_tool"
	| "settling";
export interface GenerationToolUse {
	readonly id: string;
	readonly name: string;
	readonly startedAt: number;
	readonly completedAt?: number;
	readonly isError?: boolean;
	readonly inputSummary?: string;
}
export interface GenerationActivitySnapshot {
	readonly transcript?: readonly TranscriptEntry[];
	readonly phase: GenerationPhase;
	readonly messageSnippet?: string;
	readonly turns: number;
	readonly compactions: number;
	readonly toolHistory: readonly GenerationToolUse[];
}
export type GenerationViewStatus =
	| { readonly kind: "queued"; readonly queuedAt: number }
	| { readonly kind: "running"; readonly startedAt: number }
	| {
			readonly kind: "done";
			readonly outcome: GenerationOutcomeStatus;
			readonly completedAt: number;
			readonly startedAt?: number;
			readonly output?: string;
			readonly error?: string;
	  };

export interface GenerationRef {
	readonly conversationId: ConversationId;
	readonly generation: number;
}

/** The canonical scalar encoding of a GenerationRef for use as a map or set key. */
export function generationKey(reference: GenerationRef): string {
	return JSON.stringify([reference.conversationId, reference.generation]);
}

export function parseGenerationKey(key: string): GenerationRef {
	const [conversationId, generation] = JSON.parse(key) as [
		ConversationId,
		number,
	];
	return { conversationId, generation };
}

export type NestedJoinAttemptState =
	| "running"
	| "completed"
	| "failed"
	| "interrupted";
export interface NestedJoinTargetSnapshot extends GenerationRef {
	readonly status?: GenerationStatus;
}
export interface NestedJoinAttemptSnapshot {
	readonly toolCallId?: string;
	readonly targets: readonly NestedJoinTargetSnapshot[];
	readonly state: NestedJoinAttemptState;
	readonly startedAt: number;
	readonly completedAt?: number;
	readonly error?: string;
}

export interface GenerationSnapshot {
	readonly restored?: true;
	readonly generation: number;
	readonly kind: GenerationKind;
	readonly initiatedBy: GenerationInitiator;
	readonly startedInParentGeneration?: number;
	readonly prompt: string;
	readonly createdAt: number;
	readonly status: GenerationViewStatus;
	readonly activity: GenerationActivitySnapshot;
	/** Cumulative reported model cost for this generation. */
	readonly cost: Usage["cost"];
	/** Latest assistant-call usage, used for current context metrics. */
	readonly usage: Usage;
	readonly activeCollectionCount: number;
	readonly receipts: CollectionReceipts;
	readonly nestedJoins?: readonly NestedJoinAttemptSnapshot[];
	readonly steers: readonly SteerReceipt[];
}
export interface ConversationSnapshot {
	readonly restorationError?: string;
	readonly sessionFile?: string;
	readonly conversationId: ConversationId;
	readonly parentConversationId?: ConversationId;
	readonly spawnedInGeneration?: number;
	readonly label: string;
	readonly createdAt: number;
	readonly agent: AgentDefinitionSummary;
	readonly requestedConfig: RequestedExecutionConfig;
	/** Cumulative reported model cost across this conversation's generations. */
	readonly cost: Usage["cost"];
	readonly generations: readonly GenerationSnapshot[];
	readonly currentGeneration?: GenerationSnapshot;
	readonly resumeAllowed: boolean;
	readonly isStopping?: true;
	readonly effectiveConfig?: EffectiveExecutionConfig;
	readonly requestedOverrides?: ExecutionOverrides;
}

export type GenerationState =
	| { readonly kind: "queued" }
	| {
			readonly kind: "running";
			readonly session: AgentSession;
			readonly startedAt: number;
	  }
	| {
			readonly kind: "done";
			readonly outcome: GenerationOutcomeStatus;
			readonly startedAt?: number;
			readonly completedAt: number;
			readonly output?: string;
			readonly error?: string;
	  };

/** One append-only execution generation within a conversation. Object identity is its exact internal key. */
export class Generation {
	createdAt = Date.now();
	restored = false;
	entryStart: string | null = null;
	readonly activity: GenerationActivity;
	readonly number: number;
	readonly prompt: string;
	readonly initiatedBy: GenerationInitiator;
	private readonly onChange: GenerationActivityListener;
	readonly startedInParentGeneration: number | undefined;
	state: GenerationState = { kind: "queued" };
	activeCollectionCount = 0;
	readonly receipts: { user: boolean; model: boolean } = {
		user: false,
		model: false,
	};
	readonly nestedJoins: Array<{
		toolCallId?: string;
		targets: NestedJoinTargetSnapshot[];
		state: NestedJoinAttemptState;
		startedAt: number;
		completedAt?: number;
		error?: string;
	}> = [];
	readonly steers: TrackedSteerReceipt[] = [];
	sessionMessageStart = 0;
	private modelSubscribed: boolean;

	constructor(
		number: number,
		prompt: string,
		initiatedBy: GenerationInitiator,
		onChange: GenerationActivityListener,
		startedInParentGeneration?: number,
	) {
		this.number = number;
		this.prompt = prompt;
		this.initiatedBy = initiatedBy;
		this.modelSubscribed = initiatedBy === "model";
		this.onChange = onChange;
		this.startedInParentGeneration = startedInParentGeneration;
		if (!Number.isSafeInteger(number) || number < 1)
			throw new Error(`Invalid generation number: ${number}.`);
		if (
			startedInParentGeneration !== undefined &&
			(!Number.isSafeInteger(startedInParentGeneration) ||
				startedInParentGeneration < 1)
		) {
			throw new Error(
				`Invalid parent generation number: ${startedInParentGeneration}.`,
			);
		}
		this.activity = new GenerationActivity(onChange, (event) =>
			this.handleSessionEvent(event),
		);
	}

	get kind(): GenerationKind {
		return this.number === 1 ? "spawn" : "resume";
	}
	get isModelSubscribed(): boolean {
		return this.modelSubscribed;
	}
	subscribeModel(): void {
		this.modelSubscribed = true;
	}

	attach(session: AgentSession): void {
		if (this.state.kind !== "queued")
			throw new Error(
				`Cannot attach a session to a generation that is ${this.state.kind}.`,
			);
		this.sessionMessageStart = Array.isArray(session.messages)
			? session.messages.length
			: 0;
		this.entryStart = session.sessionManager?.getLeafId() ?? null;
		this.state = { kind: "running", session, startedAt: Date.now() };
	}

	acceptSteer(deliveryText: string, sentBy: GenerationInitiator): SteerReceipt {
		const state: SteerState =
			this.state.kind === "running" ? "queued" : "discarded";
		const receipt: TrackedSteerReceipt = {
			id: this.steers.length + 1,
			state,
			acceptedAt: Date.now(),
			deliveryText,
			sentBy,
		};
		this.steers.push(receipt);
		return projectSteer(receipt);
	}

	private handleSessionEvent(
		event: AgentSessionEvent,
	): GenerationPhase | undefined {
		if (event.type !== "message_start") return;
		if (event.message.role === "user") {
			const text = messageText(event.message.content);
			const receipt = this.steers.find(
				(steer) => steer.state === "queued" && steer.deliveryText === text,
			);
			if (!receipt) return;
			receipt.state = "delivered";
			receipt.deliveredAt = Date.now();
			this.onChange("steer");
			return "processing_steer";
		}
		if (event.message.role !== "assistant") return;
		const delivered = this.steers.filter(
			(steer) => steer.state === "delivered",
		);
		if (!delivered.length) return;
		const processedAt = Date.now();
		for (const receipt of delivered) {
			receipt.state = "processed";
			receipt.processedAt = processedAt;
		}
		this.onChange("steer");
		return "responding";
	}

	beginNestedJoin(
		targets: readonly GenerationRef[],
		toolCallId?: string,
	): number {
		this.nestedJoins.push({
			...(toolCallId ? { toolCallId } : {}),
			targets: targets.map((target) => ({ ...target })),
			state: "running",
			startedAt: Date.now(),
		});
		return this.nestedJoins.length - 1;
	}

	updateNestedJoin(
		index: number,
		update: {
			targets?: readonly NestedJoinTargetSnapshot[];
			state?: NestedJoinAttemptState;
			error?: string;
		},
	): void {
		const attempt = this.nestedJoins[index];
		if (!attempt || attempt.state !== "running") return;
		if (update.targets)
			attempt.targets = update.targets.map((target) => ({ ...target }));
		if (update.state) attempt.state = update.state;
		if (update.error !== undefined) attempt.error = update.error;
		if (update.state && update.state !== "running")
			attempt.completedAt = Date.now();
	}

	settle(
		outcome: GenerationOutcomeStatus,
		details: { readonly output?: string; readonly error?: string } = {},
	): boolean {
		if (this.state.kind === "done") return false;
		for (const receipt of this.steers)
			if (receipt.state === "queued" || receipt.state === "delivered")
				receipt.state = "discarded";
		const startedAt =
			this.state.kind === "running" ? this.state.startedAt : undefined;
		this.state = Object.freeze({
			kind: "done",
			outcome,
			...details,
			...(startedAt !== undefined ? { startedAt } : {}),
			completedAt: Date.now(),
		});
		return true;
	}
}

export function completedGeneration(
	conversation: Conversation,
	generation: Generation,
	output: string,
): GenerationSnapshot {
	return conversation.settle(generation, "completed", { output });
}
export function errorGeneration(
	conversation: Conversation,
	generation: Generation,
	error: string,
): GenerationSnapshot {
	return conversation.settle(generation, "error", { error });
}
export function interruptedGeneration(
	conversation: Conversation,
	generation: Generation,
	error: string,
): GenerationSnapshot {
	return conversation.settle(generation, "interrupted", { error });
}
export function skippedGeneration(
	conversation: Conversation,
	generation: Generation,
): GenerationSnapshot {
	return conversation.settle(generation, "skipped", {
		error: "Agent skipped.",
	});
}

export function effectiveStatus(
	status: GenerationViewStatus,
): GenerationStatus {
	return status.kind === "done" ? status.outcome : status.kind;
}

function projectSteer(steer: TrackedSteerReceipt): SteerReceipt {
	return Object.freeze({
		id: steer.id,
		state: steer.state,
		acceptedAt: steer.acceptedAt,
		...(steer.deliveredAt !== undefined
			? { deliveredAt: steer.deliveredAt }
			: {}),
		...(steer.processedAt !== undefined
			? { processedAt: steer.processedAt }
			: {}),
	});
}

function clearSessionQueue(session: AgentSession | undefined): void {
	try {
		session?.clearQueue?.();
	} catch {}
}
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				!!part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}
function latestAssistantText(
	session: AgentSession | undefined,
	startIndex: number,
): string | undefined {
	const messages = session?.messages;
	if (!Array.isArray(messages)) return;
	for (let index = messages.length - 1; index >= startIndex; index--) {
		const message = messages[index] as { role?: unknown; content?: unknown };
		if (message?.role !== "assistant") continue;
		const text = messageText(message.content).trim();
		if (text) return text;
	}
}

export type ConversationUpdateListener = (
	conversation: Conversation,
	kind: ConversationUpdateKind,
) => void;
export interface GenerationBinding {
	readonly generation: Generation;
	snapshot(): GenerationSnapshot;
	markCollected(audience: CollectionAudience): void;
	release(): void;
}

/** One persistent conversation containing append-only, one-based generations. */
export class Conversation {
	createdAt = Date.now();
	private restoredSessionFile: string | undefined;
	private savedSessionId: string | undefined;
	private restoredLeafId: string | null = null;
	private restorationError: string | undefined;
	readonly conversationId: ConversationId;
	readonly definition: AgentDefinition;
	readonly agentName: string;
	readonly parentConversationId: ConversationId | undefined;
	readonly resolvedSkillBlocks: readonly string[] | undefined;
	readonly requestedConfig: RequestedExecutionConfig;
	readonly requestedOverrides?: ExecutionOverrides;
	readonly label: string;
	readonly listener: ConversationUpdateListener;
	private readonly generations: Generation[] = [];
	private session: AgentSession | undefined;
	private sessionAbandoned = false;
	readonly saveSessions: boolean;
	readonly rootSessionId: string | undefined;
	private stopping:
		| {
				generation: Generation;
				abortSettled: boolean;
				executionSettled: boolean;
		  }
		| undefined;
	private steerTail: Promise<void> = Promise.resolve();
	private unsubscribe: (() => void) | undefined;
	private effectiveConfig?: EffectiveExecutionConfig;

	constructor(
		conversationId: ConversationId,
		definition: AgentDefinition,
		spawn: SpawnRequest,
		listener: ConversationUpdateListener,
		options: {
			saveSessions?: boolean;
			rootSessionId?: string;
			parentConversationId?: ConversationId;
			startedInParentGeneration?: number;
			resolvedSkillBlocks?: readonly string[];
			initiatedBy?: GenerationInitiator;
		} = {},
	) {
		this.conversationId = conversationId;
		this.saveSessions = options.saveSessions ?? false;
		this.rootSessionId = options.rootSessionId;
		this.definition = definition;
		this.listener = listener;
		this.agentName = spawn.agent;
		this.label = spawn.label;
		this.parentConversationId = options.parentConversationId;
		this.resolvedSkillBlocks = options.resolvedSkillBlocks;
		this.requestedConfig = resolveRequestedConfig(definition, spawn);
		if (spawn.model !== undefined || spawn.thinking !== undefined)
			this.requestedOverrides = Object.freeze({
				...(spawn.model !== undefined ? { model: spawn.model } : {}),
				...(spawn.thinking !== undefined ? { thinking: spawn.thinking } : {}),
			});
		this.generations.push(
			this.newGeneration(
				1,
				spawn.prompt,
				options.initiatedBy ?? "model",
				options.startedInParentGeneration,
			),
		);
	}

	get spawnedInGeneration(): number | undefined {
		return this.generations[0]?.startedInParentGeneration;
	}
	get hasCurrentGeneration(): boolean {
		return this.latestGeneration.state.kind !== "done";
	}
	get generationHistory(): readonly GenerationSnapshot[] {
		return this.generations.map((generation) => this.project(generation));
	}
	get latestGeneration(): Generation {
		return this.generations[this.generations.length - 1]!;
	}
	get status(): GenerationViewStatus {
		return this.project(this.latestGeneration).status;
	}
	get hasActiveExecution(): boolean {
		return (
			this.stopping !== undefined || this.latestGeneration.state.kind !== "done"
		);
	}
	latestResultCollected(audience: CollectionAudience): boolean {
		return (
			this.latestGeneration.state.kind === "done" &&
			this.latestGeneration.receipts[audience]
		);
	}
	get hasRetainedResumableSession(): boolean {
		const latest = this.latestGeneration;
		return (
			latest.state.kind === "done" &&
			!this.restorationError &&
			!this.sessionAbandoned &&
			(this.session !== undefined || this.restoredSessionFile !== undefined) &&
			["completed", "interrupted", "aborted"].includes(latest.state.outcome)
		);
	}
	get isResumeAllowed(): boolean {
		const latest = this.latestGeneration;
		return (
			!this.stopping &&
			latest.state.kind === "done" &&
			latest.activeCollectionCount === 0 &&
			latest.receipts[latest.initiatedBy] &&
			this.hasRetainedResumableSession
		);
	}
	get isStopping(): boolean {
		return this.stopping !== undefined;
	}

	private newGeneration(
		number: number,
		prompt: string,
		initiatedBy: GenerationInitiator,
		startedInParentGeneration?: number,
	): Generation {
		return new Generation(
			number,
			prompt,
			initiatedBy,
			(update) => this.listener(this, update),
			startedInParentGeneration,
		);
	}

	beginResume(
		prompt: string,
		initiatedBy: GenerationInitiator = "model",
		startedInParentGeneration?: number,
	): Generation {
		if (!this.isResumeAllowed)
			throw new Error(`Conversation ${this.conversationId} cannot be resumed.`);
		const generation = this.newGeneration(
			this.generations.length + 1,
			prompt,
			initiatedBy,
			startedInParentGeneration,
		);
		generation.entryStart =
			this.session?.sessionManager?.getLeafId() ?? this.restoredLeafId;
		this.generations.push(generation);
		return generation;
	}

	requireCurrentGeneration(): Generation {
		const generation = this.latestGeneration;
		if (generation.state.kind === "done")
			throw new Error(
				`Conversation ${this.conversationId} has no active generation.`,
			);
		return generation;
	}

	bindSession(generation: Generation, session: AgentSession): void {
		if (generation !== this.requireCurrentGeneration())
			throw new Error(`Generation ${generation.number} is no longer current.`);
		if (
			generation.kind === "resume" &&
			this.session &&
			session !== this.session
		) {
			throw new Error(
				`Generation ${generation.number} must reuse its conversation session.`,
			);
		}
		generation.attach(session);
		this.session = session;
		this.savedSessionId = session.sessionManager?.getSessionId();
		this.unsubscribe = generation.activity.subscribe(session);
		this.listener(this, "status");
	}
	sessionForResume(): AgentSession | undefined {
		return this.sessionAbandoned ? undefined : this.session;
	}
	get sessionFileForResume(): string | undefined {
		return this.restorationError || this.sessionAbandoned
			? undefined
			: this.restoredSessionFile;
	}

	checkpoint(): ConversationCheckpoint {
		const snapshot = this.snapshot();
		const { skills, tools, ...requested } = this.requestedConfig;
		return {
			version: 1,
			rootSessionId: this.rootSessionId ?? "",
			conversationId: this.conversationId,
			label: this.label,
			createdAt: this.createdAt,
			saveSessions: this.saveSessions,
			definition: { ...this.definition },
			...(this.requestedOverrides
				? { requestedOverrides: { ...this.requestedOverrides } }
				: {}),
			requestedConfig: {
				...requested,
				...(tools ? { tools: [...tools] } : {}),
				...(skills ? { skills: [...skills] } : {}),
			},
			...(this.parentConversationId
				? { parentConversationId: this.parentConversationId }
				: {}),
			...(snapshot.sessionFile ? { sessionFile: snapshot.sessionFile } : {}),
			...(this.savedSessionId ? { sessionId: this.savedSessionId } : {}),
			...(this.resolvedSkillBlocks
				? { resolvedSkillBlocks: [...this.resolvedSkillBlocks] }
				: {}),
			...(this.effectiveConfig
				? {
						effectiveConfig: {
							...this.effectiveConfig,
							tools: [...this.effectiveConfig.tools],
							skills: [...this.effectiveConfig.skills],
						},
					}
				: {}),
			generations: this.generations.map((generation) => {
				const item = this.project(generation);
				return {
					generation: generation.number,
					prompt: generation.prompt,
					createdAt: generation.createdAt,
					initiatedBy: generation.initiatedBy,
					entryStart: generation.entryStart,
					status: item.status,
					receipts: { ...item.receipts },
					cost: { ...item.cost },
					...(generation.startedInParentGeneration
						? {
								startedInParentGeneration: generation.startedInParentGeneration,
							}
						: {}),
				};
			}),
		};
	}

	static restore(
		data: ConversationCheckpoint,
		session: SessionManager | undefined,
		error: string | undefined,
		listener: ConversationUpdateListener,
	): Conversation {
		const parentConversationId = data.parentConversationId;
		if (
			!isConversationId(data.conversationId) ||
			(parentConversationId !== undefined &&
				!isConversationId(parentConversationId))
		)
			throw new Error("Invalid saved subagent identity.");
		if (
			session &&
			(!data.sessionId || data.sessionId !== session.getSessionId())
		)
			throw new Error(
				"Saved child session ID does not match the session file.",
			);
		const first = data.generations[0]!;
		const conversation = new Conversation(
			data.conversationId,
			data.definition,
			{
				kind: "spawn",
				agent: data.definition.name,
				label: data.label,
				prompt: first.prompt,
				...data.requestedOverrides,
				...(data.requestedConfig.cwd !== undefined
					? { cwd: data.requestedConfig.cwd }
					: {}),
				...(data.requestedConfig.skills
					? { skills: data.requestedConfig.skills }
					: {}),
			},
			listener,
			{
				saveSessions: data.saveSessions,
				rootSessionId: data.rootSessionId,
				...(parentConversationId ? { parentConversationId } : {}),
				...(data.resolvedSkillBlocks
					? { resolvedSkillBlocks: data.resolvedSkillBlocks }
					: {}),
			},
		);
		conversation.createdAt = data.createdAt;
		conversation.restoredSessionFile = data.sessionFile;
		conversation.savedSessionId = data.sessionId;
		conversation.restoredLeafId = session?.getLeafId() ?? null;
		conversation.restorationError = error;
		if (data.effectiveConfig)
			conversation.effectiveConfig = data.effectiveConfig;
		conversation.generations.length = 0;
		const entries = session?.getEntries() ?? [];
		const boundaries = session
			? generationEntryOffsets(entries, data.generations)
			: data.generations.map(() => 0);
		for (const [index, item] of data.generations.entries()) {
			const generation = conversation.newGeneration(
				item.generation,
				item.prompt,
				item.initiatedBy,
				item.startedInParentGeneration,
			);
			generation.createdAt = item.createdAt;
			generation.entryStart = item.entryStart;
			generation.restored = true;
			generation.state =
				item.status.kind === "done"
					? { ...item.status }
					: {
							kind: "done",
							outcome: "interrupted",
							completedAt: Date.now(),
							error: "Parent session ended before this generation completed.",
							...(item.status.kind === "running"
								? { startedAt: item.status.startedAt }
								: {}),
						};
			Object.assign(generation.receipts, item.receipts);
			generation.activity.restore(
				entries.slice(boundaries[index], boundaries[index + 1]),
				item.status.kind === "done" ? item.cost : undefined,
			);
			conversation.generations.push(generation);
		}
		return conversation;
	}

	async disposeSession(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		const session = this.session;
		this.session = undefined;
		if (!session) return;
		try {
			await session.extensionRunner?.emit({
				type: "session_shutdown",
				reason: "quit",
			});
		} finally {
			session.dispose();
		}
	}

	executionSettled(generation: Generation): void {
		if (this.stopping?.generation !== generation) return;
		this.stopping.executionSettled = true;
		this.finishStopping(generation);
	}

	steer(
		generation: Generation,
		prompt: string,
		sentBy: GenerationInitiator = "model",
	): Promise<SteerReceipt> {
		const pending = this.steerTail.then(async () => {
			if (this.stopping)
				throw new GenerationSteerError(generation.number, "stopping");
			this.requireGeneration(generation);
			if (
				generation !== this.latestGeneration ||
				generation.state.kind !== "running"
			) {
				const status =
					generation.state.kind === "queued"
						? "queued"
						: generation.state.kind === "done"
							? generation.state.outcome
							: "running";
				throw new GenerationSteerError(generation.number, status);
			}
			const session = generation.state.session;
			await session.steer(prompt);
			const deliveryText = session.getSteeringMessages?.().at(-1) ?? prompt;
			if (this.stopping) clearSessionQueue(session);
			const receipt = generation.acceptSteer(deliveryText, sentBy);
			this.listener(this, "steer");
			return receipt;
		});
		this.steerTail = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}

	bindGeneration(generation: Generation): GenerationBinding {
		this.requireGeneration(generation);
		generation.activeCollectionCount++;
		this.listener(this, "activeCollection");
		let released = false;
		return {
			generation,
			snapshot: () => this.project(generation),
			markCollected: (audience) => {
				this.markCollected(generation, audience);
			},
			release: () => {
				if (released) return;
				released = true;
				generation.activeCollectionCount--;
				this.listener(this, "activeCollection");
			},
		};
	}

	settle(
		generation: Generation,
		outcome: GenerationOutcomeStatus,
		details: { readonly output?: string; readonly error?: string } = {},
	): GenerationSnapshot {
		this.requireGeneration(generation);
		if (generation !== this.latestGeneration) return this.project(generation);
		if (this.stopping?.generation !== generation) {
			this.unsubscribe?.();
			this.unsubscribe = undefined;
		}
		if (generation.settle(outcome, details)) this.listener(this, "status");
		return this.project(generation);
	}

	async abort(reason = "Agent aborted."): Promise<void> {
		if (!this.hasCurrentGeneration) return;
		const generation = this.latestGeneration;
		this.stopping = {
			generation,
			abortSettled: false,
			executionSettled: false,
		};
		const runningSession =
			generation.state.kind === "running"
				? generation.state.session
				: undefined;
		clearSessionQueue(runningSession);
		const partialOutput = latestAssistantText(
			runningSession,
			generation.sessionMessageStart,
		);
		this.settle(generation, "aborted", {
			error: reason,
			...(partialOutput ? { output: partialOutput } : {}),
		});
		const aborting = Promise.resolve(runningSession?.abort()).catch(
			() => undefined,
		);
		await this.steerTail;
		clearSessionQueue(runningSession);
		await aborting;
		if (this.stopping?.generation === generation) {
			this.stopping.abortSettled = true;
			this.finishStopping(generation);
		}
	}

	private finishStopping(generation: Generation): void {
		if (
			this.stopping?.generation !== generation ||
			!this.stopping.abortSettled ||
			!this.stopping.executionSettled
		)
			return;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.stopping = undefined;
		this.listener(this, "status");
	}

	forceAbandonCancellation(generation: Generation): GenerationSnapshot {
		this.requireGeneration(generation);
		if (this.stopping?.generation === generation) {
			this.unsubscribe?.();
			this.unsubscribe = undefined;
			// Keep ownership for shutdown disposal, but never reuse an unresponsive session.
			this.sessionAbandoned = true;
			this.stopping = undefined;
			this.listener(this, "status");
		}
		return this.project(generation);
	}

	beginNestedJoin(
		generation: Generation,
		targets: readonly GenerationRef[],
		toolCallId?: string,
	): number {
		this.requireGeneration(generation);
		const index = generation.beginNestedJoin(targets, toolCallId);
		this.listener(this, "nestedJoin");
		return index;
	}
	updateNestedJoin(
		generation: Generation,
		index: number,
		update: {
			targets?: readonly NestedJoinTargetSnapshot[];
			state?: NestedJoinAttemptState;
			error?: string;
		},
	): void {
		this.requireGeneration(generation);
		generation.updateNestedJoin(index, update);
		this.listener(this, "nestedJoin");
	}
	markCollected(generation: Generation, audience: CollectionAudience): boolean {
		this.requireGeneration(generation);
		if (generation.state.kind !== "done" || generation.receipts[audience])
			return false;
		generation.receipts[audience] = true;
		this.listener(this, "collection");
		return true;
	}
	setEffectiveConfig(config: EffectiveExecutionConfig): void {
		this.effectiveConfig = config;
	}

	generationSnapshot(generation: Generation): GenerationSnapshot {
		this.requireGeneration(generation);
		return this.project(generation);
	}

	snapshot(): ConversationSnapshot {
		const sessionFile =
			this.session?.sessionManager?.getSessionFile() ??
			this.restoredSessionFile;
		const generations = this.generationHistory;
		const cost = sumCosts(generations.map((generation) => generation.cost));
		const currentGeneration = this.hasCurrentGeneration
			? generations.at(-1)
			: undefined;
		return Object.freeze({
			conversationId: this.conversationId,
			...(sessionFile ? { sessionFile } : {}),
			...(this.restorationError
				? { restorationError: this.restorationError }
				: {}),
			...(this.parentConversationId
				? { parentConversationId: this.parentConversationId }
				: {}),
			...(this.spawnedInGeneration !== undefined
				? { spawnedInGeneration: this.spawnedInGeneration }
				: {}),
			label: this.label,
			createdAt: this.createdAt,
			agent: summarizeAgentDefinition(this.definition),
			requestedConfig: this.requestedConfig,
			cost,
			generations,
			...(currentGeneration ? { currentGeneration } : {}),
			resumeAllowed: this.isResumeAllowed,
			...(this.stopping ? { isStopping: true as const } : {}),
			...(this.effectiveConfig
				? { effectiveConfig: this.effectiveConfig }
				: {}),
			...(this.requestedOverrides
				? { requestedOverrides: this.requestedOverrides }
				: {}),
		});
	}

	ownsGeneration(generation: Generation): boolean {
		return this.generations[generation.number - 1] === generation;
	}
	generation(number: number): Generation | undefined {
		return this.generations[number - 1];
	}
	private requireGeneration(generation: Generation): void {
		if (!this.ownsGeneration(generation))
			throw new Error(
				`Unknown generation ${generation.number} in conversation ${this.conversationId}.`,
			);
	}
	private project(generation: Generation): GenerationSnapshot {
		const state = generation.state;
		const status: GenerationViewStatus =
			state.kind === "queued"
				? { kind: "queued", queuedAt: generation.createdAt }
				: state.kind === "running"
					? { kind: "running", startedAt: state.startedAt }
					: {
							kind: "done",
							outcome: state.outcome,
							completedAt: state.completedAt,
							...(state.startedAt !== undefined
								? { startedAt: state.startedAt }
								: {}),
							...(state.output !== undefined ? { output: state.output } : {}),
							...(state.error !== undefined ? { error: state.error } : {}),
						};
		const nestedJoins = generation.nestedJoins.map((attempt) =>
			Object.freeze({
				...(attempt.toolCallId ? { toolCallId: attempt.toolCallId } : {}),
				targets: Object.freeze(
					attempt.targets.map((target) => Object.freeze({ ...target })),
				),
				state: attempt.state,
				startedAt: attempt.startedAt,
				...(attempt.completedAt !== undefined
					? { completedAt: attempt.completedAt }
					: {}),
				...(attempt.error !== undefined ? { error: attempt.error } : {}),
			}),
		);
		return Object.freeze({
			generation: generation.number,
			...(generation.restored ? { restored: true as const } : {}),
			kind: generation.kind,
			initiatedBy: generation.initiatedBy,
			...(generation.startedInParentGeneration !== undefined
				? { startedInParentGeneration: generation.startedInParentGeneration }
				: {}),
			prompt: generation.prompt,
			createdAt: generation.createdAt,
			status: Object.freeze(status),
			activity: Object.freeze(generation.activity.snapshot()),
			cost: generation.activity.cost,
			usage: generation.activity.usage,
			activeCollectionCount: generation.activeCollectionCount,
			receipts: Object.freeze({ ...generation.receipts }),
			nestedJoins: Object.freeze(nestedJoins),
			steers: Object.freeze(generation.steers.map(projectSteer)),
		});
	}
}

function sumCosts(costs: readonly Usage["cost"][]): Usage["cost"] {
	return costs.reduce<Usage["cost"]>(
		(total, cost) => ({
			input: total.input + cost.input,
			output: total.output + cost.output,
			cacheRead: total.cacheRead + cost.cacheRead,
			cacheWrite: total.cacheWrite + cost.cacheWrite,
			total: total.total + cost.total,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	);
}
