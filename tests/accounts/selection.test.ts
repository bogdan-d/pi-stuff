import { test } from "bun:test";
import assert from "node:assert/strict";
import {
	registerSelectionMemory,
	type SelectionOptions,
} from "../../extensions/accounts/selection.js";
import { InMemoryAccountStorageBackend } from "../../extensions/accounts/storage.js";
import { createMockContext, createMockPi } from "../support.js";

const saved = { provider: "zai", model: "glm", thinking: "high" };
const glm = { provider: "zai", id: "glm" };
const codex = { provider: "openai-codex", id: "codex" };

function harness(options: SelectionOptions = {}, mode = "tui") {
	const storage = new InMemoryAccountStorageBackend();
	storage.withLock(() => ({ result: undefined, next: JSON.stringify(saved) }));
	const mock = createMockPi();
	const { ctx, notifications } = createMockContext({
		mode,
		model: codex,
		modelRegistry: { getAvailable: () => [glm, codex] },
	});
	registerSelectionMemory(mock.pi, { storage, args: {}, ...options });
	const emit = async (name: string, event: object = {}) => {
		for (const handler of mock.events.get(name) ?? [])
			await handler(event, ctx);
	};
	mock.pi.setModel = async (model) => {
		ctx.model = model;
		await emit("thinking_level_select", { level: "medium" });
		await emit("model_select", { model, source: "set" });
		return true;
	};
	return { ...mock, ctx, notifications, storage, emit };
}

test("fresh startup restores model and thinking without persisting intermediate model-switch events", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.ctx.model, glm);
	assert.deepEqual(h.thinkingLevels, ["high"]);
	assert.deepEqual(
		h.storage.read((raw) => JSON.parse(raw!)),
		saved,
	);
	await h.emit("thinking_level_select", { level: "low" });
	assert.equal(
		h.storage.read((raw) => JSON.parse(raw!).thinking),
		"low",
	);
	await h.emit("session_start", { reason: "new" });
	assert.equal(h.thinkingLevels.at(-1), "low");
});

test("explicit CLI models win, but CLI thinking can override remembered thinking", async () => {
	for (const args of [
		{ model: "codex" },
		{ provider: "openai-codex" },
		{ models: ["codex"] },
	]) {
		const h = harness({ args });
		await h.emit("session_start", { reason: "startup" });
		assert.equal(h.ctx.model, codex);
		assert.deepEqual(h.thinkingLevels, []);
		await h.emit("session_start", { reason: "new" });
		assert.equal(h.ctx.model, glm);
	}
	const h = harness({ args: { thinking: "low" } });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.thinkingLevels.at(-1), "low");
});

test("resume restores transcript selection instead of a startup fallback or global memory", async () => {
	const h = harness({ args: { resume: true } });
	h.ctx.model = glm;
	h.ctx.sessionManager.getBranch = () => [
		{
			type: "model_change",
			id: "m",
			parentId: null,
			timestamp: "2026-01-01",
			provider: "openai-codex",
			modelId: "codex",
		},
		{
			type: "thinking_level_change",
			id: "t",
			parentId: "m",
			timestamp: "2026-01-01",
			thinkingLevel: "low",
		},
	];
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.ctx.model, codex);
	assert.equal(h.thinkingLevels.at(-1), "low");
	assert.deepEqual(
		h.storage.read((raw) => JSON.parse(raw!)),
		saved,
	);
	await h.emit("session_start", { reason: "reload" });
	assert.equal(h.ctx.model, codex);
});

test("missing model and corrupt memory report failure without overwriting the saved choice", async () => {
	const h = harness();
	h.ctx.modelRegistry.getAvailable = () => [codex];
	await h.emit("session_start", { reason: "startup" });
	await h.emit("before_agent_start");
	assert.equal(h.notifications.length, 1);
	assert.deepEqual(
		h.storage.read((raw) => JSON.parse(raw!)),
		saved,
	);
	h.storage.withLock(() => ({ result: undefined, next: "invalid" }));
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.notifications.length, 2);
	assert.equal(
		h.storage.read((raw) => raw),
		"invalid",
	);
});

test("headless children neither restore nor overwrite interactive selection", async () => {
	const h = harness({}, "print");
	await h.emit("session_start", { reason: "startup" });
	await h.emit("model_select", { model: codex, source: "set" });
	await h.emit("before_agent_start");
	assert.equal(h.ctx.model, codex);
	assert.deepEqual(
		h.storage.read((raw) => JSON.parse(raw!)),
		saved,
	);
});
