import { expect, test } from "bun:test";
import prefillProgress from "../extensions/prefill-progress.js";
import { createMockContext, createMockPi } from "./support.js";

function harness(provider = "gufo", mode = "tui", active = true) {
	const mock = createMockPi();
	const model = {
		provider,
		id:
			provider === "halogen"
				? "halogen-qwen3.8-flash-next"
				: "qwen3.8-flash-next",
		api: "openai-completions",
	};
	const controller = new AbortController();
	const { ctx } = createMockContext({ mode, model, signal: controller.signal });
	const updates: Array<{ key: string; text?: string }> = [];
	const capability = { active };
	mock.eventBus.on("zentui:working-line-segment-capability", (data) => {
		Object.assign(data as object, {
			supported: true,
			active: capability.active,
			version: 1,
		});
	});
	mock.eventBus.on("zentui:working-line-segment", (data) => {
		updates.push(data as (typeof updates)[number]);
	});
	prefillProgress(mock.pi);
	const fire = (name: string, event: unknown = {}) => {
		let result: unknown;
		for (const handler of mock.events.get(name) ?? [])
			result = handler(event, ctx);
		return result;
	};
	const start = (payload: unknown = { model: model.id, stream: true }) =>
		fire("before_provider_request", { payload });
	const stream = (data: unknown, overrides = {}) =>
		fire("provider_stream_event", {
			provider,
			model: model.id,
			api: model.api,
			data,
			...overrides,
		});
	const progress = (processed: number, total = 1000, cache = 200) => ({
		prompt_progress: { total, cache, processed, time_ms: 100 },
	});
	return {
		model,
		ctx,
		controller,
		capability,
		updates,
		fire,
		start,
		stream,
		progress,
	};
}

test("only supported streaming profile requests with an active TUI owner opt in", () => {
	for (const provider of ["halogen", "gufo", "strixite"]) {
		const h = harness(provider);
		const payload = { model: h.model.id, stream: true, tools: ["unchanged"] };
		expect(h.start(payload)).toEqual({ ...payload, return_progress: true });
		expect(payload).not.toHaveProperty("return_progress");
		h.fire("session_shutdown");
	}
	for (const [provider, mode, active] of [
		["openai", "tui", true],
		["gufo", "print", true],
		["gufo", "rpc", true],
		["gufo", "tui", false],
	] as const) {
		const h = harness(provider, mode, active);
		expect(h.start()).toBeUndefined();
		h.stream(h.progress(400));
		expect(h.updates).toEqual([]);
	}
	const h = harness();
	for (const payload of [
		null,
		[],
		{},
		{ model: "cloud", stream: true },
		{ model: h.model.id, stream: false },
	]) {
		expect(h.start(payload)).toBeUndefined();
	}
	h.model.api = "openai-responses";
	expect(h.start()).toBeUndefined();
	h.model.api = "openai-completions";
	h.model.id = "another-model";
	expect(h.start()).toBeUndefined();
});

test("all engine envelopes show newly processed tokens excluding cache", () => {
	for (const provider of ["halogen", "gufo", "strixite"]) {
		const h = harness(provider);
		h.start();
		const data = {
			...h.progress(400),
			choices:
				provider === "halogen" ? [] : [{ delta: {}, finish_reason: null }],
		};
		h.stream(data);
		expect(h.updates).toEqual([
			{
				key: "pi-stuff:prefill-progress",
				text: "Prefill 200/800 (25%) · cache 200",
			},
		]);
		expect(data.prompt_progress.processed).toBe(400);
		h.fire("session_shutdown");
	}
	for (const [processed, total, cache, label] of [
		[1000, 1000, 1000, "Prefill cached 1000/1000 (100%)"],
		[0, 0, 0, "Prefill empty (0 tokens)"],
		[500, 1000, 0, "Prefill 500/1000 (50%)"],
	] as const) {
		const h = harness();
		h.start();
		h.stream(h.progress(processed, total, cache));
		expect(h.updates.at(-1)?.text).toBe(label);
		h.fire("session_shutdown");
	}
});

test("unknown and malformed data and other request identities are ignored", () => {
	const h = harness();
	h.start();
	for (const data of [
		null,
		[],
		{},
		{ prompt_progress: [] },
		{ prompt_progress: { total: 10 } },
	])
		h.stream(data);
	for (const [field, value] of [
		["total", Infinity],
		["total", "1000"],
		["total", -1],
		["cache", 1001],
		["cache", -1],
		["processed", 199],
		["processed", 1001],
		["processed", 400.5],
		["time_ms", NaN],
		["time_ms", -1],
		["time_ms", "100"],
	] as const) {
		const data = h.progress(400);
		h.stream({ prompt_progress: { ...data.prompt_progress, [field]: value } });
	}
	for (const overrides of [
		{ provider: "openai" },
		{ model: "other" },
		{ api: "openai-responses" },
	])
		h.stream(h.progress(400), overrides);
	expect(h.updates).toEqual([]);
	h.stream(h.progress(400));
	expect(h.updates.at(-1)?.text).toContain("25%");
	h.fire("session_shutdown");
});

test("burst updates coalesce to the latest count and repeated values do not redraw", async () => {
	const h = harness();
	try {
		h.start();
		h.stream(h.progress(400));
		for (let processed = 401; processed <= 600; processed++)
			h.stream(h.progress(processed));
		expect(h.updates).toHaveLength(1);
		await Bun.sleep(300);
		expect(h.updates).toHaveLength(2);
		expect(h.updates.at(-1)?.text).toBe("Prefill 400/800 (50%) · cache 200");
		h.stream(h.progress(600));
		await Bun.sleep(300);
		expect(h.updates).toHaveLength(2);
	} finally {
		h.fire("session_shutdown");
	}
});

test("decode, failures, retries, identity changes and shutdown clear pending progress", async () => {
	for (const [name, event] of [
		["message_update", { assistantMessageEvent: { type: "text_delta" } }],
		["message_update", { assistantMessageEvent: { type: "thinking_delta" } }],
		["message_update", { assistantMessageEvent: { type: "toolcall_delta" } }],
		["message_end", { message: { role: "assistant", stopReason: "aborted" } }],
		["message_end", { message: { role: "assistant", stopReason: "error" } }],
		["before_provider_request", { payload: {} }],
		...[
			"turn_start",
			"agent_end",
			"agent_settled",
			"model_select",
			"session_start",
			"session_before_switch",
			"session_tree",
			"session_before_compact",
			"session_shutdown",
		].map((name) => [name, {}] as const),
	] as const) {
		const h = harness();
		h.start();
		h.fire("message_update", { assistantMessageEvent: { type: "start" } });
		h.stream(h.progress(400));
		h.stream(h.progress(600));
		h.fire(name, event);
		expect(h.updates.at(-1)?.text).toBeUndefined();
		const count = h.updates.length;
		h.stream(h.progress(800));
		expect(h.updates).toHaveLength(count);
		await Bun.sleep(260);
		expect(h.updates).toHaveLength(count);
		h.start();
		h.stream(h.progress(200));
		expect(h.updates.at(-1)?.text).toBe("Prefill 0/800 (0%) · cache 200");
		h.fire("session_shutdown");
	}
});

test("ownership loss or a changed selected provider releases only the keyed segment", async () => {
	for (const loseOwner of [true, false]) {
		const h = harness();
		h.start();
		h.stream(h.progress(400));
		if (loseOwner) h.capability.active = false;
		else h.model.provider = "openai";
		h.stream(h.progress(600));
		await Bun.sleep(300);
		expect(h.updates.at(-1)).toEqual({
			key: "pi-stuff:prefill-progress",
			text: undefined,
		});
		h.fire("session_shutdown");
	}
});

test("abort immediately clears progress and cannot republish a pending update", async () => {
	const h = harness();
	h.start();
	h.stream(h.progress(400));
	h.stream(h.progress(600));
	h.controller.abort();
	expect(h.updates.at(-1)?.text).toBeUndefined();
	const count = h.updates.length;
	await Bun.sleep(300);
	expect(h.updates).toHaveLength(count);
	expect(h.start()).toBeUndefined();
	h.fire("session_shutdown");
});
