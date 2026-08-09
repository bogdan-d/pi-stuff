import { describe, expect, it, mock } from "bun:test";
import { registerSubagentsCommand } from "../../../extensions/subagent/command/index.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../../extensions/subagent/settings.js";
import { eventually } from "../helpers/eventually.js";
import { fakeAgent } from "../helpers/fake-agent.js";

describe("subagents command registration", () => {
	it("applies settings before starting work and persists them", async () => {
		let handler: any;
		const configure = mock();
		const startTasks = mock(() => ({
			starts: [{ ok: true, conversationId: "c2", generation: 1 }],
		}));
		const manager = {
			configure,
			startTasks,
			listConversations: () => [],
			onConversationUpdate: () => () => {},
			removeConversation: mock(),
		};
		const save = mock(async () => {});
		registerSubagentsCommand(
			{
				registerCommand: (_name: string, registration: any) => {
					handler = registration.handler;
				},
			} as any,
			manager as any,
			{ load: async () => ({ settings: DEFAULT_SUBAGENT_SETTINGS }), save },
		);
		const ctx = {
			hasUI: true,
			ui: {
				custom: async (factory: any) => {
					const component = factory(
						{ requestRender() {} },
						{},
						undefined,
						() => {},
					);
					component.options.onSettingsChange({
						kind: "maxConcurrentSubagents",
						value: 8,
					});
					component.options.onStart("worker", "work");
				},
			},
		};

		await handler("settings", ctx);

		expect(configure).toHaveBeenLastCalledWith({
			maxExecuting: 8,
			maxConversations: 100,
		});
		expect(configure.mock.invocationCallOrder.at(-1)).toBeLessThan(
			startTasks.mock.invocationCallOrder[0],
		);
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({
				runtime: expect.objectContaining({ maxConcurrentSubagents: 8 }),
			}),
		);
	});

	it("refreshes the widget when settings open and display settings change", async () => {
		let handler: any;
		const setWidget = mock();
		const manager = {
			configure: mock(),
			listConversations: () => [
				fakeAgent({ status: { kind: "running", startedAt: 1 } }),
			],
			onConversationUpdate: () => () => {},
		};
		registerSubagentsCommand(
			{
				registerCommand: (_name: string, registration: any) => {
					handler = registration.handler;
				},
			} as any,
			manager as any,
			{
				load: async () => ({ settings: DEFAULT_SUBAGENT_SETTINGS }),
				save: async () => {},
			},
		);

		await handler("settings", {
			hasUI: true,
			ui: {
				setWidget,
				custom: async (factory: any) => {
					const component = factory(
						{ requestRender() {} },
						{},
						undefined,
						() => {},
					);
					component.options.onSettingsChange({
						kind: "widgetMode",
						value: "progress",
					});
					component.options.onSettingsChange({
						kind: "widgetMaxRowsPerSection",
						value: 8,
					});
					component.options.onSettingsChange({
						kind: "widgetPlacement",
						value: "aboveEditor",
					});
				},
			},
		});

		expect(setWidget).toHaveBeenCalledTimes(4);
	});

	it("serializes rapid settings saves", async () => {
		let handler: any;
		const saved: number[] = [];
		let releaseFirst: (() => void) | undefined;
		const manager = {
			configure: mock(),
			listConversations: () => [],
			onConversationUpdate: () => () => {},
		};
		registerSubagentsCommand(
			{
				registerCommand: (_name: string, registration: any) => {
					handler = registration.handler;
				},
			} as any,
			manager as any,
			{
				load: async () => ({ settings: DEFAULT_SUBAGENT_SETTINGS }),
				save: async (settings) => {
					saved.push(settings.runtime.maxConcurrentSubagents);
					if (saved.length === 1)
						await new Promise<void>((resolve) => {
							releaseFirst = resolve;
						});
				},
			},
		);
		const handling = handler("settings", {
			hasUI: true,
			ui: {
				custom: async (factory: any) => {
					const component = factory(
						{ requestRender() {} },
						{},
						undefined,
						() => {},
					);
					component.options.onSettingsChange({
						kind: "maxConcurrentSubagents",
						value: 8,
					});
					component.options.onSettingsChange({
						kind: "maxConcurrentSubagents",
						value: 16,
					});
				},
			},
		});

		await eventually(() => expect(saved).toEqual([8]));
		releaseFirst?.();
		await handling;
		expect(saved).toEqual([8, 16]);
	});

	it("collects completed results through a released runtime join binding", async () => {
		let handler: any;
		const markJoined = mock();
		const release = mock();
		const notify = mock();
		const manager = {
			configure: mock(),
			listConversations: () => [],
			onConversationUpdate: () => () => {},
			bindSubagentJoin: mock(() => ({
				completion: Promise.resolve(),
				markJoined,
				release,
			})),
		};
		registerSubagentsCommand(
			{
				registerCommand: (_name: string, registration: any) => {
					handler = registration.handler;
				},
			} as any,
			manager as any,
			{
				load: async () => ({ settings: DEFAULT_SUBAGENT_SETTINGS }),
				save: async () => {},
			},
		);

		await handler("conversations", {
			hasUI: true,
			ui: {
				notify,
				custom: async (factory: any) => {
					const component = factory(
						{ requestRender() {} },
						{},
						undefined,
						() => {},
					);
					await component.options.onCollect("c1");
				},
			},
		});

		expect(manager.bindSubagentJoin).toHaveBeenCalledWith(["c1"]);
		expect(markJoined).toHaveBeenCalledOnce();
		expect(markJoined.mock.invocationCallOrder[0]).toBeLessThan(
			release.mock.invocationCallOrder[0],
		);
		expect(notify).toHaveBeenCalledWith("Collected subagent c1.", "info");
	});

	it("reports asynchronous settings save failures", async () => {
		let handler: any;
		const notify = mock();
		const manager = {
			configure: mock(),
			listConversations: () => [],
			onConversationUpdate: () => () => {},
		};
		registerSubagentsCommand(
			{
				registerCommand: (_name: string, registration: any) => {
					handler = registration.handler;
				},
			} as any,
			manager as any,
			{
				load: async () => ({ settings: DEFAULT_SUBAGENT_SETTINGS }),
				save: async () => {
					throw new Error("disk full");
				},
			},
		);

		await handler("settings", {
			hasUI: true,
			ui: {
				notify,
				custom: async (factory: any) => {
					const component = factory(
						{ requestRender() {} },
						{},
						undefined,
						() => {},
					);
					component.options.onSettingsChange({
						kind: "maxConcurrentSubagents",
						value: 8,
					});
				},
			},
		});

		expect(notify).toHaveBeenCalledWith(
			"Could not save subagent settings: disk full",
			"warning",
		);
	});
});
