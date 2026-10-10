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
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

class OxoEditor extends CustomEditor {
	render(width: number): string[] {
		if (width < 8) return super.render(width);
		const inner = width - 2;
		const lines = super.render(inner);
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
const CAP_L = "\uE0B6"; //
const CAP_R = "\uE0B4"; //
const SEP_L = "\uE0B0"; //
const SEP_R = "\uE0B2"; //
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

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let running = false;
	let git: GitInfo | undefined;
	let lastFailed = false;
	let cacheRate: number | undefined; // last response: cacheRead / total prompt tokens
	let averageTps: number | undefined; // memory-only smoothing: (previous average + latest response rate) / 2
	let answerStart: number | undefined; // first non-empty answer-text delta, excluding reasoning
	let cost = 0;
	let requestRender: (() => void) | undefined;
	let refreshing = false;

	const refreshStats = (ctx: ExtensionContext) => {
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
		ctx.ui.setEditorComponent((tui, theme, kb) => new OxoEditor(tui, theme, kb));
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
					optional.push(seg(P.cyan, `\uF0E7 ${averageTps === undefined ? "0" : averageTps.toFixed(averageTps < 10 ? 1 : 0)} avg t/s`));
					const required: Seg[] = [];
					if (usage?.percent != null) {
						const pct = usage.percent;
						const c = pct > 85 ? P.pink : pct > 60 ? P.purple : P.teal;
						required.push(seg(c, `\uF2DB ${usage.tokens != null ? fmtTokens(usage.tokens) : "?"}/${fmtTokens(usage.contextWindow)}`));
					}
					required.push(seg(P.sky, model));

					const leftStr = renderLeft(left);
					let right = renderRight([...optional, ...required]);
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

	pi.on("session_start", (_e, ctx) => {
		averageTps = undefined;
		answerStart = undefined;
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
	});
	pi.on("message_update", (e, _ctx) => {
		const ev = e.assistantMessageEvent;
		if (ev.type !== "text_delta" || ev.delta.length === 0) return;
		answerStart ??= Date.now();
	});
	pi.on("message_end", (e, _ctx) => {
		if (e.message.role !== "assistant") return;
		const m = e.message as AssistantMessage;
		const finalAnswer = (m.stopReason === "stop" || m.stopReason === "length") &&
			!m.content.some(block => block.type === "toolCall");
		if (answerStart !== undefined && finalAnswer) {
			const elapsed = (Date.now() - answerStart) / 1000;
			// Output includes reasoning tokens, whose generation may precede the
			// visible stream. Count only answer tokens over answer delivery time.
			const reasoning = m.usage.reasoning ?? 0;
			const answerTokens = m.usage.output - reasoning;
			const unknownReasoning = m.usage.reasoning === undefined && m.content.some(block => block.type === "thinking");
			if (elapsed >= 0.3 && Number.isFinite(m.usage.output) && Number.isFinite(reasoning) &&
				reasoning >= 0 && answerTokens > 0 && !unknownReasoning) {
				const responseTps = answerTokens / elapsed;
				if (Number.isFinite(responseTps)) {
					averageTps = averageTps === undefined ? responseTps : (averageTps + responseTps) / 2;
				}
			}
		}
		answerStart = undefined;
		cacheRate = cacheRateOf(m);
		requestRender?.();
	});
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
