import { describe, expect, it, mock } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	KeybindingsManager,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { DEFAULT_ASK_SETTINGS } from "../../extensions/ask/settings.js";
import { registerAskSettingsCommand } from "../../extensions/ask/settings-command.js";

function theme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
}

function register() {
	let command: any;
	const load = mock(async () => ({ settings: { ...DEFAULT_ASK_SETTINGS } }));
	const save = mock(async () => {});
	registerAskSettingsCommand(
		{
			registerCommand: (name: string, value: unknown) => {
				expect(name).toBe("ask-settings");
				command = value;
			},
		},
		{ load, save },
	);
	return { command, load, save };
}

function tuiContext(
	actions: (component: Component, render: () => string) => void,
) {
	const notify = mock();
	const requestRender = mock();
	const custom = mock(
		(factory: any) =>
			new Promise<void>((resolve) => {
				const component = factory(
					{ requestRender },
					theme(),
					new KeybindingsManager(TUI_KEYBINDINGS, {}),
					resolve,
				);
				component.focused = true;
				actions(component, () => component.render(80).join("\n"));
			}),
	);
	return {
		ctx: { mode: "tui", hasUI: true, ui: { custom, notify } },
		custom,
		notify,
		requestRender,
	};
}

describe("/ask-settings", () => {
	initTheme("dark", false);

	it("edits and persists both settings from one TUI", async () => {
		const { command, load, save } = register();
		const { ctx, custom, requestRender } = tuiContext((component, render) => {
			expect(render()).toContain("Ask Settings");
			expect(render()).toContain("300000");
			expect(render()).toContain("reset");

			component.handleInput?.("\r");
			expect(render()).toContain("Current: 300000");
			component.handleInput?.("120000");
			component.handleInput?.("\r");
			expect(render()).toContain("120000");

			component.handleInput?.("\x1b[B");
			component.handleInput?.("\r");
			expect(render()).toContain("cancel");
			component.handleInput?.("\x1b");
		});

		await command.handler("", ctx);

		expect(load).toHaveBeenCalledOnce();
		expect(custom).toHaveBeenCalledOnce();
		expect(requestRender).toHaveBeenCalled();
		expect(save.mock.calls.map(([settings]) => settings)).toEqual([
			{ timeoutMs: 120_000, timeoutOnInput: "reset" },
			{ timeoutMs: 120_000, timeoutOnInput: "cancel" },
		]);
	});

	it("keeps invalid timeout input open and leaves settings unchanged", async () => {
		const { command, save } = register();
		const { ctx, notify } = tuiContext((component, render) => {
			component.handleInput?.("\r");
			component.handleInput?.("0");
			component.handleInput?.("\r");
			expect(render()).toContain("Current: 300000");
			component.handleInput?.("\x1b");
			component.handleInput?.("\x1b");
		});

		await command.handler("", ctx);

		expect(save).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"Timeout must be an integer from 1 to 2147483647.",
			"warning",
		);
	});

	it("reports persistence failures without leaving the command pending", async () => {
		const { command, save } = register();
		save.mockRejectedValueOnce(new Error("disk full"));
		const { ctx, notify } = tuiContext((component) => {
			component.handleInput?.("\x1b[B");
			component.handleInput?.("\r");
			component.handleInput?.("\x1b");
		});

		await command.handler("", ctx);

		expect(notify).toHaveBeenCalledWith(
			"Could not save ask settings: disk full",
			"warning",
		);
	});

	it("rejects non-TUI modes without loading settings", async () => {
		const { command, load } = register();
		const notify = mock();

		await command.handler("", { mode: "rpc", ui: { notify } });

		expect(load).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"/ask-settings requires TUI mode",
			"error",
		);
	});
});
