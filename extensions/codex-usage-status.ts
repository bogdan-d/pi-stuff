/** Show ChatGPT Codex subscription usage with /status. */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

interface UsageWindow {
	usedPercent?: number | undefined;
	windowMinutes?: number | undefined;
	resetsAt?: number | undefined;
}

interface UsageLimit {
	id: string;
	name?: string | undefined;
	primary?: UsageWindow | undefined;
	secondary?: UsageWindow | undefined;
}

interface UsageSnapshot {
	planType?: string | undefined;
	limits: UsageLimit[];
	resetsAvailable?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function integerValue(value: unknown): number | undefined {
	const parsed = typeof value === "string" ? Number(value) : value;
	return typeof parsed === "number" && Number.isFinite(parsed)
		? Math.max(0, Math.trunc(parsed))
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function isCanonicalCodexUrl(value: string | undefined): boolean {
	if (!value) return false;
	try {
		const url = new URL(value);
		const path = url.pathname.replace(/\/+$/, "");
		return (
			url.protocol === "https:" &&
			url.hostname === "chatgpt.com" &&
			!url.port &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			(path === "/backend-api" || path === "/backend-api/codex")
		);
	} catch {
		return false;
	}
}

function extractAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(
			Buffer.from(parts[1] ?? "", "base64").toString("utf8"),
		) as unknown;
		const claims = isRecord(payload) ? payload[JWT_CLAIM_PATH] : undefined;
		return isRecord(claims)
			? stringValue(claims["chatgpt_account_id"])
			: undefined;
	} catch {
		return undefined;
	}
}

async function usageHeaders(ctx: ExtensionCommandContext): Promise<Headers> {
	const model = ctx.model;
	if (!model) throw new Error("No active model selected.");
	if (
		model.api !== "openai-codex-responses" ||
		!isCanonicalCodexUrl(model.baseUrl)
	) {
		throw new Error(
			"Codex usage is only available for canonical OpenAI Codex subscription models.",
		);
	}

	const resolved = await ctx.modelRegistry.getProviderAuth(model.provider);
	const token = resolved?.auth.apiKey;
	if (!token || !isCanonicalCodexUrl(resolved.auth.baseUrl ?? model.baseUrl)) {
		throw new Error("Canonical OpenAI Codex subscription auth is required.");
	}
	const accountId = extractAccountId(token);
	if (!accountId) {
		throw new Error("Canonical OpenAI Codex subscription auth is required.");
	}

	return new Headers({
		accept: "application/json",
		authorization: `Bearer ${token}`,
		"chatgpt-account-id": accountId,
		"OAI-Language": "en",
		originator: "pi",
	});
}

function parseWindow(value: unknown): UsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const usedPercent = numberValue(value["used_percent"]);
	const seconds = numberValue(value["limit_window_seconds"]);
	const windowMinutes =
		numberValue(value["window_minutes"]) ??
		(seconds === undefined ? undefined : Math.ceil(seconds / 60));
	const resetsAt =
		numberValue(value["resets_at"]) ?? numberValue(value["reset_at"]);
	return usedPercent === undefined &&
		windowMinutes === undefined &&
		resetsAt === undefined
		? undefined
		: { usedPercent, windowMinutes, resetsAt };
}

function parseLimit(
	id: string,
	name: string | undefined,
	value: unknown,
): UsageLimit {
	const source =
		isRecord(value) && "rate_limit" in value ? value["rate_limit"] : value;
	const record = isRecord(source) ? source : {};
	let primary =
		parseWindow(record["primary_window"]) ?? parseWindow(record["primary"]);
	let secondary =
		parseWindow(record["secondary_window"]) ?? parseWindow(record["secondary"]);
	if (primary?.windowMinutes === WEEKLY_WINDOW_MINUTES && !secondary) {
		secondary = primary;
		primary = undefined;
	}
	return { id, name, primary, secondary };
}

function parseUsage(payload: unknown): UsageSnapshot {
	const root = isRecord(payload) ? payload : {};
	const limits = [parseLimit("codex", undefined, root["rate_limit"])];
	if (Array.isArray(root["additional_rate_limits"])) {
		for (const item of root["additional_rate_limits"]) {
			if (!isRecord(item)) continue;
			limits.push(
				parseLimit(
					stringValue(item["metered_feature"]) ?? "additional",
					stringValue(item["limit_name"]),
					item,
				),
			);
		}
	}
	const resetCredits = root["rate_limit_reset_credits"];
	return {
		planType: stringValue(root["plan_type"]),
		limits,
		resetsAvailable: isRecord(resetCredits)
			? integerValue(resetCredits["available_count"])
			: undefined,
	};
}

async function fetchUsage(
	ctx: ExtensionCommandContext,
): Promise<UsageSnapshot> {
	const headers = await usageHeaders(ctx);
	const response = await fetch(`${CODEX_BASE_URL}/wham/usage`, {
		headers,
		...(ctx.signal ? { signal: ctx.signal } : {}),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`Usage request failed (${response.status}): ${text || response.statusText}`,
		);
	}
	const usage = parseUsage(JSON.parse(text));

	if (usage.resetsAvailable === undefined || usage.resetsAvailable > 0) {
		try {
			const credits = await fetch(
				`${CODEX_BASE_URL}/wham/rate-limit-reset-credits`,
				{ headers, ...(ctx.signal ? { signal: ctx.signal } : {}) },
			);
			if (credits.ok) {
				const payload = (await credits.json()) as unknown;
				if (isRecord(payload)) {
					usage.resetsAvailable = integerValue(payload["available_count"]);
				}
			}
		} catch {
			// Reset-credit metadata is optional; the main usage response still renders.
		}
	}
	return usage;
}

function formatReset(timestampSeconds: number | undefined): string {
	if (!timestampSeconds) return "reset unknown";
	const milliseconds = timestampSeconds * 1000;
	const minutes = Math.max(0, Math.round((milliseconds - Date.now()) / 60_000));
	return minutes < 90
		? `resets in ~${minutes}m`
		: `resets ${new Date(milliseconds).toLocaleString()}`;
}

function formatWindow(
	label: string,
	window: UsageWindow | undefined,
): string | undefined {
	if (!window) return undefined;
	const remaining =
		window.usedPercent === undefined
			? undefined
			: 100 - Math.max(0, Math.min(100, window.usedPercent));
	const span = window.windowMinutes
		? `${Math.round(window.windowMinutes)}m`
		: "window";
	return `${label}: ${remaining === undefined ? "?" : `${Math.round(remaining)}%`} left (${span}, ${formatReset(window.resetsAt)})`;
}

function formatUsage(usage: UsageSnapshot): string {
	const lines = [`Codex usage${usage.planType ? ` (${usage.planType})` : ""}:`];
	if (usage.resetsAvailable !== undefined) {
		lines.push(`- resets available: ${usage.resetsAvailable}`);
	}
	for (const limit of usage.limits) {
		const windows = [
			formatWindow("5h", limit.primary),
			formatWindow("weekly", limit.secondary),
		].filter((value): value is string => Boolean(value));
		lines.push(
			`- ${limit.name ?? limit.id}: ${windows.length ? windows.join("; ") : "no usage data"}`,
		);
	}
	return lines.join("\n");
}

export default function codexUsageStatusShortcut(pi: ExtensionAPI) {
	pi.registerCommand("status", {
		description: "Show Codex usage status",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /status", "warning");
				return;
			}

			try {
				ctx.ui.notify(formatUsage(await fetchUsage(ctx)), "info");
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}
