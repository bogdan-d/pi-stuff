import type {
	AssistantMessage,
	ModelThinkingLevel,
	Usage,
} from "@earendil-works/pi-ai";

export type RoleName =
	| "planning"
	| "implementation"
	| "verification"
	| "review";

export interface RoleSpec {
	label: string;
	description: string;
	promptPath: string;
}

export interface CustomAgentConfig {
	role: RoleName;
	description: string;
	prompt: string;
	model?: string;
	thinking?: ModelThinkingLevel;
}

export interface AgentSpec {
	name: string;
	role: RoleName;
	description: string;
	rolePromptPath: string;
	specializationPrompt?: string;
	model?: string;
	thinking?: ModelThinkingLevel;
	source: "builtin" | "config";
}

export type AgentCatalog = ReadonlyMap<string, AgentSpec>;

export interface ChildRunDetails {
	agent: string;
	role: RoleName;
	description?: string;
	task: string;
	cwd: string;
	model: string;
	thinking?: ModelThinkingLevel;
	messages: AssistantMessage[];
	stderr: string;
	usage: Usage;
	stopReason?: string;
	errorMessage?: string;
}

export interface PersistedRunDetails {
	agent: string;
	role: RoleName;
	description?: string;
	cwd: string;
	model: string;
	thinking?: ModelThinkingLevel;
	usage: Usage;
	truncated: boolean;
	fullOutputPath?: string;
}

export type BackgroundRunStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export interface BackgroundRunSummary {
	id: string;
	status: BackgroundRunStatus;
	agent: string;
	role: RoleName;
	description?: string;
	task: string;
	cwd: string;
	model: string;
	thinking?: ModelThinkingLevel;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
}

export interface BackgroundLaunchDetails extends BackgroundRunSummary {
	mode: "background";
}

export interface BackgroundRunResult extends BackgroundRunSummary {
	output?: string;
	error?: string;
	usage?: Usage;
	truncated?: boolean;
	fullOutputPath?: string;
}

export type DelegateRunDetails =
	| ChildRunDetails
	| PersistedRunDetails
	| BackgroundLaunchDetails;

export interface LegacyRunDetails {
	profile: RoleName;
	cwd: string;
	model: string;
	thinking?: ModelThinkingLevel;
	usage: Usage;
	messages?: AssistantMessage[];
	stderr?: string;
}

export type RenderableRunDetails = DelegateRunDetails | LegacyRunDetails;
