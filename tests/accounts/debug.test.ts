import { test } from "bun:test";
import assert from "node:assert/strict";
import accountsExtension, {
	AccountStore,
	InMemoryAccountStorageBackend,
} from "../../extensions/accounts/accounts.js";
import { createMockContext, createMockPi } from "../support.js";

test("accounts debug captures request fields rather than selected model, omits secrets, and resets", async () => {
	const mock = createMockPi({ thinkingLevel: "xhigh" });
	accountsExtension(mock.pi, {
		store: new AccountStore(new InMemoryAccountStorageBackend()),
		providers: [],
	});
	const { ctx, notifications } = createMockContext({
		mode: "tui",
		model: {
			provider: "openai-codex",
			id: "luna",
			baseUrl:
				"https://user:secret@example.com/private-secret?key=secret#secret",
		},
	});
	const command = mock.commands.get("accounts")!;
	assert.deepEqual(command.getArgumentCompletions?.("de"), [
		{
			value: "debug",
			label: "debug",
			description: "Show trimmed latest request",
		},
	]);
	assert.equal(command.getArgumentCompletions?.("other"), null);
	await command.handler("debug", ctx);
	assert.match(notifications.at(-1)!.message, /No provider request/);
	const payload = {
		model: "astra",
		reasoning: { effort: "low", secret: "secret" },
		input: "secret",
		headers: { authorization: "secret" },
	};
	for (const handler of mock.events.get("before_provider_request") ?? []) {
		assert.equal(await handler({ payload }, ctx), undefined);
	}
	payload.model = "changed-after-hook";
	await command.handler("debug", ctx);
	const message = notifications.at(-1)!.message;
	assert.match(message, /Selected model: openai-codex\/luna/);
	assert.match(message, /"model": "astra"/);
	assert.match(message, /"effort": "low"/);
	assert.match(message, /https:\/\/example.com/);
	assert.doesNotMatch(message, /secret|changed-after-hook/);
	for (const handler of mock.events.get("session_start") ?? [])
		await handler({ reason: "reload" }, ctx);
	await command.handler("debug", ctx);
	assert.match(notifications.at(-1)!.message, /No provider request/);
});
