import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KEY = "pi-stuff:prefill-progress";
const SEGMENT = "zentui:working-line-segment";
const MODELS: Record<string, string> = {
	halogen: "halogen-qwen3.8-flash-next",
	gufo: "qwen3.8-flash-next",
	strixite: "qwen3.8-flash-next",
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function progressLabel(data: unknown): string | undefined {
	const progress = record(record(data)?.["prompt_progress"]);
	if (!progress) return;
	const { total, cache, processed, time_ms: timeMs } = progress;
	if (
		!Number.isSafeInteger(total) ||
		!Number.isSafeInteger(cache) ||
		!Number.isSafeInteger(processed) ||
		typeof total !== "number" ||
		typeof cache !== "number" ||
		typeof processed !== "number" ||
		total < 0 ||
		cache < 0 ||
		processed < cache ||
		processed > total ||
		typeof timeMs !== "number" ||
		!Number.isFinite(timeMs) ||
		timeMs < 0
	) {
		return;
	}
	if (total === 0) return "Prefill empty (0 tokens)";
	if (cache === total) return `Prefill cached ${cache}/${total} (100%)`;
	const remaining = total - cache;
	const fresh = processed - cache;
	const percent = Math.floor((fresh / remaining) * 100);
	return `Prefill ${fresh}/${remaining} (${percent}%)${cache ? ` · cache ${cache}` : ""}`;
}

export default function (pi: ExtensionAPI) {
	let request: { provider: string; model: string } | undefined;
	let pending: string | undefined;
	let displayed: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let signal: AbortSignal | undefined;

	function active(): boolean {
		const capability = { supported: false, active: false };
		pi.events.emit("zentui:working-line-segment-capability", capability);
		return capability.supported && capability.active;
	}

	function reset() {
		const owned = request !== undefined || displayed !== undefined;
		signal?.removeEventListener("abort", reset);
		signal = undefined;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		request = undefined;
		pending = undefined;
		displayed = undefined;
		if (owned) pi.events.emit(SEGMENT, { key: KEY, text: undefined });
	}

	function publish() {
		if (!active()) {
			reset();
			return;
		}
		if (pending !== displayed) {
			displayed = pending;
			pi.events.emit(SEGMENT, { key: KEY, text: displayed });
		}
		// Coalesce bursts without holding up Pi's awaited provider stream handlers.
		timer = setTimeout(() => {
			timer = undefined;
			if (pending !== displayed) publish();
		}, 250);
	}

	pi.on("before_provider_request", (event, ctx) => {
		reset();
		const model = ctx.model;
		const payload = record(event.payload);
		// This event has no model metadata: require selected context AND wire model.
		if (
			ctx.mode !== "tui" ||
			!model ||
			model.api !== "openai-completions" ||
			MODELS[model.provider] !== model.id ||
			payload?.["model"] !== model.id ||
			payload["stream"] !== true ||
			ctx.signal?.aborted ||
			!active()
		) {
			return;
		}
		request = { provider: model.provider, model: model.id };
		signal = ctx.signal;
		signal?.addEventListener("abort", reset, { once: true });
		return { ...payload, return_progress: true };
	});

	pi.on("provider_stream_event", (event, ctx) => {
		if (!request) return;
		if (
			ctx.mode !== "tui" ||
			ctx.signal?.aborted ||
			ctx.model?.provider !== request.provider ||
			ctx.model.id !== request.model
		) {
			reset();
			return;
		}
		if (
			event.api !== "openai-completions" ||
			event.provider !== request.provider ||
			event.model !== request.model
		) {
			return;
		}
		const label = progressLabel(event.data);
		if (!label || label === pending) return;
		pending = label;
		if (timer === undefined) publish();
	});

	pi.on("message_update", (event) => {
		// The generic start precedes prefill; normalized content starts decode.
		if (event.assistantMessageEvent.type !== "start") reset();
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") reset();
	});
	pi.on("turn_start", reset);
	pi.on("agent_end", reset);
	pi.on("agent_settled", reset);
	pi.on("model_select", reset);
	pi.on("session_start", reset);
	pi.on("session_before_switch", reset);
	pi.on("session_tree", reset);
	pi.on("session_before_compact", reset);
	pi.on("session_shutdown", reset);
}
