import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RoleName, RoleSpec } from "./types.js";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const promptPath = (name: RoleName) =>
	path.join(ROOT_DIR, "prompts", `${name}.md`);

export const ROLE_NAMES = [
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
};
