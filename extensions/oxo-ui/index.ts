/**
 * oxo-ui: oxocarbon-grey styled input editor + powerlevel10k style footer.
 *
 * - Editor: thick blue top/bottom rules (no side bars) and a ❯ arrow before the input.
 * - Footer: powerlevel10k "rainbow" style with rounded caps (needs a Nerd Font):
 *     left : status, dir, git (branch, ahead/behind, +staged !modified ?untracked)
 *     right: extension statuses, cache hit %, cost, rolling avg t/s, context tokens, model + thinking
 *
 * Commands: /oxo  toggles the whole thing (falls back to pi defaults).
 * Palette comes from ~/Documents/github/oxocarbon-grey (palette.lua).
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { findImagePathSpans, projectedOffsetToSource, removeImagePathAt } from "../image-paste/chips.ts";

// ---------- palette (oxocarbon-grey) ----------
type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;

const P = {
	sky: hex("#33b1ff"),
	blue: hex("#78a9ff"),
	cyan: hex("#3ddbd9"),
	teal: hex("#08bdba"),
	purple: hex("#be95ff"),
	rose: hex("#ff7eb6"),
	pink: hex("#ee5396"),
	green: hex("#42be65"),
	muted: hex("#8d9199"),
	subtle: hex("#6e747d"),
	ink: hex("#1b1c1f"),
	panel: hex("#33353b"),
	text: hex("#dde1e6"),
};

const RESET = "\x1b[0m";
const fg = ([r, g, b]: RGB, s: string) => `\x1b[38;2;${r};${g};${b}m${s}${RESET}`;

// ---------- editor border colors (change these to taste) ----------
const BORDER = P.blue;
const RULE = "━"; // heavy line; use "─" for a thin one
const ARROW = "❯";
const BASH_BORDER = P.teal;

const ANSI_RE = /^\x1b(?:\[[0-9;?]*[A-Za-z]|_[^\x07\x1b]*(?:\x07|\x1b\\)|\][^\x07\x1b]*(?:\x07|\x1b\\))/;
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const fgRaw = ([r, g, b]: RGB) => `\x1b[38;2;${r};${g};${b}m`;
const bgRaw = ([r, g, b]: RGB) => `\x1b[48;2;${r};${g};${b}m`;

/** Recolor every "─" in a border line with one color (drawn as RULE), keeping other content (spinner, labels) intact. */
function colorBorder(line: string, color: RGB): string {
	let out = "";
	for (let i = 0; i < line.length; ) {
		if (line[i] === "\x1b") {
			const m = ANSI_RE.exec(line.slice(i));
			if (m) {
				out += m[0];
				i += m[0].length;
				continue;
			}
		}
		const ch = [...line.slice(i, i + 2)][0]!;
		out += ch === "─" ? `${fgRaw(color)}${RULE}` : ch;
		i += ch.length;
	}
	return out + RESET;
}

interface VisualLine { logicalLine: number; startCol: number; length: number; }
interface EditorInternals {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	lastAction: unknown;
	paddingX: number;
	lastWidth: number;
	scrollOffset: number;
	renderedVisibleLineCount: number;
	setCursorCol(column: number): void;
	pushUndoSnapshot(): void;
	exitHistoryBrowsing(): void;
	buildVisualLineMap(width: number): VisualLine[];
	segment(text: string, granularity: "grapheme"): Iterable<Intl.SegmentData>;
}

export class OxoEditor extends CustomEditor {
	private internals(): EditorInternals { return this as unknown as EditorInternals; }
	onImageInspect?: (path: string) => void;

	handleInput(data: string): void {
		const runtime = this.internals();
		const lines = this.getLines();
		const cursor = this.getCursor();
		const source = lines.join("\n");
		const offset = lines.slice(0, cursor.line).reduce((n: number, line: string) => n + line.length + 1, 0) + cursor.col;
		const spans = findImagePathSpans(source);
		const span = spans.find((item) => offset > item.start && offset < item.end);
		const kb = getKeybindings();
		const right = kb.matches(data, "tui.editor.cursorRight") || kb.matches(data, "tui.editor.cursorWordRight") || data === "\x1b[C" || data === "\x1b[1;5C";
		const left = kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, "tui.editor.cursorWordLeft") || data === "\x1b[D" || data === "\x1b[1;5D";
		const backwardDelete = data === "\x7f" || data === "\b" || kb.matches(data, "tui.editor.deleteCharBackward");
		const forwardDelete = kb.matches(data, "tui.editor.deleteCharForward");
		if (span && (right || left)) {
			const target = right ? span.end : span.start;
			runtime.state.cursorLine = source.slice(0, target).split("\n").length - 1;
			runtime.setCursorCol(target - (source.lastIndexOf("\n", target - 1) + 1));
			runtime.lastAction = null;
			return;
		}
		if (span && (backwardDelete || forwardDelete)) {
			runtime.pushUndoSnapshot();
			const updated = removeImagePathAt(source, span.start);
			runtime.state.lines = updated.split("\n");
			runtime.state.cursorLine = updated.slice(0, span.start).split("\n").length - 1;
			runtime.setCursorCol(span.start - (updated.lastIndexOf("\n", span.start - 1) + 1));
			this.onChange?.(this.getText());
			this.tui.requestRender();
			return;
		}
		if (span) {
			runtime.state.cursorLine = source.slice(0, span.start).split("\n").length - 1;
			runtime.setCursorCol(span.start - (source.lastIndexOf("\n", span.start - 1) + 1));
		}
		const vertical = kb.matches(data, "tui.editor.cursorUp") || kb.matches(data, "tui.editor.cursorDown");
		if (vertical && spans.length) {
			let projected = "";
			let consumed = 0;
			for (const item of spans) { projected += source.slice(consumed, item.start) + item.chip; consumed = item.end; }
			projected += source.slice(consumed);
			const projectedOffset = this.sourceOffsetToProjected(offset, spans);
			const projectedLines = projected.split("\n");
			runtime.state.lines = projectedLines;
			runtime.state.cursorLine = projected.slice(0, projectedOffset).split("\n").length - 1;
			runtime.setCursorCol(projectedOffset - (projected.lastIndexOf("\n", projectedOffset - 1) + 1));
			try {
				super.handleInput(data);
				if (runtime.state.lines.join("\n") === projected) {
					const moved = runtime.state.lines.slice(0, runtime.state.cursorLine).reduce((n: number, line: string) => n + line.length + 1, 0) + runtime.state.cursorCol;
					const target = projectedOffsetToSource(moved, spans);
					runtime.state.lines = lines;
					runtime.state.cursorLine = source.slice(0, target).split("\n").length - 1;
					runtime.setCursorCol(target - (source.lastIndexOf("\n", target - 1) + 1));
				} else {
					const changed = runtime.state.lines.join("\n");
					const moved = runtime.state.lines.slice(0, runtime.state.cursorLine).reduce((n: number, line: string) => n + line.length + 1, 0) + runtime.state.cursorCol;
					const restored = this.restoreImageProjection(changed, moved, source, spans);
					if (restored.text !== changed) {
						runtime.state.lines = restored.text.split("\n");
						runtime.state.cursorLine = restored.text.slice(0, restored.cursorOffset).split("\n").length - 1;
						runtime.setCursorCol(restored.cursorOffset - (restored.text.lastIndexOf("\n", restored.cursorOffset - 1) + 1));
					}
				}
			} finally {
				if (runtime.state.lines === projectedLines) runtime.state.lines = lines;
			}
			return;
		}
		const remove = spans.find((item) => (offset === item.end && backwardDelete) ||
			(offset === item.start && forwardDelete));
		if (remove) {
			runtime.pushUndoSnapshot();
			const updated = removeImagePathAt(source, remove.start);
			runtime.state.lines = updated.split("\n");
			runtime.state.cursorLine = updated.slice(0, remove.start).split("\n").length - 1;
			runtime.setCursorCol(remove.start - (updated.lastIndexOf("\n", remove.start - 1) + 1));
			this.onChange?.(this.getText());
			this.tui.requestRender();
			return;
		}
		const current = spans.find((item) => (right && offset === item.start) || (left && offset === item.end));
		if (current) {
			const target = right ? current.end : current.start;
			runtime.state.cursorLine = source.slice(0, target).split("\n").length - 1;
			runtime.setCursorCol(target - (source.lastIndexOf("\n", target - 1) + 1));
			runtime.lastAction = null;
			return;
		}
		super.handleInput(data);
	}

	private sourceOffsetToProjected(offset: number, spans: ReturnType<typeof findImagePathSpans>): number {
		let delta = 0;
		for (const span of spans) {
			if (offset < span.start) return offset - delta;
			if (offset <= span.end) return span.start - delta + (offset === span.end ? span.chip.length : 0);
			delta += span.end - span.start - span.chip.length;
		}
		return offset - delta;
	}

	private restoreImageProjection(text: string, cursorOffset: number, sourceText: string, spans: ReturnType<typeof findImagePathSpans>): { text: string; cursorOffset: number } {
		let restored = text;
		let mappedCursor = cursorOffset;
		for (const span of spans) {
			const at = restored.indexOf(span.chip);
			if (at < 0) continue;
			const sourceValue = sourceText.slice(span.start, span.end);
			restored = restored.slice(0, at) + sourceValue + restored.slice(at + span.chip.length);
			if (at < mappedCursor) mappedCursor += sourceValue.length - span.chip.length;
			else if (at <= mappedCursor && mappedCursor < at + span.chip.length) mappedCursor = at + (mappedCursor - at < span.chip.length / 2 ? 0 : sourceValue.length);
		}
		return { text: restored, cursorOffset: mappedCursor };
	}

	render(width: number): string[] {
		if (width < 8) return super.render(width);
		const runtime = this.internals();
		const inner = width - 2;
		const sourceLines = this.getLines();
		const sourceCursor = this.getCursor();
		const sourceCursorLine = sourceCursor.line;
		const sourceCursorCol = sourceCursor.col;
		const sourceOffset = sourceLines.slice(0, sourceCursor.line).reduce((n: number, line: string) => n + line.length + 1, 0) + sourceCursor.col;
		const sourceText = sourceLines.join("\n");
		const spans = findImagePathSpans(sourceText);
		if (spans.length) {
			let projected = "";
			let position = 0;
			for (const span of spans) {
				projected += sourceText.slice(position, span.start) + span.chip;
				position = span.end;
			}
			projected += sourceText.slice(position);
			runtime.state.lines = projected.split("\n");
			const projectedOffset = this.sourceOffsetToProjected(sourceOffset, spans);
			const before = runtime.state.lines.join("\n");
			const lineStart = before.lastIndexOf("\n", Math.max(0, projectedOffset - 1)) + 1;
			runtime.state.cursorLine = (before.slice(0, projectedOffset).match(/\n/g) ?? []).length;
			runtime.state.cursorCol = projectedOffset - lineStart;
		}
		let lines: string[];
		try { lines = super.render(inner); }
		finally { runtime.state.lines = sourceLines; runtime.state.cursorCol = sourceCursorCol; runtime.state.cursorLine = sourceCursorLine; }

		if (lines.length < 2) return lines;

		const color = this.getText().startsWith("!") ? BASH_BORDER : BORDER;
		const edge = fgRaw(color);
		const isBorder = (l: string) => /^─{2,}/.test(stripAnsi(l));

		let bottom = -1;
		for (let i = lines.length - 1; i > 0; i--) {
			if (isBorder(lines[i]!)) {
				bottom = i;
				break;
			}
		}
		if (bottom < 0) return super.render(width);

		const rule = `${edge}${RULE.repeat(2)}`; // extends the rule across the arrow gutter
		const arrow = `\x1b[1m${edge}${ARROW}${RESET} `;
		let firstContent = true;
		return lines.map((line, i) => {
			if (i === 0 || i === bottom) return `${rule}${colorBorder(line, color)}`;
			if (i > bottom) return ` ${line}`; // autocomplete list sits below the rules
			const gutter = firstContent ? arrow : "  ";
			firstContent = false;
			return `${gutter}${line}`;
		});
	}

	handleMouse(event: Parameters<CustomEditor["handleMouse"]>[0]): ReturnType<CustomEditor["handleMouse"]> {
		const runtime = this.internals();
		if (event?.type !== "click" || event.button !== "left" || !this.getLines()) return super.handleMouse(event);
		const innerEvent = { ...event, x: event.x - (event.y <= runtime.renderedVisibleLineCount ? 2 : 1), width: Math.max(1, event.width - 2) };
		const sourceLines = this.getLines();
		const sourceText = sourceLines.join("\n");
		const spans = findImagePathSpans(sourceText);
		if (!spans.length || event.y <= 0 || event.y > runtime.renderedVisibleLineCount) return super.handleMouse(innerEvent);
		let projected = "";
		let position = 0;
		for (const span of spans) {
			projected += sourceText.slice(position, span.start) + span.chip;
			position = span.end;
		}
		projected += sourceText.slice(position);
		const projectedLines = projected.split("\n");
		runtime.state.lines = projectedLines;
		try {
			const visualLine = runtime.buildVisualLineMap(runtime.lastWidth)[runtime.scrollOffset + event.y - 1];
			if (!visualLine) return { handled: true, focus: true };
			const line = runtime.state.lines[visualLine.logicalLine] ?? "";
			let column = 0;
			let charOffset = -1;
			const maxPadding = Math.max(0, Math.floor((event.width - 3) / 2));
			const targetColumn = event.x - 2 - Math.min(runtime.paddingX, maxPadding);
			if (targetColumn >= 0) for (const grapheme of runtime.segment(line.slice(visualLine.startCol, visualLine.startCol + visualLine.length), "grapheme")) {
				const next = column + visibleWidth(grapheme.segment);
				if (targetColumn < next) { charOffset = visualLine.startCol + grapheme.index; break; }
				column = next;
			}
			if (charOffset < 0) return { handled: true, focus: true };
			const projectedOffset = runtime.state.lines.slice(0, visualLine.logicalLine).reduce((n: number, value: string) => n + value.length + 1, 0) + charOffset;
			const chip = spans.map((span) => {
				const delta = spans.filter((prior) => prior.start < span.start).reduce((n: number, prior) => n + prior.end - prior.start - prior.chip.length, 0);
				const start = span.start - delta;
				return { span, start, end: start + span.chip.length };
			}).find(({ start, end }) => projectedOffset >= start && projectedOffset < end);
			if (chip) {
				runtime.state.lines = sourceLines;
				const chipOffset = projectedOffset - chip.start;
				if (chipOffset >= chip.span.chip.length - 2) {
					const updated = removeImagePathAt(sourceText, chip.span.start);
					runtime.pushUndoSnapshot();
					runtime.state.lines = updated.split("\n");
					runtime.state.cursorLine = updated.slice(0, chip.span.start).split("\n").length - 1;
					runtime.setCursorCol(chip.span.start - (updated.lastIndexOf("\n", chip.span.start - 1) + 1));
					this.onChange?.(this.getText());
					this.tui.requestRender();
					return { handled: true, focus: true };
				}
				this.onImageInspect?.(chip.span.path);
				return { handled: true, focus: true };
			}

			const result = super.handleMouse(innerEvent);
			if (runtime.state.lines.join("\n") !== projected) {
				const changed = runtime.state.lines.join("\n");
				const cursor = this.getCursor();
				const moved = runtime.state.lines.slice(0, cursor.line).reduce((n: number, value: string) => n + value.length + 1, 0) + cursor.col;
				const restored = this.restoreImageProjection(changed, moved, sourceText, spans);
				if (restored.text !== changed) {
					runtime.state.lines = restored.text.split("\n");
					runtime.state.cursorLine = restored.text.slice(0, restored.cursorOffset).split("\n").length - 1;
					runtime.setCursorCol(restored.cursorOffset - (restored.text.lastIndexOf("\n", restored.cursorOffset - 1) + 1));
				}
				return result;
			}
			const cursor = this.getCursor();
			const mappedOffset = runtime.state.lines.slice(0, cursor.line).reduce((n: number, value: string) => n + value.length + 1, 0) + cursor.col;
			const sourceOffset = projectedOffsetToSource(mappedOffset, spans);
			runtime.state.lines = sourceLines;
			runtime.state.cursorLine = sourceText.slice(0, sourceOffset).split("\n").length - 1;
			runtime.setCursorCol(sourceOffset - (sourceText.lastIndexOf("\n", sourceOffset - 1) + 1));
			runtime.lastAction = null;
			runtime.exitHistoryBrowsing();
			return result;
		} finally {
			if (runtime.state.lines === projectedLines) runtime.state.lines = sourceLines;
		}
	}
}

// ---------- footer ----------
const trim = (x: number) => x.toFixed(1).replace(/\.0$/, "");
const fmtTokens = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${trim(n / 1000)}k` : `${trim(n / 1e6)}M`);

interface GitInfo {
	staged: number;
	modified: number;
	untracked: number;
	ahead: number;
	behind: number;
}

function cacheRateOf(m: AssistantMessage): number | undefined {
	const u = m.usage;
	const total = u.input + u.cacheRead + u.cacheWrite;
	return total > 0 ? u.cacheRead / total : undefined;
}

function gitInfo(cwd: string): Promise<GitInfo | undefined> {
	return new Promise((resolve) => {
		execFile("git", ["status", "--porcelain=v1", "-b"], { cwd, timeout: 3000 }, (err, stdout) => {
			if (err) return resolve(undefined);
			const info: GitInfo = { staged: 0, modified: 0, untracked: 0, ahead: 0, behind: 0 };
			for (const l of stdout.split("\n")) {
				if (l.startsWith("## ")) {
					info.ahead = Number(/ahead (\d+)/.exec(l)?.[1] ?? 0);
					info.behind = Number(/behind (\d+)/.exec(l)?.[1] ?? 0);
				} else if (l.startsWith("??")) info.untracked++;
				else if (l.length > 2) {
					if (l[0] !== " ") info.staged++;
					if (l[1] !== " ") info.modified++;
				}
			}
			resolve(info);
		});
	});
}

// ---------- powerline segments ----------
const CAP_L = "\uE0B6";
const CAP_R = "\uE0B4";
const SEP_L = "\uE0B0";
const SEP_R = "\uE0B2";
const INK = P.ink;

interface Seg {
	bg: RGB;
	fg: RGB;
	text: string;
}
const seg = (bg: RGB, text: string, fgc: RGB = INK): Seg => ({ bg, fg: fgc, text });
const body = (s: Seg) => `${bgRaw(s.bg)}${fgRaw(s.fg)}\x1b[1m ${s.text} \x1b[22m`;

function renderLeft(segs: Seg[]): string {
	if (!segs.length) return "";
	let out = `${fgRaw(segs[0]!.bg)}${CAP_L}`;
	segs.forEach((s, i) => {
		out += body(s);
		const next = segs[i + 1];
		out += next ? `${fgRaw(s.bg)}${bgRaw(next.bg)}${SEP_L}` : `${RESET}${fgRaw(s.bg)}${CAP_R}`;
	});
	return out + RESET;
}

function renderRight(segs: Seg[]): string {
	if (!segs.length) return "";
	let out = `${fgRaw(segs[0]!.bg)}${CAP_L}`;
	segs.forEach((s, i) => {
		const prev = segs[i - 1];
		if (prev) out += `${fgRaw(s.bg)}${bgRaw(prev.bg)}${SEP_R}`;
		out += body(s);
	});
	return `${out}${RESET}${fgRaw(segs[segs.length - 1]!.bg)}${CAP_R}${RESET}`;
}

const home = process.env.HOME ?? "";
function shortPath(cwd: string): string {
	let p = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
	const parts = p.split("/");
	if (parts.length > 4) p = `${parts[0]}/…/${parts.slice(-2).join("/")}`;
	return p || "/";
}

// /reload re-imports this file but keeps the process, so the running average is parked here
// (memory only) to survive it. Any other session start (new, resume, fork, startup) clears it.
const SHARED_TPS = Symbol.for("pi-config.oxo-ui.rolling-tps");
const MIN_WINDOW_MS = 1000; // an answer must have streamed for at least this long to give a rate
const shared = globalThis as { [SHARED_TPS]?: number };

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let running = false;
	let git: GitInfo | undefined;
	let lastFailed = false;
	let cacheRate: number | undefined; // last response: cacheRead / total prompt tokens
	let averageTps: number | undefined; // memory-only smoothing: (previous average + latest response rate) / 2
	// Answer-text delivery: first and last non-empty text delta, and the longest pause between two.
	// Reasoning and tool-call deltas never count.
	let answerStart: number | undefined;
	let answerLast = 0;
	let answerMaxGap = 0;
	let cost = 0;
	let requestRender: (() => void) | undefined;
	let refreshing = false;
	let statsDirty = true;
	let statsLeafId: string | null | undefined;

	const refreshStats = (ctx: ExtensionContext) => {
		const leafId = ctx.sessionManager.getLeafId();
		if (!statsDirty && leafId === statsLeafId) return;
		statsLeafId = leafId;
		statsDirty = false;
		cost = 0;
		lastFailed = false;
		cacheRate = undefined;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const m = e.message as AssistantMessage;
				cost += m.usage.cost.total;
				lastFailed = m.stopReason === "error";
				cacheRate = cacheRateOf(m);
			}
		}
		requestRender?.();
	};

	const refreshGit = async (ctx: ExtensionContext) => {
		if (refreshing) return;
		refreshing = true;
		try {
			git = await gitInfo(ctx.cwd);
		} finally {
			refreshing = false;
			requestRender?.();
		}
	};

	const refresh = (ctx: ExtensionContext) => {
		refreshStats(ctx);
		void refreshGit(ctx);
	};

	const install = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			const editor = new OxoEditor(tui, theme, kb);
			editor.onImageInspect = (path) => {
				const resolved = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
				const type = /\.png$/i.test(resolved) ? "image/png" : /\.jpe?g$/i.test(resolved) ? "image/jpeg" : /\.gif$/i.test(resolved) ? "image/gif" : "image/webp";
				let details = "file not found";
				try {
					const info = statSync(resolved);
					if (info.isFile()) details = `${(info.size / 1024).toFixed(1)} KB · ${type}`;
					else details = "not a regular file";
				} catch {}
				ctx.ui.notify(`${basename(resolved)}\n${resolved}\n${details}`, "info");
			};
			return editor;
		});
		ctx.ui.setFooter((tui, _theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => {
				void refreshGit(ctx);
				tui.requestRender();
			});
			return {
				dispose() {
					unsub();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const branch = footerData.getGitBranch();

					// ---- left segments ----
					const left: Seg[] = [];
					if (running) left.push(seg(P.rose, "●"));
					else if (lastFailed) left.push(seg(P.pink, "✘"));
					left.push(seg(P.blue, `\uF07C ${shortPath(ctx.cwd)}`));
					if (branch) {
						const g = git;
						const dirty = !!g && (g.staged || g.modified || g.untracked);
						let t = `\uE0A0 ${branch}`;
						if (g) {
							if (g.behind) t += ` ⇣${g.behind}`;
							if (g.ahead) t += ` ⇡${g.ahead}`;
							if (g.staged) t += ` +${g.staged}`;
							if (g.modified) t += ` !${g.modified}`;
							if (g.untracked) t += ` ?${g.untracked}`;
						}
						left.push(seg(dirty ? P.rose : P.purple, t));
					}

					// ---- right segments (dropped from the front of this list when narrow) ----
					const level = pi.getThinkingLevel();
					const model = `${ctx.model?.id ?? "no-model"}${level && level !== "off" ? ` · ${level}` : ""}`;
					const usage = ctx.getContextUsage();
					const statuses = [...footerData.getExtensionStatuses().values()].map(stripAnsi).filter(Boolean);
					const optional: Seg[] = [];
					if (statuses.length) optional.push(seg(P.panel, statuses.join(" "), P.text));
					optional.push(seg(P.panel, `\uF1C0 ${cacheRate !== undefined ? `${Math.round(cacheRate * 100)}%` : "–"} cache`, P.text));
					if (cost > 0) optional.push(seg(P.green, `$${cost.toFixed(3)}`));
					optional.push(seg(P.cyan, `\uF0E7 ${averageTps === undefined ? "–" : averageTps.toFixed(averageTps < 10 ? 1 : 0)} avg t/s`));
					const required: Seg[] = [];
					if (usage?.percent != null) {
						const pct = usage.percent;
						const c = pct > 85 ? P.pink : pct > 60 ? P.purple : P.teal;
						required.push(seg(c, `\uF2DB ${usage.tokens != null ? fmtTokens(usage.tokens) : "?"}/${fmtTokens(usage.contextWindow)}`));
					}
					required.push(seg(P.sky, model));

					const leftStr = renderLeft(left);
					let right = "";
					for (let drop = 0; drop <= optional.length; drop++) {
						right = renderRight([...optional.slice(drop), ...required]);
						if (width - visibleWidth(leftStr) - visibleWidth(right) >= 3) break;
					}
					if (width - visibleWidth(leftStr) - visibleWidth(right) < 3) {
						right = renderRight(required.slice(-1)); // model only
					}
					const gapW = width - visibleWidth(leftStr) - visibleWidth(right);
					if (gapW < 3) return [truncateToWidth(leftStr, width)];
					const fill = fg(P.subtle, ` ${"·".repeat(gapW - 2)} `);
					return [leftStr + fill + right];
				},
			};
		});
		refresh(ctx);
	};

	const uninstall = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setFooter(undefined);
	};

	pi.on("session_start", (e, ctx) => {
		statsDirty = true;
		averageTps = e.reason === "reload" ? shared[SHARED_TPS] : undefined;
		shared[SHARED_TPS] = averageTps;
		answerStart = undefined;
		answerLast = 0;
		answerMaxGap = 0;
		if (enabled) install(ctx);
	});
	pi.on("agent_start", (_e, _ctx) => {
		running = true;
		requestRender?.();
	});
	pi.on("agent_end", (_e, ctx) => {
		running = false;
		refresh(ctx);
	});
	pi.on("message_start", (e, _ctx) => {
		if (e.message.role !== "assistant") return;
		answerStart = undefined;
		answerLast = 0;
		answerMaxGap = 0;
	});
	pi.on("message_update", (e, _ctx) => {
		const ev = e.assistantMessageEvent;
		if (ev.type !== "text_delta" || ev.delta.length === 0) return;
		const now = Date.now();
		if (answerStart === undefined) answerStart = now;
		else answerMaxGap = Math.max(answerMaxGap, now - answerLast);
		answerLast = now;
	});
	pi.on("message_end", (e, _ctx) => {
		if (e.message.role !== "assistant") return;
		statsDirty = true;
		const m = e.message as AssistantMessage;
		const finalAnswer = (m.stopReason === "stop" || m.stopReason === "length") &&
			!m.content.some(block => block.type === "toolCall");
		if (answerStart !== undefined && finalAnswer) {
			// Measure only text that really streamed. Some answers arrive in one burst (Sonnet 5.5 with
			// thinking does): the window is then a few milliseconds, or a burst split by the network, and
			// the "rate" is in the thousands. A stream counts if the text kept arriving for at least a
			// second and no single pause took up more than half of that window.
			const windowMs = answerLast - answerStart;
			// Output includes reasoning tokens, whose generation may precede the visible stream. Count
			// only answer tokens over the time the answer text took to arrive.
			const reasoning = m.usage.reasoning ?? 0;
			const answerTokens = m.usage.output - reasoning;
			const unknownReasoning = m.usage.reasoning === undefined && m.content.some(block => block.type === "thinking");
			const steady = windowMs >= MIN_WINDOW_MS && answerMaxGap <= windowMs / 2;
			if (steady && Number.isFinite(m.usage.output) && Number.isFinite(reasoning) &&
				reasoning >= 0 && answerTokens > 0 && !unknownReasoning) {
				const responseTps = answerTokens / (windowMs / 1000);
				if (Number.isFinite(responseTps)) {
					averageTps = averageTps === undefined ? responseTps : (averageTps + responseTps) / 2;
					shared[SHARED_TPS] = averageTps;
				}
			}
		}
		answerStart = undefined;
		answerLast = 0;
		answerMaxGap = 0;
		cacheRate = cacheRateOf(m);
		requestRender?.();
	});
	pi.on("session_tree", (_e, ctx) => refreshStats(ctx));
	pi.on("turn_end", (_e, ctx) => refreshStats(ctx));
	pi.on("tool_execution_end", (_e, ctx) => void refreshGit(ctx));
	pi.on("model_select", (_e, _ctx) => requestRender?.());
	pi.on("thinking_level_select", (_e, _ctx) => requestRender?.());

	pi.registerCommand("oxo", {
		description: "Toggle oxocarbon editor + zsh-style footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) install(ctx);
			else uninstall(ctx);
			ctx.ui.notify(enabled ? "oxo-ui on" : "default UI restored", "info");
		},
	});
}
