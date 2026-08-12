import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
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
	type AskSettings,
	AskSettingsStore,
	loadAskSettings,
	MAX_TIMEOUT_MS,
} from "./settings.js";

type AskSettingsPersistence = Pick<AskSettingsStore, "load" | "save">;

export function registerAskSettingsCommand(
	pi: Pick<ExtensionAPI, "registerCommand">,
	settingsStore: AskSettingsPersistence = new AskSettingsStore(),
): void {
	pi.registerCommand("ask-settings", {
		description: "Configure ask timeouts",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/ask-settings requires TUI mode", "error");
				return;
			}

			let settings = await loadAskSettings(ctx, settingsStore);
			let saveQueue = Promise.resolve();
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				let focused = false;
				let activeInput: Input | undefined;
				const items: SettingItem[] = [
					{
						id: "timeoutMs",
						label: "Timeout (ms)",
						description:
							"Deadline used when an ask call enables timeout. Enter a positive millisecond value.",
						currentValue: String(settings.timeoutMs),
						submenu: (currentValue, close) => {
							const input = new Input();
							activeInput = input;
							input.focused = focused;
							const finish = (value?: string) => {
								activeInput = undefined;
								close(value);
							};
							input.onSubmit = (value) => {
								const timeoutMs = parseTimeoutMs(value);
								if (timeoutMs === undefined) {
									ctx.ui.notify(
										`Timeout must be an integer from 1 to ${MAX_TIMEOUT_MS}.`,
										"warning",
									);
									return;
								}
								finish(String(timeoutMs));
							};
							input.onEscape = () => finish();
							return timeoutInput(input, currentValue, theme);
						},
					},
					{
						id: "timeoutOnInput",
						label: "On input",
						description:
							"reset restarts the deadline; cancel disables it; never-reset keeps the original deadline.",
						currentValue: settings.timeoutOnInput,
						values: ["reset", "cancel", "never-reset"],
					},
				];

				const container = new Container();
				container.addChild(
					new Text(theme.fg("accent", theme.bold("Ask Settings")), 1, 1),
				);
				const settingsList = new SettingsList(
					items,
					items.length + 2,
					getSettingsListTheme(),
					(id, value) => {
						settings = applySetting(settings, id, value);
						const next = { ...settings };
						saveQueue = saveQueue
							.then(() => settingsStore.save(next))
							.catch((error) =>
								ctx.ui.notify(
									`Could not save ask settings: ${errorMessage(error)}`,
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

function timeoutInput(input: Input, currentValue: string, theme: Theme) {
	return {
		render(width: number): string[] {
			const inputWidth = Math.max(1, width - 2);
			return [
				truncateToWidth(theme.fg("accent", " Timeout (milliseconds)"), width),
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

function parseTimeoutMs(value: string): number | undefined {
	const parsed = Number(value.trim());
	return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_TIMEOUT_MS
		? parsed
		: undefined;
}

function applySetting(
	settings: AskSettings,
	id: string,
	value: string,
): AskSettings {
	if (id === "timeoutMs") {
		return { ...settings, timeoutMs: Number(value) };
	}
	if (
		id === "timeoutOnInput" &&
		(value === "reset" || value === "cancel" || value === "never-reset")
	) {
		return { ...settings, timeoutOnInput: value };
	}
	return settings;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
