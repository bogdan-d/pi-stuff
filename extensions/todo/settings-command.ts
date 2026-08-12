import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	type SettingItem,
	SettingsList,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	loadTodoSettings,
	saveTodoGlobalSettings,
	type TodoSettings,
	type TodoSettingsLoadResult,
} from "./settings.js";

type IntegerSetting =
	| "maxVisibleTasks"
	| "reminderMinTurns"
	| "reminderMaxTurns"
	| "reminderOutputTokens"
	| "reminderMaxPerRun";

interface TodoSettingsCommandOptions {
	load?: () => Promise<TodoSettingsLoadResult>;
	save?: (settings: TodoSettings) => Promise<void>;
	onSaved?: (
		settings: TodoSettings,
		ctx: ExtensionContext,
	) => Promise<void> | void;
}

export function registerTodoSettingsCommand(
	pi: Pick<ExtensionAPI, "registerCommand">,
	options: TodoSettingsCommandOptions = {},
): void {
	const load = options.load ?? (() => loadTodoSettings());
	const save = options.save ?? saveTodoGlobalSettings;

	pi.registerCommand("todo-settings", {
		description: "Configure todo display and reminders",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todo-settings requires TUI mode", "error");
				return;
			}

			const loaded = await load();
			if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
			let settings = loaded.settings;
			let saveQueue = Promise.resolve();
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				let focused = false;
				let activeInput: Input | undefined;
				const integerItem = (
					id: IntegerSetting,
					label: string,
					description: string,
					validate?: (value: number) => string | undefined,
				): SettingItem => ({
					id,
					label,
					description,
					currentValue: String(settings[id]),
					submenu: (currentValue, close) => {
						const input = new Input();
						activeInput = input;
						input.focused = focused;
						const finish = (value?: string) => {
							activeInput = undefined;
							close(value);
						};
						input.onSubmit = (value) => {
							const parsed = positiveInteger(value);
							const warning =
								parsed === undefined
									? "Value must be a positive integer."
									: validate?.(parsed);
							if (warning) {
								ctx.ui.notify(warning, "warning");
								return;
							}
							finish(String(parsed));
						};
						input.onEscape = () => finish();
						return integerInput(input, currentValue, label, theme);
					},
				});
				const items: SettingItem[] = [
					{
						id: "widgetPlacement",
						label: "Widget placement",
						description:
							"Place the todo widget above or below the editor, or turn it off.",
						currentValue: settings.widgetPlacement,
						values: ["aboveEditor", "belowEditor", "off"],
					},
					integerItem(
						"maxVisibleTasks",
						"Visible tasks",
						"Maximum task rows shown in each widget section.",
					),
					{
						id: "fallbackGlyphs",
						label: "Fallback glyphs",
						description: "Use plain terminal-safe status glyphs.",
						currentValue: String(settings.fallbackGlyphs),
						values: ["true", "false"],
					},
					{
						id: "toolVisibility",
						label: "Tool visibility",
						description: "Show all todo tool calls, only set calls, or none.",
						currentValue: settings.toolVisibility,
						values: ["all", "set-only", "none"],
					},
					{
						id: "dynamicReminders",
						label: "Dynamic reminders",
						description: "Inject reminders when an open plan becomes stale.",
						currentValue: String(settings.dynamicReminders),
						values: ["true", "false"],
					},
					integerItem(
						"reminderMinTurns",
						"Reminder min turns",
						"Minimum turns before a reminder can be injected.",
						(value) =>
							value > settings.reminderMaxTurns
								? `Minimum turns cannot exceed ${settings.reminderMaxTurns}.`
								: undefined,
					),
					integerItem(
						"reminderMaxTurns",
						"Reminder max turns",
						"Maximum turns before a reminder is due.",
						(value) =>
							value < settings.reminderMinTurns
								? `Maximum turns cannot be below ${settings.reminderMinTurns}.`
								: undefined,
					),
					integerItem(
						"reminderOutputTokens",
						"Reminder output tokens",
						"Output-token threshold for a stale-plan reminder.",
					),
					integerItem(
						"reminderMaxPerRun",
						"Reminders per run",
						"Maximum dynamic reminders during one agent run.",
					),
				];

				const container = new Container();
				container.addChild(
					new Text(
						theme.fg("accent", theme.bold("Todo Settings · Global")),
						1,
						1,
					),
				);
				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, value) => {
						settings = applySetting(settings, id, value);
						const next = { ...settings };
						saveQueue = saveQueue
							.then(async () => {
								await save(next);
								await options.onSaved?.(next, ctx);
							})
							.catch((error) =>
								ctx.ui.notify(
									`Could not save todo settings: ${errorMessage(error)}`,
									"warning",
								),
							);
					},
					() => done(undefined),
				);
				container.addChild(settingsList);

				return {
					get focused() {
						return focused;
					},
					set focused(value: boolean) {
						focused = value;
						if (activeInput) activeInput.focused = value;
					},
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						settingsList.handleInput(data);
						tui.requestRender();
					},
				};
			});
			await saveQueue;
		},
	});
}

function integerInput(
	input: Input,
	currentValue: string,
	label: string,
	theme: Theme,
) {
	return {
		render(width: number): string[] {
			const inputWidth = Math.max(1, width - 2);
			return [
				truncateToWidth(theme.fg("accent", ` ${label}`), width),
				truncateToWidth(theme.fg("muted", ` Current: ${currentValue}`), width),
				"",
				...input.render(inputWidth).map((line) => `  ${line}`),
				"",
				truncateToWidth(theme.fg("dim", " Enter save · Esc back"), width),
			];
		},
		handleInput: (data: string) => input.handleInput(data),
		invalidate: () => input.invalidate(),
	};
}

function positiveInteger(value: string): number | undefined {
	const parsed = Number(value.trim());
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function applySetting(
	settings: TodoSettings,
	id: string,
	value: string,
): TodoSettings {
	if (isIntegerSetting(id)) return { ...settings, [id]: Number(value) };
	if (id === "fallbackGlyphs" || id === "dynamicReminders") {
		return { ...settings, [id]: value === "true" };
	}
	if (
		id === "widgetPlacement" &&
		(value === "aboveEditor" || value === "belowEditor" || value === "off")
	) {
		return { ...settings, widgetPlacement: value };
	}
	if (
		id === "toolVisibility" &&
		(value === "all" || value === "set-only" || value === "none")
	) {
		return { ...settings, toolVisibility: value };
	}
	return settings;
}

function isIntegerSetting(value: string): value is IntegerSetting {
	return [
		"maxVisibleTasks",
		"reminderMinTurns",
		"reminderMaxTurns",
		"reminderOutputTokens",
		"reminderMaxPerRun",
	].includes(value as IntegerSetting);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
