import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

// Keep only routing and reasoning fields, never retain the original payload.
function trimmedPayload(payload: unknown): Record<string, unknown> {
	const source = object(payload);
	const result: Record<string, unknown> = {};
	for (const key of [
		"model",
		"reasoning_effort",
		"max_tokens",
		"max_output_tokens",
		"stream",
	]) {
		const value = source[key];
		if (typeof value === "string") result[key] = value.slice(0, 160);
		else if (typeof value === "number" || typeof value === "boolean")
			result[key] = value;
	}
	const effort = object(source["reasoning"])["effort"];
	if (typeof effort === "string")
		result["reasoning"] = { effort: effort.slice(0, 40) };
	return result;
}

function endpointOrigin(baseUrl: string | undefined): string {
	try {
		const url = new URL(baseUrl ?? "");
		return url.protocol === "https:" || url.protocol === "http:"
			? url.origin
			: "unavailable";
	} catch {
		return "unavailable";
	}
}

export function registerAccountDebug(
	pi: ExtensionAPI,
): (ctx: ExtensionContext) => void {
	let latest: string | undefined;
	pi.on("session_start", () => {
		latest = undefined;
	});
	pi.on("session_shutdown", () => {
		latest = undefined;
	});
	pi.on("before_provider_request", (event, ctx) => {
		latest = [
			`Latest request hook: ${new Date().toISOString()}`,
			`Selected model: ${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}`,
			`Selected reasoning: ${pi.getThinkingLevel()}`,
			`Configured endpoint origin: ${endpointOrigin(ctx.model?.baseUrl)}`,
			JSON.stringify(trimmedPayload(event.payload), null, 2),
			"Credentials, URL path/query, prompts and tools omitted. This is the payload at this hook, not a wire trace. Later hooks may modify it; the final URL is not exposed by Pi.",
		].join("\n");
	});
	return (ctx) =>
		ctx.ui.notify(
			latest ??
				"No provider request captured yet in this session. Send a prompt, then run /accounts debug.",
			"info",
		);
}
