import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadAgentCatalog } from "./agents.js";
import { registerBackgroundAgentTools } from "./background-tools.js";
import { registerAgentCommands } from "./commands.js";
import { registerAgentInspector } from "./inspector.js";
import { finalizeRun } from "./results.js";
import { AgentRunHistory, RUN_ENTRY_TYPE } from "./run-history.js";
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
	const history = new AgentRunHistory({
		onTerminal(run) {
			pi.appendEntry(RUN_ENTRY_TYPE, run);
		},
	});
	const manager = new DelegatedAgentManager({
		run: runDelegatedAgent,
		finalize: finalizeRun,
		history,
		onBackgroundSettled(run) {
			notifyBackgroundSettled(pi, run);
		},
	});
	registerDelegateAgentTool(pi, catalog, manager);
	registerBackgroundAgentTools(pi, manager);
	registerAgentCommands(pi);
	registerAgentInspector(pi, history, manager);
	const reconstruct = (ctx: ExtensionContext) => {
		history.reconstruct(ctx.sessionManager.getBranch());
	};
	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_shutdown", async () => manager.shutdown());
}
