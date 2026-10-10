/**
 * todo-widget: live todo progress above the input, styled to match oxo-ui.
 *
 * Reads the same files as the `todos` extension (<cwd>/.pi/todos/*.md, or $PI_TODO_PATH).
 *
 *   ✔  green pill        done        (status closed | done)
 *   ⠋  yellow pill       in progress (claimed by a session, or status in-progress/doing/working/wip)
 *   ○  plain muted text  not started
 *
 * Right corner of the first line: purple "N subagents" pill while subagents are running.
 * One line by default; Ctrl+Shift+E (or /todo-widget expand|collapse) shows one row per todo.
 * Done todos only show if they were finished during this session. When every todo is done the
 * list stays for a few seconds, then disappears (those todos are not shown again). Command: /todo-widget [on|off]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------- palette (oxocarbon-grey + carbon yellow) ----------
type RGB = [number, number, number];
const P = {
	blue: [0x78, 0xa9, 0xff] as RGB,
	green: [0x42, 0xbe, 0x65] as RGB,
	yellow: [0xf1, 0xc2, 0x1b] as RGB, // carbon yellow30
	purple: [0xbe, 0x95, 0xff] as RGB,
	text: [0xdd, 0xe1, 0xe6] as RGB,
	muted: [0x8d, 0x91, 0x99] as RGB,
	subtle: [0x4d, 0x51, 0x59] as RGB,
	ink: [0x1b, 0x1c, 0x1f] as RGB,
	doneBg: [0x21, 0x34, 0x2a] as RGB, // green tint
	doneFg: [0x8f, 0xdc, 0xa4] as RGB,
	workBg: [0x3b, 0x35, 0x1e] as RGB, // yellow tint
	workFg: [0xf6, 0xd9, 0x6b] as RGB,
};
const RESET = "\x1b[0m";
const fgRaw = ([r, g, b]: RGB) => `\x1b[38;2;${r};${g};${b}m`;
const bgRaw = ([r, g, b]: RGB) => `\x1b[48;2;${r};${g};${b}m`;
const fg = (c: RGB, s: string) => `${fgRaw(c)}${s}${RESET}`;
const CAP_L = "\uE0B6";
const CAP_R = "\uE0B4";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_ROWS = 7;
const EXPAND_KEY = "ctrl+shift+e";
const EXPAND_HINT = "⌃⇧E";
const HIDE_DELAY_MS = 4000; // how long a fully completed list stays visible before it disappears

// ---------- todo files ----------
type State = "done" | "working" | "todo";
interface Item {
	id: string;
	title: string;
	state: State;
	created: string;
	mtime: number;
}

const WORKING_STATUS = new Set(["in-progress", "in_progress", "inprogress", "doing", "working", "started", "wip", "active"]);

function frontMatter(content: string): any {
	if (!content.startsWith("{")) return undefined;
	let depth = 0;
	let inStr = false;
	for (let i = 0; i < content.length; i++) {
		const c = content[i]!;
		if (inStr) {
			if (c === "\\") i++;
			else if (c === '"') inStr = false;
		} else if (c === '"') inStr = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) {
			try {
				return JSON.parse(content.slice(0, i + 1));
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

function todosDir(cwd: string): string {
	const o = process.env.PI_TODO_PATH?.trim();
	return resolve(cwd, o || ".pi/todos");
}

function readTodos(cwd: string, sessionStart: number): Item[] {
	const dir = todosDir(cwd);
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
	const items: Item[] = [];
	for (const f of files) {
		try {
			const path = join(dir, f);
			const fm = frontMatter(readFileSync(path, "utf8"));
			if (!fm || typeof fm.title !== "string") continue;
			const status = String(fm.status ?? "open").toLowerCase();
			const closed = status === "closed" || status === "done";
			const mtime = statSync(path).mtimeMs;
			if (closed && mtime < sessionStart) continue; // old finished work: not interesting here
			const working = !closed && (Boolean(fm.assigned_to_session) || WORKING_STATUS.has(status));
			items.push({
				id: f.replace(/\.md$/, ""),
				title: fm.title.trim() || "(untitled)",
				state: closed ? "done" : working ? "working" : "todo",
				created: String(fm.created_at ?? ""),
				mtime,
			});
		} catch {}
	}
	return items;
}

function pickVisible(items: Item[]): { shown: Item[]; hidden: number } {
	const byCreated = (a: Item, b: Item) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id);
	if (items.length <= MAX_ROWS) return { shown: [...items].sort(byCreated), hidden: 0 };
	// keep in-progress first, then not started, then the most recently finished
	const rank = { working: 0, todo: 1, done: 2 } as const;
	const pri = [...items].sort((a, b) => rank[a.state] - rank[b.state] || (a.state === "done" ? b.mtime - a.mtime : byCreated(a, b)));
	const shown = pri.slice(0, MAX_ROWS).sort(byCreated);
	return { shown, hidden: items.length - MAX_ROWS };
}

// ---------- rendering ----------
function pill(bg: RGB, fgc: RGB, text: string, bold = false): string {
	const b = bold ? "\x1b[1m" : "";
	return `${fgRaw(bg)}${CAP_L}${bgRaw(bg)}${fgRaw(fgc)}${b} ${text} \x1b[22m${RESET}${fgRaw(bg)}${CAP_R}${RESET}`;
}

function progressBar(items: Item[]): string {
	const cells = items.length > 20 ? 20 : items.length;
	const done = items.filter((t) => t.state === "done").length;
	const work = items.filter((t) => t.state === "working").length;
	const scale = (n: number) => Math.round((n / items.length) * cells);
	const nDone = scale(done);
	const nWork = Math.min(cells - nDone, Math.max(work ? 1 : 0, scale(work)));
	let out = fg(P.green, "▰".repeat(nDone));
	out += fg(P.yellow, "▰".repeat(nWork));
	out += fg(P.subtle, "▱".repeat(Math.max(0, cells - nDone - nWork)));
	return out;
}

class TodoWidget {
	items: Item[] = [];
	running = false;
	frame = 0;
	expanded = false; // false: one line, true: one row per todo
	subagents = 0; // running subagents, shown as a pill at the right end of the first line
	hideAt?: number; // set while every todo is done: the list disappears at this time
	private timer?: ReturnType<typeof setInterval>;
	constructor(
		private requestRender: () => void,
		private onExpire: () => void,
	) {
		this.timer = setInterval(() => {
			if (this.hideAt !== undefined && Date.now() >= this.hideAt) {
				this.hideAt = undefined;
				this.onExpire();
				return;
			}
			if (this.running && this.items.some((t) => t.state === "working")) {
				this.frame++;
				this.requestRender();
			}
		}, 100);
	}
	dispose() {
		if (this.timer) clearInterval(this.timer);
	}
	invalidate() {}

	/** One line: [todos] ▰▰▱▱ 2/5  ⠸ current task  · next: following task      ⌃⇧E expand */
	private renderCollapsed(width: number, done: number, spin: string): string {
		const total = this.items.length;
		const working = this.items.filter((t) => t.state === "working");
		const pending = this.items.filter((t) => t.state === "todo");
		let line = ` ${pill(P.blue, P.ink, "\uF0AE todos", true)} ${progressBar(this.items)} ${fg(P.muted, `${done}/${total}`)}`;

		const hint = fg(P.subtle, `${EXPAND_HINT} expand`);
		const used = () => visibleWidth(line);
		const room = (reserve: number) => Math.max(0, width - used() - reserve);

		// current focus
		let focus: string | undefined;
		if (working.length) {
			const extra = working.length > 1 ? ` +${working.length - 1}` : "";
			const title = truncateToWidth(working[0]!.title, Math.max(6, room(hint.length ? visibleWidth(hint) + 6 : 4) - 6 - extra.length), "…");
			focus = pill(P.workBg, P.workFg, `${spin} ${title}${extra}`, true);
		} else if (pending.length) {
			const title = truncateToWidth(pending[0]!.title, Math.max(6, room(visibleWidth(hint) + 6) - 4), "…");
			focus = `${fg(P.subtle, "○")} ${fg(P.muted, title)}`;
		} else {
			focus = fg(P.green, "✔ all done");
		}
		line += "  " + focus;

		// what comes next, if it fits
		const nextTodo = working.length ? pending[0] : pending[1];
		if (nextTodo && room(visibleWidth(hint) + 12) > 14) {
			const title = truncateToWidth(nextTodo.title, room(visibleWidth(hint) + 12) - 8, "…");
			line += fg(P.subtle, "  next: ") + fg(P.muted, title);
		}
		const more = pending.length - (working.length ? 1 : 2);
		if (more > 0 && room(visibleWidth(hint) + 10) >= 8) line += fg(P.subtle, `  +${more}`);

		const gap = width - visibleWidth(line) - visibleWidth(hint) - 1;
		if (gap >= 2) line += " ".repeat(gap) + hint;
		return truncateToWidth(line, width);
	}

	render(width: number): string[] {
		if (width < 20) return [];
		if (this.subagents <= 0) return this.renderTodos(width);

		// subagent pill sits in the right corner of the first line
		const label = `\uF0C0 ${this.subagents} subagent${this.subagents === 1 ? "" : "s"}`;
		const sub = pill(P.purple, P.ink, label, true);
		const subW = visibleWidth(sub);
		const lines = this.renderTodos(width - subW - 1);
		const first = lines[0] ?? "";
		const pad = " ".repeat(Math.max(1, width - subW - visibleWidth(first)));
		lines[0] = truncateToWidth(first + pad + sub, width);
		return lines;
	}

	private renderTodos(width: number): string[] {
		if (!this.items.length) return [];
		const { shown, hidden } = pickVisible(this.items);
		const done = this.items.filter((t) => t.state === "done").length;
		const lines: string[] = [];

		const header =
			` ${pill(P.blue, P.ink, "\uF0AE todos", true)} ${progressBar(this.items)} ` + fg(P.muted, `${done}/${this.items.length}`);
		lines.push(truncateToWidth(header, width));

		const spin = this.running ? SPINNER[this.frame % SPINNER.length]! : "◐";
		if (!this.expanded) return [this.renderCollapsed(width, done, spin)];
		for (const t of shown) {
			const room = Math.max(8, width - 12);
			const title = truncateToWidth(t.title, room, "…");
			let row: string;
			if (t.state === "done") row = pill(P.doneBg, P.doneFg, `✔ ${title}`);
			else if (t.state === "working") row = pill(P.workBg, P.workFg, `${spin} ${title}`, true);
			else row = `${fg(P.subtle, "○")} ${fg(P.muted, title)}`;
			// pills carry a cap on each side; plain rows are nudged by the same amount so icons line up
			lines.push(truncateToWidth(`   ${t.state === "todo" ? "  " : ""}${row}`, width));
		}
		if (hidden > 0) lines.push(truncateToWidth(`   ${fg(P.subtle, `+${hidden} more`)}`, width));
		return lines;
	}
}

// ---------- extension ----------
export default function (pi: ExtensionAPI) {
	let enabled = true;
	let widget: TodoWidget | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;
	let sessionStart = Date.now();
	let signature = "";
	const dismissed = new Set<string>(); // finished lists that already disappeared
	let cwd = process.cwd();
	let rerender: (() => void) | undefined;

	const refresh = () => {
		if (!widget) return;
		const items = readTodos(cwd, sessionStart).filter((t) => !dismissed.has(t.id));
		const sig = items.map((t) => `${t.id}:${t.state}:${t.title}`).join("|");
		if (sig === signature) return;
		signature = sig;
		widget.items = items;
		const allDone = items.length > 0 && items.every((t) => t.state === "done");
		widget.hideAt = allDone ? Date.now() + HIDE_DELAY_MS : undefined;
		rerender?.();
	};

	const install = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		cwd = ctx.cwd;
		ctx.ui.setWidget("todo-widget", (tui) => {
			rerender = () => tui.requestRender();
			widget = new TodoWidget(
				() => tui.requestRender(),
				() => {
					for (const t of widget?.items ?? []) dismissed.add(t.id);
					if (widget) widget.items = [];
					signature = "";
					tui.requestRender();
				},
			);
			signature = "";
			refresh();
			return widget;
		});
		poll ??= setInterval(refresh, 1000);
	};

	const uninstall = (ctx: ExtensionContext) => {
		if (poll) clearInterval(poll);
		poll = undefined;
		widget?.dispose();
		widget = undefined;
		if (ctx.hasUI) ctx.ui.setWidget("todo-widget", undefined);
	};

	// subagent extension publishes how many are running; we draw it at the right corner
	pi.events.on("subagents:count", (n) => {
		if (!widget) return;
		widget.subagents = Number(n) || 0;
		rerender?.();
	});

	pi.on("session_start", (_e, ctx) => {
		sessionStart = Date.now();
		dismissed.clear();
		if (enabled) install(ctx);
	});
	pi.on("session_shutdown", (_e, ctx) => uninstall(ctx));
	pi.on("agent_start", () => {
		if (widget) widget.running = true;
	});
	pi.on("agent_end", () => {
		if (widget) widget.running = false;
		refresh();
		rerender?.();
	});
	pi.on("tool_execution_end", (e: any) => {
		if (e?.toolName === "todo") refresh();
	});

	const toggleExpanded = (force?: boolean) => {
		if (!widget) return;
		widget.expanded = force ?? !widget.expanded;
		rerender?.();
	};
	pi.registerShortcut(EXPAND_KEY, {
		description: "Expand or collapse the todo widget",
		handler: () => toggleExpanded(),
	});

	pi.registerCommand("todo-widget", {
		description: "Todo widget: expand | collapse | on | off (no argument toggles expand)",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			if (a === "" || a === "expand" || a === "collapse") {
				toggleExpanded(a === "" ? undefined : a === "expand");
				return;
			}
			enabled = a === "on" ? true : a === "off" ? false : !enabled;
			if (enabled) install(ctx);
			else uninstall(ctx);
			ctx.ui.notify(`todo widget ${enabled ? "on" : "off"}`, "info");
		},
	});
}
