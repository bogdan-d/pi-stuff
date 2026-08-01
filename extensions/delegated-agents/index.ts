import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadAgentCatalog } from "./agents.js";
import { registerBackgroundAgentTools } from "./background-tools.js";
import { registerAgentCommands } from "./commands.js";
import { finalizeRun } from "./results.js";
import { CHILD_ENV, runDelegatedAgent } from "./runner.js";
import { DelegatedAgentManager } from "./runs.js";
import { registerDelegateAgentTool } from "./tool.js";
import type { BackgroundRunResult } from "./types.js";

export function notifyBackgroundSettled(
	pi: ExtensionAPI,
	run: BackgroundRunResult,
): void {
	try {
		pi.sendMessage(
			{
				customType: "delegated-agent-complete",
				content: `Background delegated agent finished.\nRun ID: ${run.id}\nAgent: ${run.agent}\nStatus: ${run.status}\nUse delegate_agent_result with this ID to retrieve the result.`,
				display: true,
				details: { id: run.id, agent: run.agent, status: run.status },
			},
			{ deliverAs: "nextTurn", triggerTurn: false },
		);
	} catch {
		// Retained result remains authoritative when message delivery fails.
	}
}

export default function (pi: ExtensionAPI): void {
	if (process.env[CHILD_ENV] === "1") return;
	const catalog = loadAgentCatalog();
	const manager = new DelegatedAgentManager({
		run: runDelegatedAgent,
		finalize: finalizeRun,
		onBackgroundSettled(run) {
			notifyBackgroundSettled(pi, run);
		},
	});
	registerDelegateAgentTool(pi, catalog, manager);
	registerBackgroundAgentTools(pi, manager);
	registerAgentCommands(pi);
	pi.on("session_shutdown", async () => manager.shutdown());
}
