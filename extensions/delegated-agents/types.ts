import type {
	AssistantMessage,
	ModelThinkingLevel,
	Usage,
} from "@earendil-works/pi-ai";

export type ProfileName =
	| "planning"
	| "implementation"
	| "verification"
	| "review";

export interface ProfileSpec {
	label: string;
	description: string;
	promptPath: string;
}

export interface ChildRunDetails {
	profile: ProfileName;
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
	profile: ProfileName;
	cwd: string;
	model: string;
	thinking?: ModelThinkingLevel;
	usage: Usage;
	truncated: boolean;
	fullOutputPath?: string;
}

export type DelegateRunDetails = ChildRunDetails | PersistedRunDetails;
