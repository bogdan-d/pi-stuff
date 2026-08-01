import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	AgentInspectorComponent,
	formatAgentSummary,
	registerAgentInspector,
} from "../extensions/delegated-agents/inspector.js";
import { AgentRunHistory } from "../extensions/delegated-agents/run-history.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function historyWithRuns() {
	const history = new AgentRunHistory();
	history.register({
		id: "active",
		mode: "background",
		status: "running",
		agent: "review",
		role: "review",
		task: "Inspect parser",
		cwd: "/repo",
		model: "provider/model",
		createdAt: 1,
		startedAt: 1,
	});
	history.register({
		id: "done",
		mode: "foreground",
		status: "completed",
		agent: "planning",
		role: "planning",
		task: "Plan migration",
		cwd: "/repo",
		model: "provider/model",
		createdAt: 0,
		completedAt: 2,
	});
	return history;
}

describe("delegated-agent inspector", () => {
	test("renders mixed and narrow states within width", () => {
		const component = new AgentInspectorComponent({
			history: historyWithRuns(),
			manager: {} as never,
			theme,
			requestRender() {},
			done() {},
		});
		const lines = component.render(40);
		expect(lines.join("\n")).toContain("history");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
		component.dispose();
		component.dispose();
	});

	test("filters, inspects, copies, and confirms cancellation", async () => {
		const cancelled: string[] = [];
		const copied: string[] = [];
		const component = new AgentInspectorComponent({
			history: historyWithRuns(),
			manager: { cancel: (id: string) => cancelled.push(id) } as never,
			theme,
			requestRender() {},
			done() {},
			copy: async (id) => {
				copied.push(id);
			},
		});
		component.handleInput("/");
		for (const char of "parser") component.handleInput(char);
		component.handleInput("\r");
		expect(component.render(88).join("\n")).not.toContain("Plan migration");
		component.handleInput("y");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(copied).toEqual(["active"]);
		component.handleInput("c");
		expect(cancelled).toEqual([]);
		component.handleInput("y");
		expect(cancelled).toEqual(["active"]);
		component.handleInput("\r");
		expect(component.render(88).join("\n")).toContain("Inspect parser");
		component.dispose();
	});

	test("uses notification instead of custom UI outside TUI", async () => {
		let command: any;
		const notifications: string[] = [];
		registerAgentInspector(
			{
				registerCommand: (_name: string, value: any) => {
					command = value;
				},
			} as never,
			historyWithRuns(),
			{} as never,
		);
		await command.handler("", {
			mode: "print",
			ui: {
				notify: (message: string) => notifications.push(message),
				custom: () => {
					throw new Error("custom called");
				},
			},
		});
		expect(notifications[0]).toContain("active");
		expect(formatAgentSummary(new AgentRunHistory())).toContain("No delegated");
	});

	test("loads full output only on request and reports read failures", async () => {
		const history = historyWithRuns();
		history.update("done", { fullOutputPath: "/tmp/output.md" });
		let reads = 0;
		const component = new AgentInspectorComponent({
			history,
			manager: {} as never,
			theme,
			requestRender() {},
			done() {},
			read: async () => {
				reads++;
				throw new Error("missing");
			},
		});
		component.handleInput("j");
		component.handleInput("\r");
		expect(reads).toBe(0);
		component.handleInput("f");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(reads).toBe(1);
		expect(component.render(88).join("\n")).toContain(
			"Full output unavailable",
		);
		component.dispose();
	});

	test("discards stale full-output reads after selection changes", async () => {
		const history = historyWithRuns();
		history.update("done", { fullOutputPath: "/tmp/output.md" });
		let resolveRead!: (page: {
			text: string;
			nextOffset: number;
			done: boolean;
		}) => void;
		const component = new AgentInspectorComponent({
			history,
			manager: {} as never,
			theme,
			requestRender() {},
			done() {},
			read: () =>
				new Promise((resolve) => {
					resolveRead = resolve;
				}),
		});
		component.handleInput("j");
		component.handleInput("\r");
		component.handleInput("f");
		component.handleInput("\x1b");
		component.handleInput("k");
		resolveRead({ text: "stale secret", nextOffset: 12, done: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		component.handleInput("\r");
		expect(component.render(88).join("\n")).not.toContain("stale secret");
		component.dispose();
	});

	test("pages full output with bounded offsets", async () => {
		const history = historyWithRuns();
		history.update("done", { fullOutputPath: "/tmp/output.md" });
		const offsets: number[] = [];
		const component = new AgentInspectorComponent({
			history,
			manager: {} as never,
			theme,
			requestRender() {},
			done() {},
			read: async (_path, offset) => {
				offsets.push(offset);
				return {
					text: offset ? "page two" : "page one",
					nextOffset: offset ? 16 : 8,
					done: offset > 0,
				};
			},
		});
		component.handleInput("j");
		component.handleInput("\r");
		component.handleInput("f");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(component.render(88).join("\n")).toContain("page one");
		component.handleInput("f");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(offsets).toEqual([0, 8]);
		expect(component.render(88).join("\n")).toContain("page two");
		component.dispose();
	});

	test("renders failed output separately from its error", () => {
		const history = new AgentRunHistory();
		history.register({
			id: "failed",
			mode: "foreground",
			status: "running",
			agent: "review",
			role: "review",
			task: "Fail",
			cwd: "/repo",
			model: "provider/model",
			createdAt: 1,
		});
		history.update("failed", {
			status: "failed",
			completedAt: 2,
			error: "transport error",
			output: "useful partial output",
		});
		const component = new AgentInspectorComponent({
			history,
			manager: {} as never,
			theme,
			requestRender() {},
			done() {},
		});
		component.handleInput("\r");
		const rendered = component.render(88).join("\n");
		expect(rendered).toContain("transport error");
		expect(rendered).toContain("useful partial output");
		expect(rendered).toContain(" Error");
		expect(rendered).toContain(" Output");
		component.dispose();
	});

	test("recenters the list when filtering replaces an off-page selection", () => {
		const history = new AgentRunHistory();
		for (let index = 0; index < 25; index++) {
			const id = String(index);
			history.register({
				id,
				mode: "foreground",
				status: "running",
				agent: "review",
				role: "review",
				task: `task-${index}`,
				cwd: "/repo",
				model: "provider/model",
				createdAt: index,
			});
			history.update(id, { status: "completed", completedAt: index + 1 });
		}
		const component = new AgentInspectorComponent({
			history,
			manager: {} as never,
			theme,
			requestRender() {},
			done() {},
		});
		for (let index = 0; index < 22; index++) component.handleInput("j");
		component.handleInput("/");
		for (const char of "task-24") component.handleInput(char);
		component.handleInput("\r");
		const rendered = component.render(88).join("\n");
		expect(rendered).toContain("> completed");
		expect(rendered).toContain("task-24");
		component.dispose();
	});
});
