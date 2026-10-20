/**
 * /usage: subscription quota for Anthropic (Claude), OpenAI Codex (ChatGPT) and Antigravity, plus 30-day spend.
 *
 * Anthropic tokens are only read; Pi refreshes its own when you send a message.
 * The Codex login in ~/.codex/auth.json is refreshed here when it expires (see codex-auth.ts).
 *   Anthropic   GET api.anthropic.com/api/oauth/usage      token: pi auth.json, else ~/.claude/.credentials.json
 *   Codex       GET chatgpt.com/backend-api/wham/usage     token: ~/.codex/auth.json (Pi's own OpenAI token is not accepted)
 *   Antigravity `agy -p /usage --output-format json`        (answered locally by agy, no model turn)
 *
 * API cost   API-equivalent cost of the last 30 days, summed from saved sessions (see spend.ts)
 *
 * Weekly costs follow each provider's real quota reset, not the calendar week.
 * Keys: d = details, r = refresh, arrows / j / k = scroll, esc / q / enter = close.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { withCodexCredentials } from "./codex-auth.ts";
import { columnChart, costRows, stackedBar } from "./cost-chart.ts";
import { readSpend, type Spend } from "./spend.ts";
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
interface CostProvider {
	name: string;
	color: RGB;
	total: number;
	share: number; // percent of the total, 0..100
	daily: number[];
	plan?: number;
	multiple?: number;
	models: { model: string; total: number }[];
}
interface CostView {
	total: number;
	plansTotal: number;
	providers: CostProvider[];
}
export interface Section {
	name: string;
	plan?: string;
	wins: Win[];
	extra: string[]; // free-form lines
	cost?: CostView; // drawn as bars by the renderer
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
const PROVIDER_NAMES: { [id: string]: string } = { openai: "OpenAI", anthropic: "Anthropic", google: "Google" };
const providerName = (id: string) => PROVIDER_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Monthly plan prices in USD. Value multiple = last 30 days at API prices / plan price. Edit to match what you pay.
const PLANS: { [provider: string]: number } = { openai: 20, anthropic: 20 };
// Blue and orange stay distinguishable for most colour-vision types; other providers cycle through the rest.
const COST_COLORS: { [provider: string]: RGB } = { openai: C.sky, anthropic: C.orange };
const FALLBACK_COLORS: RGB[] = [C.purple, C.teal, C.rose, C.blue];

async function fetchSpend(history?: Promise<Spend>): Promise<Partial<Section>> {
	const spend = await (history ?? readSpend({ dir: join(PI_DIR, "sessions") }));
	const window = `last ${spend.days} days`;
	if (spend.complete === false) throw new UsageError("session history could not be fully read");
	if (!spend.messages) return { plan: window, extra: ["no spend recorded in saved sessions yet"] };
	let fallback = 0;
	const providers: CostProvider[] = costRows(spend.byProvider, PLANS).map((row) => {
		const data = spend.byProvider.find((p) => p.provider === row.provider);
		return {
			name: providerName(row.provider),
			color: COST_COLORS[row.provider] ?? FALLBACK_COLORS[fallback++ % FALLBACK_COLORS.length]!,
			total: row.total,
			share: spend.total > 0 ? (row.total / spend.total) * 100 : 0,
			daily: data?.daily ?? new Array<number>(spend.days).fill(0),
			plan: row.plan,
			multiple: row.multiple,
			models: data?.models ?? [],
		};
	});
	const plansTotal = providers.reduce((a, p) => a + (p.plan ?? 0), 0);
	return { plan: window, cost: { total: spend.total, plansTotal, providers } };
}

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
	private details = false;
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
		if (data === "r") this.reload();
		else if (data === "d") { this.details = !this.details; this.scroll.scrollToStart(); }
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

	private renderCost(cost: CostView, width: number, push: (line: string) => void): void {
		push(pair(fg(C.text, "30-day API value"), fg(C.text, bold(money(cost.total))), width));
		push(stackedBar(cost.providers.map(p => ({ value: p.total, color: p.color })), width, C.track));
		// A compact key, not another table repeating totals, shares and plan prices.
		const live = cost.providers.filter(p => p.total > 0);
		let legend = "";
		for (const p of live.length ? live : cost.providers) {
			const label = `${fg(p.color, "■")} ${fg(C.muted, p.name)}`;
			const value = fg(C.text, money(p.total));
			const entry = `${label} ${value}`;
			if (legend && visibleWidth(legend) + 4 + visibleWidth(entry) > width) { push(legend); legend = ""; }
			if (visibleWidth(entry) > width) { push(pair(label, value, width)); continue; }
			legend += (legend ? "    " : "") + entry;
		}
		if (legend) push(legend);
		if (!this.details || !cost.providers.length) return;

		push("");
		if (cost.plansTotal > 0) push(pair(fg(C.muted, "Combined configured plan value"),
			fg(C.muted, `${(cost.total / cost.plansTotal).toFixed(1)}× of ${money(cost.plansTotal).replace(".00", "")}/month`), width));
		for (const p of cost.providers) {
			push(pair(`${fg(p.color, "■")} ${fg(C.text, p.name)}`, fg(C.text, money(p.total)), width));
			if (p.plan) push(pair(fg(C.muted, "  Configured plan value"), fg(C.muted, `${(p.multiple ?? 0).toFixed(1)}× of ${money(p.plan).replace(".00", "")}`), width));
			for (const model of p.models.slice(0, 3)) push(pair(fg(C.muted, `  ${model.model}`), fg(C.muted, money(model.total)), width));
			if (p.models.length > 3) push(fg(C.subtle, `  ${p.models.length - 3} more models`));
		}
		push("");
		const days = cost.providers[0]!.daily.length;
		const chart = columnChart(cost.providers.map(p => ({ color: p.color, daily: p.daily })),
			{ height: 4, colWidth: width >= days * 2 ? 2 : 1, width, track: C.track });
		push(pair(fg(C.muted, "Daily API value"), fg(C.muted, `peak ${money(chart.peak)}/day`), width));
		chart.rows.forEach(push);
		push(pair(fg(C.subtle, `${chart.shown}d ago`), fg(C.subtle, "now"), visibleWidth(chart.rows[0] ?? "")));
	}

	render(width: number): string[] {
		if (width < 4) return [truncateToWidth("Usage", Math.max(0, width))];
		const inner = width - 2;
		const edge = (s: string) => fg(C.track, s);
		const row = (content: string) => {
			const t = truncateToWidth(content, inner);
			return edge("│") + t + " ".repeat(Math.max(0, inner - visibleWidth(t))) + edge("│");
		};
		const title = truncateToWidth(` ${bold(this.details ? "Usage details" : "Usage")} `, inner - 1);
		const heading = edge("╭─") + fg(C.text, title) + edge("─".repeat(Math.max(0, inner - 1 - visibleWidth(title))) + "╮");
		const cols = usageColumns(inner, this.sections.flatMap(s => s.wins.map(w => w.label)));
		const body: string[] = [""];
		const push = (line: string) => body.push(`  ${fit(line, cols.width)}`);
		const note = (text: string) => {
			if (cols.width) for (const line of wrapTextWithAnsi(fg(C.muted, text), cols.width)) push(line);
		};
		const date = (at: number) => new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
		const now = Date.now();
		const lanes = (quota: string, value = "") => fit(quota, cols.quotaWidth) + "   " + fit(value, cols.valueWidth, true);
		if (this.sections.some(s => s.name !== "API cost" && !s.cost)) {
			const labels = fit("Subscription", cols.labelWidth) + " " + fit("Quota used", cols.barWidth + 5)
				+ " ".repeat(cols.resetGap) + fit("Reset in", cols.resetWidth, true);
			push(fg(C.muted, cols.split ? lanes(labels, "Weekly API value") : pair("Subscription / quota", "Weekly API value", cols.width)));
			push("");
		}

		for (const s of this.sections) {
			if (s.name === "API cost" || s.cost) {
				if (s.cost && !s.loading && !s.error) this.renderCost(s.cost, cols.width, push);
				else {
					push(pair(fg(C.text, "30-day API value"), s.loading ? fg(C.muted, "calculating…") : "", cols.width));
					if (s.error) note(s.error);
					for (const extra of s.extra) note(extra);
				}
				push("");
				continue;
			}

			const weekly = s.weekly;
			const ready = weekly?.status === "ready" && weekly.to > now ? weekly : undefined;
			const amount = ready ? fg(C.text, bold(money(ready.total)))
				: fg(C.muted, s.loading ? "…" : weekly?.status === "loading" ? "calculating…" : weekly || s.error ? "unavailable" : "—");
			const since = ready ? fg(C.muted, `since ${date(ready.from)}`) : "";
			const name = fg(C.text, bold(s.name)) + (s.plan ? `  ${fg(C.muted, s.plan)}` : "");
			push(cols.split ? lanes(name, amount) : pair(name, amount, cols.width));

			const quotaRows: string[] = [];
			if (s.loading) quotaRows.push(fg(C.muted, "  fetching…"));
			else if (s.error) quotaRows.push(...wrapTextWithAnsi(fg(C.muted, `  ${s.error}`), Math.max(1, cols.quotaWidth)));
			else for (const w of s.wins) {
				const reset = fmtReset(w.resetsAt, now).replace(/^resets in /, "");
				const resetText = !reset ? "—" : reset === "resetting…" ? "now" : !cols.split ? `in ${reset}` : reset;
				quotaRows.push(fg(C.muted, "  " + windowLabel(w.label, Math.max(0, cols.labelWidth - 2))) + " "
					+ bar(w.used, cols.barWidth) + " " + fg(usageColor(w.used), `${Math.round(w.used)}%`.padStart(4))
					+ " ".repeat(cols.resetGap) + fg(C.muted, fit(resetText, cols.resetWidth, true)));
				if (w.note) quotaRows.push(fg(C.muted, `  ${w.note}`));
			}
			if (cols.split) {
				if (!quotaRows.length && since) quotaRows.push("");
				quotaRows.forEach((line, i) => push(lanes(line, i === 0 ? since : "")));
			} else {
				if (since) push(fit(since, cols.width, true));
				quotaRows.forEach(line => push(line));
			}
			for (const extra of s.extra) note(extra);
			if (this.details && ready) note(`Week ${date(ready.from)} to ${date(ready.to)} (local time)`);
			else if (this.details && weekly && weekly.status !== "loading") note(weekly.status === "unavailable" ? weekly.reason : "weekly reset passed; press r to refresh");
			push("");
		}
		if (this.details) {
			note("Weekly values use each subscription's own reset period, not the calendar week.");
			note("Not extra charges. Excludes subagent and /btw calls.");
		}

		this.content = body.map(line => truncateToWidth(line, inner));
		const bodyHeight = Math.max(1, Math.floor(this.maxHeight()) - 4);
		this.scroll.updateLayout(body.length, bodyHeight, this.requestRender);
		const start = this.scroll.scrollTop;
		const shown = this.scroll.render(inner).slice(start, start + bodyHeight);
		const overflowing = body.length > bodyHeight;
		const controls = `esc close · d ${this.details ? "less" : "details"} · r refresh${overflowing ? " · ↑↓ scroll" : ""}`;
		return [heading, ...shown.map(row), row(`  ${fg(C.subtle, "API-equivalent · saved Pi sessions only")}`),
			row(`  ${fg(C.muted, controls)}`), edge("╰" + "─".repeat(inner) + "╯")];
	}
}

export interface UsageSource {
	name: string;
	fetch: () => Promise<Partial<Section>>;
	providerIds: string[];
}

/** Independent quota requests; publish bars first, then attach exact-window costs from the warmed session cache. */
export async function refreshUsageSections(
	sections: Section[], sources: UsageSource[],
	options: { isCurrent: () => boolean; onChange: () => void; readHistory?: typeof readSpend; now?: () => number; dir?: string },
): Promise<void> {
	if (!options.isCurrent()) return;
	const dir = options.dir ?? join(PI_DIR, "sessions");
	const now = (options.now ?? Date.now)();
	const reader = options.readHistory ?? readSpend;
	sections.splice(0, sections.length, ...[...sources.map(s => s.name), "API cost"].map(name => ({ name, wins: [], extra: [], loading: true })));
	options.onChange();
	const publish = (index: number, section: Section) => {
		if (!options.isCurrent()) return;
		sections[index] = section;
		options.onChange();
	};
	const failure = (name: string, e: unknown): Section => ({ name, wins: [], extra: [], loading: false, error: e instanceof Error ? e.message : String(e) });
	const history = Promise.resolve().then(() => reader({ dir, now: () => now }));
	const cost = fetchSpend(history).then(
		result => publish(sources.length, { name: "API cost", wins: [], extra: [], ...result, loading: false }),
		error => publish(sources.length, failure("API cost", error)),
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
		description: "Show subscription bars, API-equivalent cost since each weekly reset, and 30-day spend",
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
					}, () => tui.requestRender(), () => Math.max(5, Math.floor(tui.terminal.rows * 0.9)));
					load();
					return view;
				},
				{ overlay: true, overlayOptions: { width: 96, minWidth: 50, maxHeight: "90%", anchor: "center" } },
			);
		},
	});
}
