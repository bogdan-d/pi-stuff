import { expect, test } from "bun:test";
import type { Context } from "@earendil-works/pi-ai";
import {
	type ExtensionUIContext,
	initTheme,
	SessionManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager,
	type TUI,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import handoff from "../extensions/handoff.js";
import summarize from "../extensions/summarize.js";
import { createMockContext, createMockPi } from "./support.js";

// Exercise the handoff's asynchronous generation without starting a terminal.
async function loaderUI(factory: Parameters<ExtensionUIContext["custom"]>[0]) {
	let done!: (value: unknown) => void;
	const result = new Promise((resolve) => {
		done = resolve;
	});
	const component = await factory(
		{ requestRender() {} } as TUI,
		{ fg: (_color, text) => text } as Theme,
		new KeybindingsManager(TUI_KEYBINDINGS, {}),
		done,
	);
	try {
		return await result;
	} finally {
		component.dispose?.();
	}
}

for (const [name, extension] of [
	["handoff", handoff],
	["summarize", summarize],
] as const) {
	test(`${name} sends projected context, not omitted or superseded raw history`, async () => {
		initTheme("dark", false);
		const session = SessionManager.inMemory();
		const append = (content: string) =>
			session.appendMessage({ role: "user", content, timestamp: Date.now() });
		append("old compacted history");
		const retained = append("superseded request");
		const omitted = append("omitted request");
		session.appendCompaction("compacted decisions", retained, 100);
		session.appendContextEdit(retained, { content: "updated request" });
		session.appendContextEdit(omitted, null);
		append("current request");

		const requests: string[] = [];
		const { ctx, notifications } = createMockContext({
			mode: name === "handoff" ? "tui" : "print",
			model: { provider: "openai", id: "gpt-5.2" },
			sessionManager: session,
			custom: loaderUI,
			modelRegistry: {
				find: () => ({ provider: "openai", id: "gpt-5.2" }),
				hasConfiguredAuth: () => true,
				complete: async (_model: unknown, context: Context) => {
					requests.push(JSON.stringify(context.messages));
					return {
						content: [{ type: "text", text: "generated summary" }],
						stopReason: "stop",
					};
				},
			},
		});
		const { pi, commands } = createMockPi();
		extension(pi);
		const command = commands.get(name);
		if (!command) throw new Error(`Missing command ${name}`);
		await command.handler("continue the work", ctx);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("compacted decisions");
		expect(requests[0]).toContain("updated request");
		expect(requests[0]).toContain("current request");
		expect(requests[0]).not.toContain("old compacted history");
		expect(requests[0]).not.toContain("superseded request");
		expect(requests[0]).not.toContain("omitted request");

		// Pi 0.87 can compact without retaining any earlier messages.
		session.appendCompaction("retain-none summary", null, 100);
		await command.handler("continue the work", ctx);
		expect(requests).toHaveLength(2);
		expect(requests[1]).toContain("retain-none summary");
		expect(requests[1]).not.toContain("updated request");
		expect(requests[1]).not.toContain("current request");

		// A system prompt alone is not a conversation to summarize.
		session.resetLeaf();
		session.appendMessage({
			role: "system",
			content: "system instructions",
			timestamp: Date.now(),
		});
		const hidden = append("hidden request");
		session.appendContextEdit(hidden, null);
		await command.handler("continue the work", ctx);
		expect(requests).toHaveLength(2);
		if (name === "handoff") {
			expect(notifications.at(-1)?.message).toBe("No conversation to hand off");
		}
	});
}
