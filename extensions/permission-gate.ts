/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running risky bash commands.
 * Blocks automatically when no UI is available.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";

interface RiskRule {
	pattern: RegExp;
	reason: string;
}

const MAX_COMMAND_PREVIEW = 1200;

const RISK_RULES: RiskRule[] = [
	{
		pattern: /\brm\s+(?:-[^\s]*r|--recursive)\b/i,
		reason: "recursive file deletion",
	},
	{
		pattern: /\brm\s+[^;&|]*(?:\s|=)(?:\/|~|\$HOME|\.\.?)(?:\s|$|\/|\*|["'])/i,
		reason: "deleting broad or sensitive path",
	},
	{ pattern: /\bsudo\b/i, reason: "privileged command" },
	{
		pattern: /\b(?:chmod|chown|chgrp)\b[^;&|]*(?:-R|--recursive|777|666)/i,
		reason: "broad permission or ownership change",
	},
	{
		pattern: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish)\b/i,
		reason: "downloaded script piped into shell",
	},
	{
		pattern: /\b(?:dd|mkfs(?:\.\w+)?|fdisk|parted|wipefs|sgdisk)\b/i,
		reason: "disk or filesystem mutation",
	},
	{
		pattern: /\bgit\s+clean\b[^;&|]*(?:-[^\s]*f|--force)/i,
		reason: "forced removal of untracked files",
	},
	{
		pattern:
			/\b(?:docker|podman)\s+(?:system|volume|network)\s+(?:prune|rm)\b/i,
		reason: "container resource deletion",
	},
	{
		pattern: /\bkubectl\s+delete\b/i,
		reason: "Kubernetes resource deletion",
	},
	{
		pattern: /\bterraform\s+(?:destroy|apply\s+[^;&|]*-destroy)\b/i,
		reason: "infrastructure destruction",
	},
	{
		pattern: /\b(?:shutdown|reboot|poweroff|halt)\b/i,
		reason: "system power/session disruption",
	},
	{
		pattern: /\b(?:pkill|killall)\b/i,
		reason: "bulk process termination",
	},
];

function normalizeCommand(command: string): string {
	return command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
}

function getRiskReasons(command: string): string[] {
	const normalized = normalizeCommand(command);
	const reasons = new Set<string>();

	for (const rule of RISK_RULES) {
		if (rule.pattern.test(normalized)) {
			reasons.add(rule.reason);
		}
	}

	return [...reasons];
}

function previewCommand(command: string): string {
	if (command.length <= MAX_COMMAND_PREVIEW) return command;
	return `${command.slice(0, MAX_COMMAND_PREVIEW)}\n... (${command.length - MAX_COMMAND_PREVIEW} more chars)`;
}

function getShellCommand(event: {
	toolName: string;
	input: unknown;
}): string | undefined {
	if (isToolCallEventType("bash", event)) {
		return event.input.command;
	}

	if (event.toolName !== "exec_command") return undefined;
	if (!event.input || typeof event.input !== "object") return undefined;

	const input = event.input as Record<string, unknown>;
	return typeof input["cmd"] === "string" ? input["cmd"] : undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const command = getShellCommand(event);
		if (!command) return undefined;

		const reasons = getRiskReasons(command);
		if (reasons.length === 0) return undefined;

		const reasonText = reasons.join(", ");

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Risky bash command blocked: ${reasonText}`,
			};
		}

		const choice = await ctx.ui.select(
			`⚠️ Risky bash command\n\nReasons:\n${reasons.map((reason) => `  - ${reason}`).join("\n")}\n\nCommand:\n\n${previewCommand(command)}\n\nAllow?`,
			["No", "Yes"],
		);

		if (choice !== "Yes") {
			return { block: true, reason: `Blocked by user: ${reasonText}` };
		}

		ctx.ui.notify(`Allowed risky command: ${reasonText}`, "warning");
		return undefined;
	});
}
