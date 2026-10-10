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
 * Keys in the overlay: r = refresh, esc / q / enter = close.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { withCodexCredentials } from "./codex-auth.ts";
import { columnChart, costRows, stackedBar } from "./cost-chart.ts";
import { readSpend } from "./spend.ts";

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
	green: [0x42, 0xbe, 0x65] as RGB,
	text: [0xdd, 0xe1, 0xe6] as RGB,
	muted: [0x8d, 0x91, 0x99] as RGB,
	subtle: [0x6e, 0x74, 0x7d] as RGB,
	track: [0x33, 0x35, 0x3b] as RGB,
};
const RESET = "\x1b[0m";
const fg = ([r, g, b]: RGB, s: string) => `\x1b[38;2;${r};${g};${b}m${s}${RESET}`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

// ---------- model ----------
interface Win {
	label: string;
	used: number; // percent 0..100
	resetsAt?: number; // epoch ms
	note?: string;
}
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
interface Section {
	name: string;
	plan?: string;
	wins: Win[];
	extra: string[]; // free-form lines
	cost?: CostView; // drawn as bars by the renderer
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

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clampPct = (n: number) => Math.max(0, Math.min(100, n));
const iso = (v: unknown): number | undefined => {
	if (typeof v !== "string") return undefined;
	const t = Date.parse(v);
	return Number.isNaN(t) ? undefined : t;
};

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

	const wins: Win[] = [];
	const known: [string, string][] = [
		["five_hour", "5h"],
		["seven_day", "7d"],
		["seven_day_opus", "7d Opus"],
		["seven_day_sonnet", "7d Sonnet"],
	];
	for (const [key, label] of known) {
		const w = d[key];
		const u = num(w?.utilization);
		if (u !== undefined) wins.push({ label, used: clampPct(u), resetsAt: iso(w.resets_at) });
	}
	// Any other bucket with a dollar cap (the API reports it under an opaque key): show as a spend cap.
	for (const [key, w] of Object.entries<any>(d)) {
		if (known.some(([k]) => k === key) || !w || typeof w !== "object") continue;
		const limit = num(w.limit_dollars);
		const used = num(w.used_dollars);
		if (limit && used !== undefined) {
			wins.push({
				label: "Spend cap",
				used: clampPct(num(w.utilization) ?? (used / limit) * 100),
				resetsAt: iso(w.resets_at),
				note: `$${used.toFixed(2)} / $${limit.toFixed(0)}`,
			});
		}
	}
	if (!wins.length) throw new UsageError("no quota windows returned");
	return { wins };
}

function windowLabel(seconds: number | undefined, fallback: string): string {
	if (!seconds) return fallback;
	if (seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	return fallback;
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
	const d = usage.value;

	const rl = d.rate_limit ?? {};
	const wins: Win[] = [];
	for (const [w, fb] of [
		[rl.primary_window, "5h"],
		[rl.secondary_window, "7d"],
	] as const) {
		const used = num(w?.used_percent);
		if (used === undefined) continue;
		const at = num(w.reset_at);
		const after = num(w.reset_after_seconds);
		wins.push({
			label: windowLabel(num(w.limit_window_seconds), fb),
			used: clampPct(used),
			resetsAt: at ? at * 1000 : after !== undefined ? Date.now() + after * 1000 : undefined,
		});
	}
	const extra: string[] = [];
	const bal = d.credits?.balance;
	if (d.credits?.has_credits && bal !== undefined) extra.push(`credits balance: ${bal}`);
	if (usage.warning) extra.push(usage.warning);
	if (!wins.length) throw new UsageError("no quota windows returned");
	return { plan: typeof d.plan_type === "string" ? d.plan_type : undefined, wins, extra };
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

		const wins: Win[] = [];
		for (const g of body.command.data?.groups ?? []) {
			const words = String(g.name ?? "").split(/\s+/).filter(Boolean);
			if (words.at(-1)?.toLowerCase() === "models") words.pop();
			const group = words.join(" ").replace(" and ", "/");
			for (const b of g.buckets ?? []) {
				const rem = num(b.remaining_fraction);
				if (rem === undefined) continue;
				const win = b.window === "weekly" ? "7d" : (b.window ?? "");
				wins.push({ label: `${group} ${win}`.trim(), used: clampPct((1 - rem) * 100), resetsAt: iso(b.reset_time) });
			}
		}
		if (!wins.length) throw new UsageError("no quota windows returned");
		return { wins };
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

async function fetchSpend(): Promise<Partial<Section>> {
	const spend = await readSpend({ dir: join(PI_DIR, "sessions") });
	const window = `last ${spend.days} days`;
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
function fmtReset(at?: number): string {
	if (!at) return "";
	const s = Math.round((at - Date.now()) / 1000);
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

class UsageView {
	sections: Section[];
	private reload: () => void;
	private done: () => void;
	constructor(sections: Section[], reload: () => void, done: () => void) {
		this.sections = sections;
		this.reload = reload;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q") this.done();
		else if (data === "r") this.reload();
	}

	invalidate(): void {}

	private renderCost(cost: CostView, barW: number, inner: number, push: (line: string) => void): void {
		const swatch = (p: CostProvider) => fg(p.color, "■");
		const multiple = (m: number) => fg(m >= 1 ? C.green : C.rose, bold(`${m.toFixed(1)}×`));
		const noZeros = (n: number) => money(n).replace(".00", "");

		const overall = cost.plansTotal > 0 ? Math.round((cost.total / cost.plansTotal) * 10) / 10 : undefined;
		const headline =
			`    ${fg(C.text, bold(money(cost.total)))}  ${fg(C.muted, "at API prices")}` +
			(overall === undefined ? "" : `  ${fg(C.subtle, "·")}  ${multiple(overall)} ${fg(C.muted, `your ${noZeros(cost.plansTotal)} of plans`)}`);

		const nameW = Math.max(...cost.providers.map((p) => p.name.length));
		const legend: string[] = [];
		for (const p of cost.providers) {
			const plan = p.plan ? `  ${multiple(p.multiple ?? 0)} ${fg(C.muted, `of ${noZeros(p.plan)} plan`)}` : "";
			legend.push(`    ${swatch(p)} ${fg(C.text, p.name.padEnd(nameW))}  ${fg(p.color, money(p.total).padStart(9))}  ${fg(C.subtle, `${Math.round(p.share)}%`.padStart(4))}${plan}`);
			if (p.models.length > 1) {
				legend.push(`      ${fg(C.subtle, p.models.slice(0, 3).map((m) => `${m.model} ${money(m.total)}`).join("  ·  "))}`);
			}
		}

		// The bar spans the text above and below it: at least as wide as the quota bars, at most the modal.
		const textW = Math.max(...[headline, ...legend].map((l) => visibleWidth(l))) - 4;
		const avail = Math.max(barW, Math.min(textW, inner - 8));

		push(headline);
		push("");
		push(`    ${stackedBar(cost.providers.map((p) => ({ value: p.total, color: p.color })), avail, C.track)}`);
		for (const l of legend) push(l);
		push("");

		const days = cost.providers[0]!.daily.length;
		const chart = columnChart(
			cost.providers.map((p) => ({ color: p.color, daily: p.daily })),
			{ height: 4, colWidth: avail >= days * 2 ? 2 : 1, width: avail, track: C.track },
		);
		chart.rows.forEach((line, i) => push(`    ${line}${i === 0 ? `  ${fg(C.subtle, `peak ${money(chart.peak)}/day`)}` : ""}`));
		const span = visibleWidth(chart.rows[0] ?? "");
		const left = `${chart.shown}d ago`;
		push(`    ${fg(C.subtle, left + " ".repeat(Math.max(1, span - left.length - 3)) + "now")}`);
		push(`    ${fg(C.subtle, "Excludes subagent and /btw calls.")}`);
	}

	render(width: number): string[] {
		const inner = Math.max(10, width - 2);
		const edge = (s: string) => fg(C.rose, s);
		const row = (content: string) => {
			const t = truncateToWidth(content, inner);
			return edge("│") + t + " ".repeat(Math.max(0, inner - visibleWidth(t))) + edge("│");
		};
		const title = ` ${bold("Usage")} `;
		const lines: string[] = [edge("╭─") + fg(C.rose, title) + edge("─".repeat(Math.max(0, inner - 1 - visibleWidth(title))) + "╮")];
		lines.push(row(""));

		const labelW = Math.min(
			16,
			Math.max(4, ...this.sections.flatMap((s) => s.wins.map((w) => w.label.length))),
		);
		const barW = Math.max(8, Math.min(30, inner - labelW - 48));

		for (const s of this.sections) {
			const plan = s.plan ? fg(C.muted, `  ·  ${s.plan}`) : "";
			lines.push(row(`  ${fg(C.blue, bold(s.name))}${plan}`));
			if (s.loading) lines.push(row(`    ${fg(C.subtle, "fetching…")}`));
			else if (s.error) lines.push(row(`    ${fg(C.pink, "✘")} ${fg(C.muted, s.error)}`));
			else {
				for (const w of s.wins) {
					const pct = `${Math.round(w.used)}%`.padStart(4);
					const tail = [w.note, fmtReset(w.resetsAt)].filter(Boolean).join("  ·  ");
					lines.push(
						row(`    ${fg(C.text, w.label.padEnd(labelW))} ${bar(w.used, barW)} ${fg(usageColor(w.used), pct)}  ${fg(C.subtle, tail)}`),
					);
				}
				for (const e of s.extra) lines.push(row(`    ${fg(C.muted, e)}`));
				if (s.cost) this.renderCost(s.cost, barW, inner, (l) => lines.push(row(l)));
			}
			lines.push(row(""));
		}

		lines.push(row(`  ${fg(C.subtle, "r refresh  ·  esc close")}`));
		lines.push(edge("╰" + "─".repeat(inner) + "╯"));
		return lines;
	}
}

// ---------- command ----------
export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show Anthropic, Codex and Antigravity subscription usage and 30-day spend",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			const providers: { name: string; fetch: () => Promise<Partial<Section>> }[] = [
				{ name: "Anthropic", fetch: fetchAnthropic },
				{ name: "Codex", fetch: fetchCodex },
				{ name: "Antigravity", fetch: fetchAntigravity },
				{ name: "API cost", fetch: fetchSpend },
			];
			const sections: Section[] = providers.map((p) => ({ name: p.name, wins: [], extra: [], loading: true }));
			let generation = 0;
			let closed = false;

			await ctx.ui.custom<void>(
				(tui, _theme, _kb, done) => {
					const load = () => {
						const gen = ++generation;
						providers.forEach((p, i) => {
							sections[i] = { name: p.name, wins: [], extra: [], loading: true };
							p.fetch().then(
								(r) => {
									if (gen === generation) sections[i] = { name: p.name, wins: [], extra: [], ...r, loading: false };
								},
								(e) => {
									if (gen === generation) sections[i] = { name: p.name, wins: [], extra: [], loading: false, error: e instanceof Error ? e.message : String(e) };
								},
							).finally(() => {
								if (!closed) tui.requestRender();
							});
						});
						tui.requestRender();
					};
					const view = new UsageView(sections, load, () => {
						closed = true;
						done();
					});
					load();
					return view;
				},
				{ overlay: true, overlayOptions: { width: 96, minWidth: 50, maxHeight: "90%", anchor: "center" } },
			);
		},
	});
}
