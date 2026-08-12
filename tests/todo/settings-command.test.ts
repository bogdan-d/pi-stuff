import { describe, expect, it, mock } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	KeybindingsManager,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { DEFAULT_TODO_SETTINGS } from "../../extensions/todo/settings.js";
import { registerTodoSettingsCommand } from "../../extensions/todo/settings-command.js";

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
	const load = mock(async () => ({ settings: { ...DEFAULT_TODO_SETTINGS } }));
	const save = mock(async () => {});
	const onSaved = mock(async () => {});
	registerTodoSettingsCommand(
		{
			registerCommand: (name: string, value: unknown) => {
				expect(name).toBe("todo-settings");
				command = value;
			},
		},
		{ load, save, onSaved },
	);
	return { command, load, save, onSaved };
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
				actions(component, () => component.render(100).join("\n"));
			}),
	);
	return {
		ctx: {
			mode: "tui",
			hasUI: true,
			cwd: "/project",
			isProjectTrusted: () => false,
			ui: { custom, notify },
		},
		custom,
		notify,
		requestRender,
	};
}

describe("/todo-settings", () => {
	initTheme("dark", false);

	it("shows every setting and persists enum, integer, and boolean changes", async () => {
		const { command, load, onSaved, save } = register();
		const { ctx, custom, requestRender } = tuiContext((component, render) => {
			const initial = render();
			for (const label of [
				"Widget placement",
				"Visible tasks",
				"Fallback glyphs",
				"Tool visibility",
				"Dynamic reminders",
				"Reminder min turns",
				"Reminder max turns",
				"Reminder output tokens",
				"Reminders per run",
			]) {
				expect(initial).toContain(label);
			}

			component.handleInput?.("\r");
			component.handleInput?.("\x1b[B");
			component.handleInput?.("\r");
			component.handleInput?.("7");
			component.handleInput?.("\r");
			component.handleInput?.("\x1b[B");
			component.handleInput?.("\r");
			component.handleInput?.("\x1b[B");
			component.handleInput?.("\r");
			component.handleInput?.("\x1b[B");
			component.handleInput?.("\r");
			expect(render()).toContain("belowEditor");
			expect(render()).toContain("7");
			expect(render()).toContain("none");
			component.handleInput?.("\x1b");
		});

		await command.handler("", ctx);

		expect(load).toHaveBeenCalledOnce();
		expect(custom).toHaveBeenCalledOnce();
		expect(requestRender).toHaveBeenCalled();
		expect(save).toHaveBeenCalledTimes(5);
		expect(save.mock.lastCall?.[0]).toEqual({
			...DEFAULT_TODO_SETTINGS,
			widgetPlacement: "belowEditor",
			maxVisibleTasks: 7,
			fallbackGlyphs: true,
			toolVisibility: "none",
			dynamicReminders: false,
		});
		expect(onSaved).toHaveBeenCalledTimes(5);
	});

	it("validates positive integers and the reminder turn range", async () => {
		const { command, save } = register();
		const { ctx, notify } = tuiContext((component, render) => {
			for (let index = 0; index < 5; index += 1)
				component.handleInput?.("\x1b[B");
			component.handleInput?.("\r");
			component.handleInput?.("9");
			component.handleInput?.("\r");
			expect(render()).toContain("Current: 4");
			component.handleInput?.("\x1b");
			component.handleInput?.("\x1b");
		});

		await command.handler("", ctx);

		expect(save).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"Minimum turns cannot exceed 8.",
			"warning",
		);
	});

	it("reports persistence failures without applying the change", async () => {
		const { command, onSaved, save } = register();
		save.mockRejectedValueOnce(new Error("read-only filesystem"));
		const { ctx, notify } = tuiContext((component) => {
			component.handleInput?.("\r");
			component.handleInput?.("\x1b");
		});

		await command.handler("", ctx);

		expect(onSaved).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"Could not save todo settings: read-only filesystem",
			"warning",
		);
	});

	it("rejects non-TUI modes without loading settings", async () => {
		const { command, load } = register();
		const notify = mock();

		await command.handler("", { mode: "rpc", ui: { notify } });

		expect(load).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"/todo-settings requires TUI mode",
			"error",
		);
	});
});
