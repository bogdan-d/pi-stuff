import { open } from "node:fs/promises";
import {
	copyToClipboard,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Focusable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentRunHistory, AgentRunListItem } from "./run-history.js";
import type { DelegatedAgentManager } from "./runs.js";
import type { AgentRunSnapshot } from "./types.js";

const OUTPUT_PAGE_BYTES = 64 * 1024;

interface OutputPage {
	text: string;
	nextOffset: number;
	done: boolean;
}

interface LoadedOutputPage extends OutputPage {
	id: string;
	lines: string[];
}

async function readOutputPage(
	path: string,
	offset: number,
): Promise<OutputPage> {
	const file = await open(path, "r");
	try {
		const buffer = Buffer.alloc(OUTPUT_PAGE_BYTES);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
		const nextOffset = offset + bytesRead;
		return {
			text: buffer.subarray(0, bytesRead).toString("utf8"),
			nextOffset,
			done: bytesRead < buffer.length || nextOffset >= (await file.stat()).size,
		};
	} finally {
		await file.close();
	}
}

function elapsed(
	run: AgentRunListItem | AgentRunSnapshot,
	now = Date.now(),
): string {
	const end = run.completedAt ?? now;
	const start = run.startedAt ?? run.createdAt;
	const seconds = Math.max(0, Math.floor((end - start) / 1_000));
	return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatTime(value: number | undefined): string {
	return value === undefined
		? "--:--:--"
		: new Date(value).toLocaleTimeString();
}

export function formatAgentSummary(history: AgentRunHistory): string {
	const runs = history.listSummaries();
	if (!runs.length) return "No delegated-agent runs on this session branch.";
	return runs
		.slice(0, 12)
		.map(
			(run) =>
				`${run.status.padEnd(9)} ${run.agent} ${run.mode} ${run.id} — ${run.task.replaceAll(/\s+/g, " ").slice(0, 80)}`,
		)
		.join("\n");
}

export class AgentInspectorComponent implements Focusable {
	readonly width = 88;
	focused = false;
	#selectedId: string | undefined;
	#view: "list" | "detail" | "filter" | "confirm" = "list";
	#filter = "";
	#status = "";
	#detailScroll = 0;
	#listOffset = 0;
	#loadedOutput: LoadedOutputPage | undefined;
	#summaries: AgentRunListItem[];
	#disposed = false;
	readonly #history: AgentRunHistory;
	readonly #manager: DelegatedAgentManager;
	readonly #theme: Theme;
	readonly #requestRender: () => void;
	readonly #done: () => void;
	readonly #copy: (text: string) => Promise<void>;
	readonly #read: (path: string, offset: number) => Promise<OutputPage>;
	readonly #unsubscribe: () => void;
	readonly #timer: ReturnType<typeof setInterval>;

	constructor(options: {
		history: AgentRunHistory;
		manager: DelegatedAgentManager;
		theme: Theme;
		requestRender: () => void;
		done: () => void;
		copy?: (text: string) => Promise<void>;
		read?: (path: string, offset: number) => Promise<OutputPage>;
	}) {
		this.#history = options.history;
		this.#manager = options.manager;
		this.#theme = options.theme;
		this.#requestRender = options.requestRender;
		this.#done = options.done;
		this.#copy = options.copy ?? copyToClipboard;
		this.#read = options.read ?? readOutputPage;
		this.#summaries = this.#history.listSummaries();
		this.#selectedId = this.#runs()[0]?.id;
		this.#unsubscribe = this.#history.subscribe(() => this.#refresh(true));
		this.#timer = setInterval(() => this.#requestRender(), 1_000);
	}

	handleInput(data: string): void {
		if (this.#view === "filter") {
			if (matchesKey(data, "escape") || matchesKey(data, "return")) {
				this.#view = "list";
			} else if (matchesKey(data, "backspace")) {
				this.#filter = this.#filter.slice(0, -1);
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.#filter += data;
			}
			this.#refresh(true);
			return;
		}
		if (this.#view === "confirm") {
			if (data.toLowerCase() === "y") this.#cancelSelected();
			if (
				data.toLowerCase() === "y" ||
				data.toLowerCase() === "n" ||
				matchesKey(data, "escape")
			)
				this.#view = "list";
			this.#refresh(true);
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.#view === "detail") this.#view = "list";
			else this.#close();
		} else if (data === "q") {
			this.#close();
		} else if (data === "/" && this.#view === "list") {
			this.#view = "filter";
		} else if (matchesKey(data, "up") || data === "k") {
			if (this.#view === "detail")
				this.#detailScroll = Math.max(0, this.#detailScroll - 1);
			else this.#move(-1);
		} else if (matchesKey(data, "down") || data === "j") {
			if (this.#view === "detail")
				this.#detailScroll = Math.min(
					Math.max(0, this.#renderDetail().length - 1),
					this.#detailScroll + 1,
				);
			else this.#move(1);
		} else if (matchesKey(data, "return") && this.#selected()) {
			this.#view = "detail";
			this.#detailScroll = 0;
		} else if (data === "c" && this.#cancellable(this.#selected())) {
			this.#view = "confirm";
		} else if (data === "y") {
			void this.#copyId();
		} else if (data === "f" && this.#view === "detail") {
			void this.#loadFullOutput();
		} else if (data === "r") {
			this.#refresh(true);
		}
		this.#requestRender();
	}

	render(width: number): string[] {
		const w = Math.max(20, Math.min(width, this.width));
		const inner = w - 2;
		const row = (content = "") => {
			const clipped = truncateToWidth(content, inner, "…", true);
			return `${this.#theme.fg("border", "│")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${this.#theme.fg("border", "│")}`;
		};
		const lines = [this.#theme.fg("border", `╭${"─".repeat(inner)}╮`)];
		const detail = this.#view === "detail";
		const content = detail ? this.#renderDetail() : this.#renderList();
		const visible = detail
			? content.slice(this.#detailScroll, this.#detailScroll + 26)
			: content.slice(0, 28);
		for (const line of visible) lines.push(row(line));
		if (detail)
			lines.push(
				row(" Esc back · ↑↓ scroll · f full output · c cancel · y copy ID"),
			);
		lines.push(this.#theme.fg("border", `╰${"─".repeat(inner)}╯`));
		return lines;
	}

	invalidate(): void {
		this.#requestRender();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearInterval(this.#timer);
		this.#unsubscribe();
	}

	#renderList(): string[] {
		const runs = this.#runs();
		const active = runs.filter(
			(run) => run.status === "queued" || run.status === "running",
		).length;
		const lines = [
			` ${this.#theme.fg("accent", "Delegated agents")}  ${active} active · ${runs.length - active} finished`,
			this.#view === "filter"
				? ` Filter: ${this.#filter}_`
				: this.#filter
					? ` Filter: ${this.#filter}`
					: "",
		];
		if (!runs.length) lines.push(" No matching delegated-agent runs.");
		else if (runs.length > 20)
			lines.push(
				` ${this.#theme.fg("dim", `showing ${this.#listOffset + 1}-${Math.min(runs.length, this.#listOffset + 20)} of ${runs.length}`)}`,
			);
		let historyAdded = false;
		for (const run of runs.slice(this.#listOffset, this.#listOffset + 20)) {
			if (
				!historyAdded &&
				run.status !== "queued" &&
				run.status !== "running"
			) {
				lines.push(` ${this.#theme.fg("dim", "─ history ─")}`);
				historyAdded = true;
			}
			const selected = run.id === this.#selectedId ? ">" : " ";
			const inherited = run.inherited ? " inherited" : "";
			lines.push(
				`${selected} ${this.#displayStatus(run).padEnd(11)} ${run.agent.padEnd(14).slice(0, 14)} ${run.mode === "foreground" ? "fg" : "bg"} ${elapsed(run)} ${run.task.replaceAll(/\s+/g, " ")}${inherited}`,
			);
		}
		if (this.#view === "confirm")
			lines.push(" Cancel this background run? y/n");
		if (this.#status) lines.push(` ${this.#theme.fg("dim", this.#status)}`);
		lines.push(
			"",
			" ↑↓/jk select · Enter inspect · / filter · c cancel · y copy ID · Esc close",
		);
		return lines;
	}

	#renderDetail(): string[] {
		const run = this.#selected();
		if (!run) return [" Delegated agent no longer available."];
		const usage = run.usage
			? `${run.usage.totalTokens} tokens · $${run.usage.cost.total.toFixed(4)}`
			: "usage unavailable";
		const lines = [
			` ${this.#theme.fg("accent", run.agent)} · ${run.id}${run.inherited ? " · inherited" : ""}`,
			` ${this.#displayStatus(run)} · ${run.mode} · ${run.role} · ${run.model}${run.thinking ? `:${run.thinking}` : ""}`,
			` ${run.cwd}`,
			` created ${formatTime(run.createdAt)} · started ${formatTime(run.startedAt)} · elapsed ${elapsed(run)}`,
			` ${usage}`,
			"",
			" Task",
			...run.task.split("\n").map((line) => ` ${line}`),
			"",
			" Timeline",
		];
		if (run.omittedTimelineEvents)
			lines.push(` … ${run.omittedTimelineEvents} earlier events omitted`);
		for (const event of run.timeline)
			lines.push(
				` ${formatTime(event.startedAt)}  ${event.tool}  ${event.summary}  ${event.status}`,
			);
		if (run.error) {
			lines.push("", " Error");
			lines.push(...run.error.split("\n").map((line) => ` ${line}`));
		}
		lines.push("", " Output");
		const loaded =
			this.#loadedOutput?.id === run.id ? this.#loadedOutput : undefined;
		lines.push(
			...(
				loaded?.lines ??
				run.output?.split("\n") ?? ["(output unavailable)"]
			).map((line) => ` ${line}`),
		);
		if (this.#status) lines.push("", ` ${this.#theme.fg("dim", this.#status)}`);
		return lines;
	}

	#runs(): AgentRunListItem[] {
		return this.#summaries;
	}

	#selected(): AgentRunSnapshot | undefined {
		return this.#selectedId ? this.#history.get(this.#selectedId) : undefined;
	}

	#move(delta: number): void {
		const runs = this.#runs();
		if (!runs.length) return;
		const index = Math.max(
			0,
			runs.findIndex((run) => run.id === this.#selectedId),
		);
		const next = Math.max(0, Math.min(runs.length - 1, index + delta));
		this.#selectedId = runs[next]?.id;
		if (next < this.#listOffset) this.#listOffset = next;
		if (next >= this.#listOffset + 20) this.#listOffset = next - 19;
		this.#loadedOutput = undefined;
		this.#status = "";
		this.#detailScroll = 0;
	}

	#refresh(reload = false): void {
		if (reload) this.#summaries = this.#history.listSummaries(this.#filter);
		const runs = this.#runs();
		const previousId = this.#selectedId;
		if (!runs.some((run) => run.id === previousId))
			this.#selectedId = runs[0]?.id;
		if (this.#selectedId !== previousId) {
			this.#loadedOutput = undefined;
			this.#status = "";
			this.#detailScroll = 0;
		}
		const selectedIndex = runs.findIndex((run) => run.id === this.#selectedId);
		const maxOffset = Math.max(0, runs.length - 20);
		this.#listOffset = Math.min(this.#listOffset, maxOffset);
		if (selectedIndex >= 0) {
			if (selectedIndex < this.#listOffset) this.#listOffset = selectedIndex;
			if (selectedIndex >= this.#listOffset + 20)
				this.#listOffset = Math.min(maxOffset, selectedIndex - 19);
		}
		this.#requestRender();
	}

	#cancellable(run: AgentRunSnapshot | undefined): boolean {
		return (
			!!run &&
			!run.inherited &&
			run.mode === "background" &&
			(run.status === "queued" || run.status === "running")
		);
	}

	#cancelSelected(): void {
		const run = this.#selected();
		if (!this.#cancellable(run) || !run) return;
		try {
			this.#manager.cancel(run.id);
			this.#status = "Cancellation requested.";
		} catch (error) {
			this.#status = error instanceof Error ? error.message : String(error);
		}
	}

	async #copyId(): Promise<void> {
		const run = this.#selected();
		if (!run) return;
		try {
			await this.#copy(run.id);
			this.#status = "Run ID copied.";
		} catch (error) {
			this.#status = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.#requestRender();
	}

	async #loadFullOutput(): Promise<void> {
		const run = this.#selected();
		if (!run?.fullOutputPath) {
			this.#status = "No retained full-output file.";
			this.#requestRender();
			return;
		}
		const id = run.id;
		const current =
			this.#loadedOutput?.id === id ? this.#loadedOutput : undefined;
		if (current?.done) {
			this.#status = "End of full output reached.";
			this.#requestRender();
			return;
		}
		const offset = current?.nextOffset ?? 0;
		try {
			const page = await this.#read(run.fullOutputPath, offset);
			if (this.#selectedId !== id) return;
			this.#loadedOutput = {
				...page,
				id,
				lines: page.text.split("\n"),
			};
			this.#detailScroll = 0;
			this.#status = page.done
				? "Full output page loaded · end reached."
				: `Full output page loaded · press f for bytes ${page.nextOffset + 1} onward.`;
		} catch (error) {
			if (this.#selectedId !== id) return;
			this.#status = `Full output unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.#requestRender();
	}

	#displayStatus(run: AgentRunListItem | AgentRunSnapshot): string {
		return run.inherited && run.status === "cancelled"
			? "interrupted"
			: run.status;
	}

	#close(): void {
		this.dispose();
		this.#done();
	}
}

export function registerAgentInspector(
	pi: ExtensionAPI,
	history: AgentRunHistory,
	manager: DelegatedAgentManager,
): void {
	pi.registerCommand("agents", {
		description: "Inspect delegated agents on the current session branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(formatAgentSummary(history), "info");
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new AgentInspectorComponent({
						history,
						manager,
						theme,
						requestRender: () => tui.requestRender(),
						done,
					}),
				{
					overlay: true,
					overlayOptions: { width: 88, minWidth: 30, maxHeight: "90%" },
				},
			);
		},
	});
}
