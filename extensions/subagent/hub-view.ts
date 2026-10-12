/** The subagent hub overlay: a list of subagents, and a live transcript for the one you open. */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { describeTool, formatElapsed } from "../working-verbs/activity.ts";
import type { Hub, LiveAgent } from "./hub.ts";

type RGB = [number, number, number];
const RESET = "\x1b[0m";
const fg = ([r, g, b]: RGB, s: string) => `\x1b[38;2;${r};${g};${b}m${s}${RESET}`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const ROSE: RGB = [0xff, 0x7e, 0xb6];
const TEXT: RGB = [0xdd, 0xe1, 0xe6];
const MUTED: RGB = [0x8d, 0x91, 0x99];
const SUBTLE: RGB = [0x6e, 0x74, 0x7d];
const GREEN: RGB = [0x42, 0xbe, 0x65];
const RED: RGB = [0xfa, 0x4d, 0x56];
const BLUE: RGB = [0x78, 0xa9, 0xff];
const SELECTED_BG = "\x1b[48;2;57;57;57m";

const ICON: Record<LiveAgent["status"], string> = {
	running: fg(ROSE, "●"),
	done: fg(GREEN, "✓"),
	failed: fg(RED, "✗"),
	stopped: fg(MUTED, "■"),
};

const money = (n: number) => (n > 0 ? `$${n < 0.01 ? n.toFixed(3) : n.toFixed(2)}` : "");
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const elapsed = (a: LiveAgent) => formatElapsed((a.endedAt ?? Date.now()) - a.startedAt);
const textOf = (content: unknown) =>
	typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";
const finalText = (a: LiveAgent) => {
	for (let i = a.messages.length - 1; i >= 0; i--) {
		const m = a.messages[i];
		if (m?.role === "assistant") {
			const text = textOf(m.content).trim();
			if (text) return text;
		}
	}
	return "";
};

export class HubView {
	private selected = 0;
	private open: LiveAgent | undefined;
	/** Lines scrolled up from the end of the transcript; 0 follows the end. */
	private scroll = 0;

	constructor(
		private readonly hub: Hub,
		private readonly done: () => void,
		private readonly rows: () => number,
	) {}

	handleInput(data: string): void {
		const agents = this.hub.list();
		if (this.open) {
			const page = Math.max(1, this.rows() - 10);
			if (matchesKey(data, "escape") || matchesKey(data, "left") || data === "q") {
				this.open = undefined;
				this.scroll = 0;
			} else if (data === "x") this.hub.stop(this.open);
			else if (matchesKey(data, "up")) this.scroll++;
			else if (matchesKey(data, "down")) this.scroll = Math.max(0, this.scroll - 1);
			else if (matchesKey(data, "pageUp")) this.scroll += page;
			else if (matchesKey(data, "pageDown")) this.scroll = Math.max(0, this.scroll - page);
			else if (matchesKey(data, "end")) this.scroll = 0;
			return;
		}
		if (matchesKey(data, "escape") || data === "q") this.done();
		else if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down")) this.selected = Math.min(Math.max(0, agents.length - 1), this.selected + 1);
		else if (matchesKey(data, "return") || matchesKey(data, "right")) {
			this.open = agents[this.selected];
			this.scroll = 0;
		} else if (data === "x" && agents[this.selected]) this.hub.stop(agents[this.selected]!);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const inner = Math.max(10, width - 2);
		const edge = (s: string) => fg(ROSE, s);
		const row = (content: string) => {
			const t = truncateToWidth(content, inner);
			return edge("│") + t + " ".repeat(Math.max(0, inner - visibleWidth(t))) + edge("│");
		};
		const title = ` ${bold("Subagents")} `;
		const top = edge("╭─") + fg(ROSE, title) + edge("─".repeat(Math.max(0, inner - 1 - visibleWidth(title))) + "╮");
		const bottom = edge(`╰${"─".repeat(inner)}╯`);
		const body = this.open ? this.renderDetail(this.open, inner - 4) : this.renderList(inner - 4);
		const hint = this.open ? "↑↓ pgup/pgdn scroll · x stop · esc back" : "↑↓ select · enter open · x stop · esc close";
		const height = Math.max(6, this.rows());
		const room = height - 5; // borders, padding and the hint
		const shown = body.length > room ? body.slice(0, room) : body;
		return [top, row(""), ...shown.map((line) => row(`  ${line}`)), row(""), row(`  ${fg(SUBTLE, hint)}`), bottom];
	}

	private renderList(width: number): string[] {
		const agents = this.hub.list();
		if (!agents.length) return [fg(MUTED, "No subagents have run yet.")];
		this.selected = Math.min(this.selected, agents.length - 1);
		const nameWidth = Math.min(22, Math.max(...agents.map((a) => a.label.length)));
		return agents.map((a, i) => {
			const what = a.status === "running" ? fg(TEXT, this.hub.activity(a)) : fg(MUTED, a.status === "done" ? `done · ${finalText(a).split("\n")[0]}` : a.status);
			const cost = [a.usage.input + a.usage.output ? `${tokens(a.usage.input + a.usage.output)} tok` : "", money(a.usage.cost)].filter(Boolean).join(" ");
			const left = `${ICON[a.status]} ${fg(BLUE, truncateToWidth(a.label, nameWidth).padEnd(nameWidth))}  ${fg(SUBTLE, elapsed(a).padStart(6))}  `;
			const right = cost ? `  ${fg(SUBTLE, cost)}` : "";
			const middle = truncateToWidth(what, Math.max(4, width - visibleWidth(left) - visibleWidth(right)));
			const line = left + middle + " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(middle) - visibleWidth(right))) + right;
			return i === this.selected ? `${SELECTED_BG}${line}${RESET}` : line;
		});
	}

	private renderDetail(a: LiveAgent, width: number): string[] {
		const head = [
			`${ICON[a.status]} ${fg(BLUE, bold(a.label))}${fg(MUTED, ` · ${a.model} · ${a.status} · ${elapsed(a)}`)}${a.usage.cost ? fg(SUBTLE, ` · ↑${tokens(a.usage.input)} ↓${tokens(a.usage.output)} ${money(a.usage.cost)}`) : ""}`,
			...wrapTextWithAnsi(fg(SUBTLE, `Task: ${a.task.replace(/\s+/g, " ")}`), width).slice(0, 3),
			"",
		];
		const transcript: string[] = [];
		const wrap = (text: string, color: RGB, indent = "") => {
			for (const line of text.split("\n")) transcript.push(...wrapTextWithAnsi(fg(color, `${indent}${line}`), width));
		};
		for (const m of a.messages) {
			if (m?.role === "assistant") {
				for (const block of m.content ?? []) {
					if (block?.type === "text" && block.text?.trim()) wrap(block.text.trim(), TEXT);
					else if (block?.type === "toolCall") transcript.push(truncateToWidth(fg(ROSE, `→ ${describeTool(block.name, block.arguments ?? {}, a.cwd)}`), width));
				}
			} else if (m?.role === "toolResult") {
				const lines = textOf(m.content).split("\n").filter((l) => l.trim());
				const first = lines[0] ?? "(no output)";
				const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : "";
				transcript.push(truncateToWidth(fg(m.isError ? RED : SUBTLE, `  ⎿ ${first}${more}`), width));
			}
		}
		if (a.status === "running") transcript.push(fg(ROSE, `● ${this.hub.activity(a)}`));
		const room = Math.max(3, this.rows() - 5 - head.length);
		const maxScroll = Math.max(0, transcript.length - room);
		this.scroll = Math.min(this.scroll, maxScroll);
		const end = transcript.length - this.scroll;
		return [...head, ...transcript.slice(Math.max(0, end - room), end)];
	}
}
