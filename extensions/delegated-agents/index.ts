import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_ENV } from "./runner.js";
import { registerDelegateAgentTool } from "./tool.js";

export default function (pi: ExtensionAPI): void {
	if (process.env[CHILD_ENV] === "1") return;
	registerDelegateAgentTool(pi);
}
