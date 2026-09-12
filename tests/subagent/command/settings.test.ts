import { expect, mock, test } from "bun:test";
import {
	applySubagentSettingsChange,
	SubagentSettingsComponent,
} from "../../../extensions/subagent/command/settings.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../../extensions/subagent/settings.js";

test("restore setting stays reachable in short modals and requires session saving", () => {
	const changes: unknown[] = [];
	const component = new SubagentSettingsComponent(
		DEFAULT_SUBAGENT_SETTINGS,
		{} as any,
		undefined,
		(change) => changes.push(change),
		() => {},
	);
	for (let index = 0; index < 8; index++) component.handleInput("\x1b[B");
	expect(component.render(100, 10).slice(0, 10).join("\n")).toContain(
		"Restore subagents",
	);
	component.handleInput(" ");
	expect(changes).toEqual([]);
	component.handleInput("\x1b[A");
	component.handleInput(" ");
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	expect(changes).toEqual([
		{ kind: "saveSessions", value: true },
		{ kind: "restoreSubagents", value: true },
	]);
});

test("widget preview dims the editor bars without dimming its placeholder", () => {
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	} as any;
	const component = new SubagentSettingsComponent(
		DEFAULT_SUBAGENT_SETTINGS,
		theme,
		undefined,
		mock(),
		mock(),
	);

	const rendered = component.render(200).join("\n");
	expect(rendered).toContain(
		"<dim>│</dim> <text>Ask Pi anything…</text>       <dim>│</dim>",
	);
	expect(rendered).not.toContain("<text>│ Ask Pi anything…       │</text>");
});

test("general-purpose model picker filters, cancels, and saves without changing other defaults", () => {
	let settings = structuredClone(DEFAULT_SUBAGENT_SETTINGS);
	const component = new SubagentSettingsComponent(
		settings,
		{} as any,
		undefined,
		(change) => {
			settings = applySubagentSettingsChange(settings, change);
		},
		() => {},
		() => {},
		["test/alpha", "test/beta"],
	);
	for (let index = 0; index < 9; index++) component.handleInput("\x1b[B");
	component.handleInput(" ");
	component.handleInput("beta");
	expect(component.render(100, 20).join("\n")).toContain("test/beta");
	component.handleInput("\x1b");
	expect(settings.runtime.generalPurposeModel).toBe("inherit");
	component.handleInput(" ");
	component.handleInput("beta");
	component.handleInput("\r");
	expect(settings.runtime.generalPurposeModel).toBe("test/beta");
	expect(component.isEditing).toBe(false);
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	expect(settings.runtime.generalPurposeThinking).toBe("inherit");
	expect(component.render(100, 20).join("\n")).toContain("Inherit parent");
});
