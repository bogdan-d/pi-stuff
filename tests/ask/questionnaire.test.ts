import { describe, expect, it, jest, mock } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { AskComponent } from "../../extensions/ask/component.js";
import { launchQuestionnaire } from "../../extensions/ask/questionnaire.js";

const components: AskComponent[] = [];

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

function createComponent(
	factory: any,
	done: (value: unknown) => void,
): AskComponent {
	const component = factory(
		{ terminal: { rows: 24 }, requestRender: mock() },
		theme(),
		new KeybindingsManager(TUI_KEYBINDINGS, {}),
		done,
	);
	components.push(component);
	return component;
}

const deadline = (
	signal = new AbortController().signal,
	deadlineAt?: number,
) => ({
	signal,
	deadlineAt,
	timedOut: false,
	handleInput: mock(() => false),
	dispose: mock(),
});

const params = {
	question: "Choose",
	context: "Context",
	options: [{ label: "A" }],
	allowMultiple: false,
	allowFreeform: true,
};

function uiHarness(action: "submit" | "cancel" | "deadline" = "submit") {
	const custom = mock((factory: any) => {
		let result: unknown;
		const component = createComponent(factory, (value) => {
			result = value;
		});
		if (action === "submit") component.handleInput("\r");
		else if (action === "cancel") component.handleInput("\x1b");
		else {
			component.handleInput("\x1b[B");
			component.cancel();
		}
		component.dispose();
		return result;
	});
	return { ui: { custom }, custom };
}

describe("launchQuestionnaire", () => {
	it("launches a fresh custom component and returns its answer", async () => {
		const first = uiHarness();
		const second = uiHarness();
		await expect(
			launchQuestionnaire({ ui: first.ui }, params),
		).resolves.toEqual({ selections: [{ option: 0 }] });
		await launchQuestionnaire({ ui: second.ui }, params);

		expect(components.at(-2)).not.toBe(components.at(-1));
		expect(second.custom).toHaveBeenCalledWith(expect.any(Function));
	});

	it("passes active deadline input handling to the component", async () => {
		const { ui } = uiHarness("deadline");
		const activeDeadline = deadline(new AbortController().signal, 12_345);

		await launchQuestionnaire({ ui }, params, activeDeadline);

		expect(activeDeadline.handleInput).toHaveBeenCalledOnce();
	});

	it("returns null when the component cancels", async () => {
		const { ui } = uiHarness("cancel");
		await expect(launchQuestionnaire({ ui }, params)).resolves.toBeNull();
	});

	it("normalizes an unexpected undefined custom result to null", async () => {
		const custom = mock().mockResolvedValue(undefined);
		await expect(
			launchQuestionnaire({ ui: { custom } }, params),
		).resolves.toBeNull();
	});

	it.each(["success", "cancel", "error"])(
		"removes its abort listener after %s",
		async (outcome) => {
			const signal = new AbortController().signal;
			const add = jest.spyOn(signal, "addEventListener");
			const remove = jest.spyOn(signal, "removeEventListener");
			const harness = uiHarness(outcome === "cancel" ? "cancel" : "submit");
			if (outcome === "error")
				harness.ui.custom = mock(async (factory: any) => {
					createComponent(factory, mock());
					throw new Error("UI failed");
				});

			const result = launchQuestionnaire(
				{ ui: harness.ui },
				params,
				deadline(signal),
			);
			if (outcome === "error")
				await expect(result).rejects.toThrow("UI failed");
			else await result;

			expect(add).toHaveBeenCalledWith("abort", expect.any(Function), {
				once: true,
			});
			expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
		},
	);

	it("cancels the active component when aborted", async () => {
		const controller = new AbortController();
		const custom = mock(
			(factory: any) =>
				new Promise<any>((resolve) => {
					createComponent(factory, resolve);
				}),
		);
		const result = launchQuestionnaire(
			{ ui: { custom } },
			params,
			deadline(controller.signal),
		);
		controller.abort();
		await expect(result).resolves.toBeNull();
		expect(components.at(-1)?.isCancelled).toBe(true);
	});
});
