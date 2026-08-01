import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getFinalOutput, getToolCalls } from "./messages.js";
import { ROLES } from "./roles.js";
import type {
	BackgroundLaunchDetails,
	ChildRunDetails,
	RenderableRunDetails,
	RoleName,
} from "./types.js";

function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsage(details: RenderableRunDetails): string {
	if (!("usage" in details)) return "";
	const { usage } = details;
	const parts = [
		usage.input ? `↑${formatTokens(usage.input)}` : "",
		usage.output ? `↓${formatTokens(usage.output)}` : "",
		usage.cacheRead ? `R${formatTokens(usage.cacheRead)}` : "",
		usage.cost.total ? `$${usage.cost.total.toFixed(4)}` : "",
	];
	return parts.filter(Boolean).join(" ");
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
	if (name === "bash") return `$ ${String(args["command"] ?? "")}`;
	if (name === "read") return `read ${String(args["path"] ?? "?")}`;
	if (name === "grep")
		return `grep /${String(args["pattern"] ?? "")}/ in ${String(args["path"] ?? ".")}`;
	if (name === "find")
		return `find ${String(args["pattern"] ?? "*")} in ${String(args["path"] ?? ".")}`;
	if (name === "ls") return `ls ${String(args["path"] ?? ".")}`;
	return `${name} ${JSON.stringify(args)}`;
}

export function renderDelegateCall(
	args: { agent?: string; profile?: string; task?: string },
	theme: Theme,
) {
	const task = args.task ?? "";
	const preview = task.length > 90 ? `${task.slice(0, 90)}...` : task;
	const agent = args.agent ?? args.profile;
	const selected = agent ? ` ${theme.fg("accent", `[${agent}]`)}` : "";
	return new Text(
		`${theme.fg("toolTitle", theme.bold("delegate_agent"))}${selected}\n  ${theme.fg("dim", preview)}`,
		0,
		0,
	);
}

export function renderDelegateResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details: RenderableRunDetails;
	},
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	task: string,
) {
	const details = result.details;
	if ("mode" in details && details.mode === "background") {
		const background = details as BackgroundLaunchDetails;
		const state = background.status === "queued" ? "Queued" : "Running";
		const header = `${theme.fg("warning", `… ${state}`)} ${theme.fg("accent", background.agent)} · ${ROLES[background.role].label} ${theme.fg("dim", background.model)} · ${background.id}`;
		return new Text(
			options.expanded
				? `${header}\n${theme.fg("dim", `Use delegate_agent_result with ID ${background.id} to retrieve the result.`)}`
				: header,
			0,
			0,
		);
	}
	const agent = "agent" in details ? details.agent : details.profile;
	const role: RoleName = "role" in details ? details.role : details.profile;
	const roleSpec = ROLES[role];
	const richDetails: ChildRunDetails | undefined =
		"messages" in details && "agent" in details ? details : undefined;
	const legacyMessages =
		"messages" in details && details.messages ? details.messages : undefined;
	const contentText = result.content.find((part) => part.type === "text")?.text;
	const output =
		(legacyMessages ? getFinalOutput(legacyMessages) : contentText) ||
		"(no output)";
	const toolCalls = legacyMessages ? getToolCalls(legacyMessages) : [];
	const status = options.isPartial
		? theme.fg("warning", "… Running")
		: theme.fg("success", "✓ Done");
	const model = details.thinking
		? `${details.model}:${details.thinking}`
		: details.model;
	const header = `${status} ${theme.fg("accent", agent)} · ${roleSpec.label} ${theme.fg("dim", model)}`;
	const usage = formatUsage(details);

	if (!options.expanded) {
		const previewSource =
			output !== "(no output)"
				? output
				: toolCalls.at(-1)
					? formatToolCall(toolCalls.at(-1)!.name, toolCalls.at(-1)!.args)
					: output;
		const preview = previewSource.split("\n").slice(0, 8).join("\n");
		return new Text(
			[header, preview, usage ? theme.fg("dim", usage) : ""]
				.filter(Boolean)
				.join("\n"),
			0,
			0,
		);
	}

	const container = new Container();
	container.addChild(new Text(header, 0, 0));
	container.addChild(
		new Text(
			theme.fg(
				"dim",
				`${"description" in details && details.description ? details.description : roleSpec.description} · ${details.cwd}`,
			),
			0,
			0,
		),
	);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "Task"), 0, 0));
	container.addChild(new Text(task, 0, 0));
	if (toolCalls.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Tool calls"), 0, 0));
		for (const call of toolCalls) {
			container.addChild(
				new Text(
					theme.fg("dim", `• ${formatToolCall(call.name, call.args)}`),
					0,
					0,
				),
			);
		}
	}
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "Output"), 0, 0));
	container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
	if (richDetails?.stderr.trim()) {
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(theme.fg("dim", richDetails.stderr.trim()), 0, 0),
		);
	}
	if (usage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usage), 0, 0));
	}
	return container;
}
