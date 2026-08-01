import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RoleName, RoleSpec } from "./types.js";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const promptPath = (name: RoleName) =>
	path.join(ROOT_DIR, "prompts", `${name}.md`);

export const ROLE_NAMES = [
	"explore-shallow",
	"explore-deep",
	"planning",
	"implementation",
	"verification",
	"review",
] as const satisfies readonly RoleName[];

export const ROLES: Record<RoleName, RoleSpec> = {
	planning: {
		label: "Planning",
		description:
			"Inspect relevant code and produce a concrete implementation plan.",
		promptPath: promptPath("planning"),
	},
	implementation: {
		label: "Implementation",
		description: "Implement a scoped change and run focused validation.",
		promptPath: promptPath("implementation"),
	},
	verification: {
		label: "Verification / Debugging",
		description:
			"Run focused checks, reproduce failures, and identify root causes.",
		promptPath: promptPath("verification"),
	},
	review: {
		label: "Review",
		description: "Review code or diffs for concrete, actionable defects.",
		promptPath: promptPath("review"),
	},
	"explore-shallow": {
		label: "Explore / Shallow",
		description:
			"Run bounded discovery to find likely hotspots, entry points, and best next reads.",
		promptPath: promptPath("explore-shallow"),
		model: "openai-codex/gpt-5.6-luna",
		thinking: "low",
	},
	"explore-deep": {
		label: "Explore / Deep",
		description:
			"Run broad discovery for surveys, triage, cross-file synthesis, or compare/rank work.",
		promptPath: promptPath("explore-deep"),
		model: "openai-codex/gpt-5.6-terra",
		thinking: "low",
	},
};
