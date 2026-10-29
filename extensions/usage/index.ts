/**
 * /usage: tabbed subscription limits and saved-session token / API-equivalent spend analytics.
 *
 * Anthropic tokens are only read; Pi refreshes its own when you send a message.
 * The Codex login in ~/.codex/auth.json is refreshed here when it expires (see codex-auth.ts).
 *   Anthropic   GET api.anthropic.com/api/oauth/usage      token: pi auth.json, else ~/.claude/.credentials.json
 *   Codex       GET chatgpt.com/backend-api/wham/usage     token: ~/.codex/auth.json (Pi's own OpenAI token is not accepted)
 *   Antigravity `agy -p /usage --output-format json`        (answered locally by agy, no model turn)
 *
 * Spend uses rolling 7/30/60-day and all-time windows; subscription weeks follow real quota resets.
 * Keys: Tab = switch tab, left/right = spend period, d = details, r = refresh, arrows / j / k = scroll.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { withCodexCredentials } from "./codex-auth.ts";
import { columnChart } from "./cost-chart.ts";
import { readSpend, readSpendReport, type Spend, type SpendReport } from "./spend.ts";
import { parseAnthropicUsage, parseCodexUsage, parseAntigravityUsage, type Win } from "./quota.ts";
import { readWeeklyCost, type WeeklyCost } from "./weekly-spend.ts";
import { fit, pair, usageColumns, windowLabel } from "./layout.ts";

// ---------- palette (oxocarbon-grey) ----------
type RGB = [number, number, number];
const C = {
	sky: [0x33, 0xb1, 0xff] as RGB,
	blue: [0x78, 0xa9, 0xff] as RGB,
	teal: [0x08, 0xbd, 0xba] as RGB,
	purple: [0xbe, 0x95, 0xff] as RGB,
	rose: [0xff, 0x7e, 0xb6] as RGB,
	orange: [0xff, 0x83, 0x2b] as RGB,
	pink: [0xee, 0x53, 0x96] as RGB,
	text: [0xdd, 0xe1, 0xe6] as RGB,
	muted: [0x8d, 0x91, 0x99] as RGB,
	subtle: [0x6e, 0x74, 0x7d] as RGB,
	track: [0x33, 0x35, 0x3b] as RGB,
};
const RESET = "\x1b[0m";
const fg = ([r, g, b]: RGB, s: string) => `\x1b[38;2;${r};${g};${b}m${s}${RESET}`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

// ---------- model ----------
export interface Section {
	name: string;
	plan?: string;
	wins: Win[];
	extra: string[]; // free-form lines
	spend?: SpendReport;
	weekly?: WeeklyCost;
	error?: string;
	loading: boolean;
}

// ---------- helpers ----------
const HOME = homedir();
const PI_DIR = process.env.PI_CODING_AGENT_DIR ?? join(HOME, ".pi", "agent");

function readJson(path: string): any {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

class UsageError extends Error {}
class TokenRejected extends UsageError {}

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
	const res = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(10_000) });
	if (res.status === 401 || res.status === 403) throw new TokenRejected(`token rejected (HTTP ${res.status})`);
	if (!res.ok) throw new UsageError(`HTTP ${res.status}`);
	return res.json();
}

const clampPct = (n: number) => Math.max(0, Math.min(100, n));

// ---------- fetchers ----------
async function fetchAnthropic(): Promise<Partial<Section>> {
	const now = Date.now();
	const tokens: string[] = [];
	const pi = readJson(join(PI_DIR, "auth.json"))?.anthropic;
	if (pi?.access && (!pi.expires || pi.expires > now)) tokens.push(pi.access);
	const cc = readJson(join(HOME, ".claude", ".credentials.json"))?.claudeAiOauth;
	if (cc?.accessToken && (!cc.expiresAt || cc.expiresAt > now)) tokens.push(cc.accessToken);
	if (!tokens.length) {
		if (pi?.access) throw new UsageError("token expired: send a message to refresh it, then retry");
		throw new UsageError("not signed in");
	}

	let d: any;
	let lastErr: unknown;
	for (const t of tokens) {
		try {
			d = await getJson("https://api.anthropic.com/api/oauth/usage", {
				Authorization: `Bearer ${t}`,
				"anthropic-beta": "oauth-2025-04-20",
			});
			break;
		} catch (e) {
			lastErr = e;
		}
	}
	if (!d) throw lastErr;

	return parseAnthropicUsage(d);
}

async function fetchCodex(): Promise<Partial<Section>> {
	let usage: { value: any; warning?: string };
	try {
		usage = await withCodexCredentials(
			(c) => getJson("https://chatgpt.com/backend-api/wham/usage", {
				Authorization: `Bearer ${c.token}`,
				...(c.account ? { "ChatGPT-Account-Id": c.account } : {}),
			}),
			(e) => e instanceof TokenRejected,
		);
	} catch (e) {
		throw e instanceof TokenRejected ? new UsageError("token rejected even after refreshing: run `codex login`") : e;
	}
	const parsed = parseCodexUsage(usage.value);
	if (usage.warning) parsed.extra.push(usage.warning);
	return parsed;
}

function run(cmd: string, args: string[], timeoutMs: number, cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			cmd,
			args,
			{ cwd, timeout: timeoutMs, killSignal: "SIGKILL", env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, maxBuffer: 4_000_000 },
			(err, stdout) => (err ? reject(err) : resolve(stdout)),
		);
		child.stdin?.end();
	});
}

async function fetchAntigravity(): Promise<Partial<Section>> {
	const agy = [join(HOME, ".local", "bin", "agy"), "agy"];
	const dir = mkdtempSync(join(tmpdir(), "pi-agy-usage-")); // keep agy out of the current repo
	try {
		let bin: string | undefined;
		let version: string | undefined;
		for (const b of agy) {
			try {
				version = await run(b, ["--version"], 4000, dir);
				bin = b;
				break;
			} catch {}
		}
		if (!bin) throw new UsageError("agy not found");
		const m = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
		const v = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
		// `/usage` only runs as a local command from 1.1.11; older builds would send it to the model.
		if (v[0]! < 1 || (v[0] === 1 && (v[1]! < 1 || (v[1] === 1 && v[2]! < 11)))) throw new UsageError(`agy ${m?.[0] ?? "?"} is too old for /usage (need 1.1.11+)`);

		let out: string;
		try {
			out = await run(bin, ["-p", "/usage", "--output-format", "json", "--print-timeout", "6s"], 9000, dir);
		} catch {
			throw new UsageError("agy did not answer (signed out?)");
		}
		const body = JSON.parse(out);
		if (body.status !== "SUCCESS" || body.num_turns !== 0 || body.command?.name !== "usage") throw new UsageError("unexpected agy response");

		return parseAntigravityUsage(body);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------- spend ----------
const PROVIDER_NAMES: { [id: string]: string } = { openai: "OpenAI", "openai-codex": "Codex", anthropic: "Anthropic", google: "Google" };
const providerName = (id: string) => PROVIDER_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Blue and orange stay distinguishable for most colour-vision types; other providers cycle through the rest.
const COST_COLORS: { [provider: string]: RGB } = { openai: C.sky, "openai-codex": C.sky, anthropic: C.orange };
const FALLBACK_COLORS: RGB[] = [C.purple, C.teal, C.rose, C.blue];

const PERIODS = [
	{ key: "week", label: "7 days" }, { key: "month", label: "30 days" },
	{ key: "twoMonths", label: "60 days" }, { key: "allTime", label: "All time" },
] as const;
const number = (n: number) => n.toLocaleString("en-US");
const tokens = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : number(n);
const preciseMoney = (n: number) => n > 0 && n < 0.000001 ? "<$0.000001" : n > 0 && n < 0.01 ? `$${n.toFixed(6)}` : money(n);

// ---------- rendering ----------
function fmtReset(at?: number, now = Date.now()): string {
	if (!at) return "";
	const s = Math.round((at - now) / 1000);
	if (s <= 0) return "resetting…";
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) return `resets in ${d}d ${h}h`;
	if (h > 0) return `resets in ${h}h ${m}m`;
	return `resets in ${Math.max(1, m)}m`;
}

const usageColor = (p: number): RGB => (p >= 85 ? C.pink : p >= 60 ? C.purple : C.teal);

function bar(pct: number, width: number, color: RGB = usageColor(pct)): string {
	const filled = Math.round((clampPct(pct) / 100) * width);
	return fg(color, "█".repeat(filled)) + fg(C.track, "█".repeat(width - filled));
}

export class UsageView {
	private limitDetails = false;
	private spendDetails = false;
	private tab: "limits" | "spend" = "limits";
	private period = 1;
	private content: string[] = [];
	private scroll: ScrollView;
	constructor(
		public sections: Section[], private reload: () => void, private done: () => void,
		private requestRender: () => void = () => {}, private maxHeight: () => number = () => 40,
	) {
		this.scroll = new ScrollView({ render: () => this.content, invalidate() {} }, { scrollbar: "hidden", follow: "none" });
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q") { this.done(); return; }
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.tab = this.tab === "limits" ? "spend" : "limits";
			this.scroll.scrollToStart();
		} else if (this.tab === "spend" && (matchesKey(data, "left") || matchesKey(data, "right") || /^[1-4]$/.test(data))) {
			this.period = /^[1-4]$/.test(data) ? Number(data) - 1 : (this.period + (matchesKey(data, "left") ? 3 : 1)) % PERIODS.length;
			this.scroll.scrollToStart();
		} else if (data === "r") this.reload();
		else if (data === "d") {
			if (this.tab === "spend") this.spendDetails = !this.spendDetails;
			else this.limitDetails = !this.limitDetails;
			this.scroll.scrollToStart();
		}
		else if (matchesKey(data, "up") || data === "k") this.scroll.scrollBy(-1);
		else if (matchesKey(data, "down") || data === "j") this.scroll.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1));
		else if (matchesKey(data, "pageDown")) this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
		else if (matchesKey(data, "home")) this.scroll.scrollToStart();
		else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
		else return;
		this.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel") return;
		this.scroll.scrollBy(event.wheelDelta ?? 0);
		this.requestRender();
		return { handled: true, render: true };
	}

	invalidate(): void { this.scroll.invalidate(); }

	private periodPicker(width: number): string {
		const short = width < 42;
		return PERIODS.map((p, i) => {
			const label = short ? ["7d", "30d", "60d", "All"][i]! : p.label;
			return i === this.period ? fg(C.sky, bold(`[${label}]`)) : fg(C.muted, ` ${label} `);
		}).join(" ");
	}

	private spendGrid(width: number, exact = false) {
		const tokenWidth = exact ? 17 : 11;
		const costWidth = 12;
		const labelWidth = Math.max(0, width - tokenWidth - costWidth - 4);
		return (label: string, count: string, cost: string) => width < (exact ? 52 : 38)
			? pair(label, `${count}  ${cost}`, width)
			: fit(label, labelWidth) + "  " + fit(count, tokenWidth, true) + "  " + fit(cost, costWidth, true);
	}

	private renderSpend(width: number, push: (line: string) => void, note: (text: string) => void): void {
		const source = this.sections.find(s => s.name === "Spend");
		if (!source || source.loading) { note("Reading saved session history…"); return; }
		if (source.error || !source.spend) { note(source.error ?? "Session history unavailable. Press r to retry."); return; }
		const report = source.spend;
		const period = PERIODS[this.period]!;
		const spend = report[period.key];
		const metrics = spend.metrics;
		const partial = report.allTime.complete === false;
		if (partial) note("Partial history: some files could not be read. Press r to retry.");
		if (metrics?.unpricedMessages) note(`${number(metrics.unpricedMessages)} responses unpriced; cost is a known subtotal.`);
		if (metrics?.missingBreakdownMessages) note("Category costs are partial; some responses only have a total price.");
		if (this.spendDetails) {
			this.renderSpendDetails(spend, width, push, note);
			return;
		}

		// The lifetime count is the only exact, long token number on the overview.
		const lifetime = report.allTime.metrics ? number(report.allTime.metrics.tokens.total) : "Unknown";
		push(fg(C.text, bold(`${lifetime} tokens`)) + fg(C.muted, " all time"));
		push("");
		push(this.periodPicker(width));
		push("");
		push(pair(fg(C.text, bold(preciseMoney(spend.total))), fg(C.text, metrics ? `${tokens(metrics.tokens.total)} tokens` : "Tokens unavailable"), width));
		push(pair(fg(C.muted, "API-equivalent cost"), fg(C.muted, period.key === "allTime" ? "all time" : `last ${period.label}`), width));
		push("");
		const grid = this.spendGrid(width);
		push(fg(C.muted, grid("Tokens", "Volume", "Cost")));
		if (metrics) {
			for (const [key, label] of [["input", "Uncached input"], ["cacheRead", "Cache read"], ["cacheWrite", "Cache write"], ["output", "Output"]] as const) {
				push(grid(fg(C.muted, label), fg(C.text, tokens(metrics.tokens[key])), fg(C.text, preciseMoney(metrics.cost[key]))));
			}
			push("");
			const input = metrics.tokens.input + metrics.tokens.cacheRead + metrics.tokens.cacheWrite;
			const hit = input > 0 ? `${(metrics.tokens.cacheRead / input * 100).toFixed(1)}%` : "—";
			const savings = metrics.cacheSavings;
			const saved = savings?.coveredTokens ? preciseMoney(savings.estimated) : "unavailable";
			const left = fg(C.muted, "Cache hit ") + fg(C.teal, hit);
			const right = fg(C.muted, `Est. saved${savings?.unratedTokens ? "*" : ""} `) + fg(C.teal, saved);
			if (visibleWidth(left) + visibleWidth(right) + 4 <= width) push(pair(left, right, width));
			else { push(left); push(right); }
			if (savings?.unratedTokens) note("* Savings exclude cache tokens without comparable pricing.");
		} else note("Token breakdown unavailable in these records.");
		if (!spend.messages) note("No recorded usage in this period.");
	}

	private renderSpendDetails(spend: Spend, width: number, push: (line: string) => void, note: (text: string) => void): void {
		push(pair(fg(C.text, bold("Models & history")), fg(C.muted, "d back"), width));
		push(this.periodPicker(width));
		push("");
		const grid = this.spendGrid(width);
		const color = (id: string, i: number) => COST_COLORS[id] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length]!;
		push(fg(C.muted, grid("Provider / model", "Tokens", "Cost")));
		for (const [i, p] of spend.byProvider.entries()) {
			const count = p.metrics?.tokens.total;
			push(grid(fg(C.text, bold(providerName(p.provider))), count === undefined ? "—" : tokens(count), preciseMoney(p.total)));
			for (const m of p.models) {
				const share = m.metrics && spend.metrics?.tokens.total ? `${(m.metrics.tokens.total / spend.metrics.tokens.total * 100).toFixed(1)}%` : "—";
				const label = `  ${m.model} (${share})`;
				const count = m.metrics ? tokens(m.metrics.tokens.total) : "—";
				if (visibleWidth(label) <= Math.max(0, width - 27)) push(grid(fg(C.muted, label), count, preciseMoney(m.total)));
				else {
					note(`  ${m.model}`);
					push(grid(fg(C.muted, `    ${share} of tokens`), count, preciseMoney(m.total)));
				}
			}
			const share = spend.metrics?.tokens.total && count !== undefined ? `${(count / spend.metrics.tokens.total * 100).toFixed(1)}% of tokens` : "Token share unavailable";
			push(fg(color(p.provider, i), `  ${share}`));
			push("");
		}
		if (!spend.messages) note("No recorded usage in this period.");
		const chart = (label: string, series: { color: RGB; daily: number[] }[], format: (n: number) => string) => {
			if (!series.length) return;
			const chart = columnChart(series, { height: 3, colWidth: width >= spend.days * 2 ? 2 : 1, width, track: C.track });
			push(pair(fg(C.muted, label), fg(C.muted, `peak ${format(chart.peak)}/day`), width));
			chart.rows.forEach(push);
			push(pair(fg(C.subtle, `${chart.shown} days ago`), fg(C.subtle, "now"), visibleWidth(chart.rows[0] ?? "")));
			push("");
		};
		chart("Daily tokens", spend.byProvider.map((p, i) => ({ color: color(p.provider, i), daily: p.dailyTokens ?? new Array(spend.days).fill(0) })), tokens);
		chart("Daily cost", spend.byProvider.map((p, i) => ({ color: color(p.provider, i), daily: p.daily })), preciseMoney);
		if (spend.metrics) {
			const exact = this.spendGrid(width, true);
			push(fg(C.muted, exact("Exact token counts", "Tokens", "Cost")));
			for (const [key, label] of [["input", "Uncached input"], ["cacheRead", "Cache read"], ["cacheWrite", "Cache write"], ["output", "Output"]] as const) {
				push(exact(label, number(spend.metrics.tokens[key]), preciseMoney(spend.metrics.cost[key])));
			}
			push(exact("Total", number(spend.metrics.tokens.total), preciseMoney(spend.total)));
			push("");
			const savings = spend.metrics.cacheSavings;
			if (savings?.unratedTokens) note(`${number(savings.unratedTokens)} cache-read tokens lack comparable pricing and are excluded from estimated savings.`);
		}
		push(fg(C.text, "Subscription weeks"));
		const now = Date.now();
		for (const s of this.sections.filter(s => s.name !== "Spend")) {
			const w = s.weekly;
			push(pair(fg(C.muted, s.name), fg(C.text, w?.status === "ready" && w.to > now ? preciseMoney(w.total) : w?.status === "loading" ? "calculating…" : "unavailable"), width));
			if (w?.status === "ready" && w.to > now) note(`  ${new Date(w.from).toLocaleString()} to ${new Date(w.to).toLocaleString()} (local time)`);
			else if (w?.status === "unavailable") note(`  ${w.reason}`);
		}
		push("");
		note(`${number(spend.messages)} recorded responses in this period. All-time charts show the latest 60 days; buckets are rolling 24 hours.`);
		note("Cache hit = reads / (uncached input + reads + writes). Savings compare cache-read cost with the same response's uncached rate; estimates, not billed savings.");
		note("Saved Pi history only. Other clients, deleted history and unrecorded nested calls are excluded.");
	}

	render(width: number): string[] {
		if (width < 4) return [truncateToWidth("Usage", Math.max(0, width))];
		const inner = width - 2;
		const edge = (s: string) => fg(C.track, s);
		const row = (content: string) => {
			const t = truncateToWidth(content, inner);
			return edge("│") + t + " ".repeat(Math.max(0, inner - visibleWidth(t))) + edge("│");
		};
		const title = truncateToWidth(` ${bold("Usage")} `, inner - 1);
		const heading = edge("╭─") + fg(C.text, title) + edge("─".repeat(Math.max(0, inner - 1 - visibleWidth(title))) + "╮");
		const limits = this.sections.filter(s => s.name !== "Spend");
		const cols = usageColumns(inner, limits.flatMap(s => s.wins.map(w => w.label)));
		const body: string[] = [""];
		const push = (line: string) => body.push(`  ${fit(line, cols.width)}`);
		const note = (text: string) => {
			if (cols.width) for (const line of wrapTextWithAnsi(fg(C.muted, text), cols.width)) push(line);
		};
		if (this.tab === "spend") this.renderSpend(cols.width, push, note);
		else {
			push(fg(C.muted, fit("Subscription", cols.labelWidth) + " " + fit("Quota used", cols.barWidth + 5)
				+ " ".repeat(cols.resetGap) + fit("Reset in", cols.resetWidth, true)));
			push("");
			const now = Date.now();
			for (const s of limits) {
				push(fg(C.text, bold(s.name)) + (s.plan ? `  ${fg(C.muted, s.plan)}` : ""));
				if (s.loading) note("  fetching…");
				else if (s.error) note(s.error);
				else if (!s.wins.length) note("No quota windows reported.");
				else for (const w of s.wins) {
					const reset = fmtReset(w.resetsAt, now).replace(/^resets in /, "") || "—";
					push(fg(C.muted, "  " + windowLabel(w.label, Math.max(0, cols.labelWidth - 2))) + " "
						+ bar(w.used, cols.barWidth) + " " + fg(usageColor(w.used), `${Math.round(w.used)}%`.padStart(4))
						+ " ".repeat(cols.resetGap) + fg(C.muted, fit(reset, cols.resetWidth, true)));
					if (w.note) note(`  ${w.note}`);
					if (this.limitDetails && w.resetsAt) note(`  Resets ${new Date(w.resetsAt).toLocaleString()} (local time)`);
				}
				for (const extra of s.extra) note(extra);
				push("");
			}
		}

		body.push("");
		this.content = body.map(line => truncateToWidth(line, inner));
		const bodyHeight = Math.max(1, Math.floor(this.maxHeight()) - 6);
		this.scroll.updateLayout(body.length, bodyHeight, this.requestRender);
		const start = this.scroll.scrollTop;
		const shown = this.scroll.render(inner).slice(start, start + bodyHeight);
		const overflowing = body.length > bodyHeight;
		const detailAction = this.tab === "spend" ? this.spendDetails ? "back" : inner < 68 ? "models" : "models & history"
			: this.limitDetails ? "less" : "dates";
		const controls = `tab ${inner < 68 ? "tabs" : "switch"} · d ${detailAction} · r refresh${overflowing ? " · ↑↓" : ""} · esc${inner < 68 ? "" : " close"}`;
		const tabs = (this.tab === "limits" ? fg(C.sky, bold("[ Limits ]")) : fg(C.muted, "  Limits  ")) + "   "
			+ (this.tab === "spend" ? fg(C.sky, bold("[ Spend ]")) : fg(C.muted, "  Spend  "));
		const scope = this.tab === "spend"
			? pair(fg(C.subtle, "API-equivalent USD · Pi history"), fg(C.muted, "←→ period"), cols.width)
			: fg(C.subtle, "Quota used · provider reset times");
		return [heading, row(`  ${tabs}`), edge("├" + "─".repeat(inner) + "┤"), ...shown.map(row),
			row(`  ${scope}`), row(`  ${fg(C.muted, controls)}`), edge("╰" + "─".repeat(inner) + "╯")];
	}
}

export interface UsageSource {
	name: string;
	fetch: () => Promise<Partial<Section>>;
	providerIds: string[];
}

/** Publish independent quota requests immediately; scan all spend windows together, then reuse the cache for subscription weeks. */
export async function refreshUsageSections(
	sections: Section[], sources: UsageSource[],
	options: { isCurrent: () => boolean; onChange: () => void; readHistory?: typeof readSpend; readReport?: typeof readSpendReport; now?: () => number; dir?: string },
): Promise<void> {
	if (!options.isCurrent()) return;
	const dir = options.dir ?? join(PI_DIR, "sessions");
	const now = (options.now ?? Date.now)();
	const reader = options.readHistory ?? readSpend;
	sections.splice(0, sections.length, ...[...sources.map(s => s.name), "Spend"].map(name => ({ name, wins: [], extra: [], loading: true })));
	options.onChange();
	const publish = (index: number, section: Section) => {
		if (!options.isCurrent()) return;
		sections[index] = section;
		options.onChange();
	};
	const failure = (name: string, e: unknown): Section => ({ name, wins: [], extra: [], loading: false, error: e instanceof Error ? e.message : String(e) });
	const history = Promise.resolve().then(() => (options.readReport ?? readSpendReport)({ dir, now: () => now }));
	const cost = history.then(
		spend => publish(sources.length, { name: "Spend", wins: [], extra: [], spend, loading: false }),
		error => publish(sources.length, failure("Spend", error)),
	);
	await Promise.all([cost, ...sources.map(async (source, index) => {
		try {
			const result = await source.fetch();
			if (!options.isCurrent()) return;
			const section: Section = { name: source.name, wins: [], extra: [], ...result, weekly: { status: "loading" }, loading: false };
			publish(index, section);
			await history.catch(() => undefined); // avoid concurrently parsing the same session files
			if (!options.isCurrent()) return;
			const asOf = (options.now ?? Date.now)();
			const weekly = await readWeeklyCost(section.wins, source.providerIds, dir, asOf, reader);
			publish(index, { ...section, weekly });
		} catch (error) { publish(index, failure(source.name, error)); }
	})]);
}

// ---------- command ----------
export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show Limits and Spend tabs: quotas, all-time tokens, 7/30/60-day costs and cache analytics",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") return;

			const providers: UsageSource[] = [
				{ name: "Anthropic", fetch: fetchAnthropic, providerIds: ["anthropic"] },
				{ name: "Codex", fetch: fetchCodex, providerIds: ["openai", "openai-codex"] },
				{ name: "Antigravity", fetch: fetchAntigravity, providerIds: ["google-antigravity", "antigravity"] },
			];
			const sections: Section[] = [];
			let generation = 0;
			let closed = false;
			let refreshing = false;

			await ctx.ui.custom<void>(
				(tui, _theme, _kb, done) => {
					const load = () => {
						if (closed || refreshing) return; // don't duplicate network requests or session scans on repeated r
						refreshing = true;
						const gen = ++generation;
						void refreshUsageSections(sections, providers, {
							isCurrent: () => !closed && gen === generation,
							onChange: () => tui.requestRender(),
						}).catch(error => {
							if (!closed) ctx.ui.notify(`Usage refresh failed: ${error instanceof Error ? error.message : String(error)}`, "error");
						}).finally(() => { refreshing = false; });
					};
					const view = new UsageView(sections, load, () => {
						closed = true;
						done();
					}, () => tui.requestRender(), () => Math.max(7, Math.floor(tui.terminal.rows * 0.9)));
					load();
					return view;
				},
				{ overlay: true, overlayOptions: { width: 76, minWidth: 50, maxHeight: "90%", anchor: "center" } },
			);
		},
	});
}
