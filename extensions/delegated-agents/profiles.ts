import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProfileName, ProfileSpec } from "./types.js";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const promptPath = (name: ProfileName) =>
	path.join(ROOT_DIR, "prompts", `${name}.md`);

export const PROFILE_NAMES = [
	"planning",
	"implementation",
	"verification",
	"review",
] as const satisfies readonly ProfileName[];

export const PROFILES: Record<ProfileName, ProfileSpec> = {
	planning: {
		label: "Planning",
		description:
			"Inspect relevant code and produce a concrete implementation plan.",
		promptPath: promptPath("planning"),
		tools: ["read", "grep", "find", "ls"],
	},
	implementation: {
		label: "Implementation",
		description: "Implement a scoped change and run focused validation.",
		promptPath: promptPath("implementation"),
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	},
	verification: {
		label: "Verification / Debugging",
		description:
			"Run focused checks, reproduce failures, and identify root causes.",
		promptPath: promptPath("verification"),
		tools: ["read", "bash", "grep", "find", "ls"],
	},
	review: {
		label: "Review",
		description: "Review code or diffs for concrete, actionable defects.",
		promptPath: promptPath("review"),
		tools: ["read", "bash", "grep", "find", "ls"],
	},
};
