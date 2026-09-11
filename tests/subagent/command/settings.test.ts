import { expect, mock, test } from "bun:test";
import { SubagentSettingsComponent } from "../../../extensions/subagent/command/settings.js";
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
