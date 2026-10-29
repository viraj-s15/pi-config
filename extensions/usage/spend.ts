import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const DAY_MS = 86_400_000;

export interface SpendOptions {
	dir: string;
	days?: number;
	/** Inclusive lower timestamp bound. When provided, files are not filtered by mtime. */
	from?: number;
	/** Exclusive upper timestamp bound. Future records are excluded even if this is later than now. */
	to?: number;
	now?: () => number;
}

export interface UsageTotals {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	unpricedMessages: number;
	missingBreakdownMessages: number;
	cacheSavings?: { estimated: number; coveredTokens: number; unratedTokens: number };
}

export interface Spend {
	total: number;
	messages: number;
	days: number;
	/** False when a directory or session file could not be read; zero must not imply complete accounting. */
	complete?: boolean;
	/** Cost per day, oldest first; the last entry is the most recent 24 hours. */
	daily: number[];
	dailyTokens?: number[];
	metrics?: UsageTotals;
	byProvider: { provider: string; total: number; daily: number[]; dailyTokens?: number[]; metrics?: UsageTotals; models: { model: string; total: number; metrics?: UsageTotals }[] }[];
}

export interface SpendReport {
	allTime: Spend;
	week: Spend;
	month: Spend;
	twoMonths: Spend;
}

interface UsageRecord {
	key: string; at: number; provider: string; model: string;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total: number };
	tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const cache = new Map<string, { mtimeMs: number; size: number; records: UsageRecord[] }>();
const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const metric = (): UsageTotals => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, unpricedMessages: 0, missingBreakdownMessages: 0, cacheSavings: { estimated: 0, coveredTokens: 0, unratedTokens: 0 } });

function parseLine(line: string): UsageRecord | undefined {
	if (!line.includes('"usage"')) return;
	let entry: any;
	try { entry = JSON.parse(line); } catch { return; }
	const message = entry?.message;
	if (message?.role !== "assistant") return;
	const at = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
	if (!Number.isFinite(at)) return;
	const usage = message.usage;
	const rawCost = usage?.cost;
	const cost = valid(rawCost?.total) ? {
		input: valid(rawCost.input) ? rawCost.input : undefined,
		output: valid(rawCost.output) ? rawCost.output : undefined,
		cacheRead: valid(rawCost.cacheRead) ? rawCost.cacheRead : undefined,
		cacheWrite: valid(rawCost.cacheWrite) ? rawCost.cacheWrite : undefined,
		total: rawCost.total,
	} : undefined;
	const rawTokens = usage;
	const hasTokens = [rawTokens?.input, rawTokens?.output, rawTokens?.cacheRead, rawTokens?.cacheWrite].some(valid);
	const tokens = hasTokens ? {
		input: valid(rawTokens.input) ? rawTokens.input : 0,
		output: valid(rawTokens.output) ? rawTokens.output : 0,
		cacheRead: valid(rawTokens.cacheRead) ? rawTokens.cacheRead : 0,
		cacheWrite: valid(rawTokens.cacheWrite) ? rawTokens.cacheWrite : 0,
	} : undefined;
	if (!cost && !tokens) return;
	const provider = String(message.provider ?? "unknown");
	const key = message.responseId ? `${provider}|${message.responseId}` : `${entry.id}|${at}`;
	return { key, at, provider, model: String(message.model ?? "unknown"), cost, tokens };
}

async function recordsOf(path: string, mtimeMs: number, size: number): Promise<UsageRecord[] | undefined> {
	const hit = cache.get(path);
	if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.records;
	try {
		const records = (await readFile(path, "utf8")).split("\n").flatMap((line) => parseLine(line) ?? []);
		cache.set(path, { mtimeMs, size, records });
		return records;
	} catch { return undefined; }
}

async function scan(dir: string): Promise<{ records: UsageRecord[]; complete: boolean }> {
	let names: string[] = [];
	let complete = true;
	try { names = (await readdir(dir, { recursive: true })).filter((n) => n.endsWith(".jsonl")); }
	catch { return { records: [], complete: false }; }
	const records: UsageRecord[] = [];
	for (const name of names.sort()) {
		const path = join(dir, name);
		try {
			const info = await stat(path);
			const fileRecords = await recordsOf(path, info.mtimeMs, info.size);
			if (!fileRecords) { complete = false; continue; }
			for (const record of fileRecords) records.push(record);
		} catch { complete = false; }
	}
	return { records, complete };
}

function aggregate(records: UsageRecord[], complete: boolean, currentTime: number, days: number, from?: number, to?: number, allTime = false): Spend {
	const cutoff = from ?? currentTime - days * DAY_MS;
	const seen = new Set<string>();
	const providers = new Map<string, { models: Map<string, { total: number; metrics: UsageTotals }>; daily: number[]; dailyTokens: number[]; metrics: UsageTotals }>();
	const daily = new Array<number>(days).fill(0);
	const dailyTokens = new Array<number>(days).fill(0);
	const metrics = metric();
	let total = 0, messages = 0;
	for (const r of records) {
		if ((!allTime && (from === undefined ? r.at <= cutoff : r.at < cutoff)) || (to !== undefined && r.at >= to) || r.at > currentTime || seen.has(r.key)) continue;
		seen.add(r.key);
		messages++;
		const costTotal = r.cost?.total ?? 0;
		total += costTotal;
		const daysAgo = Math.floor((currentTime - r.at) / DAY_MS), dayIndex = days - 1 - daysAgo;
		const p = providers.get(r.provider) ?? { models: new Map(), daily: new Array<number>(days).fill(0), dailyTokens: new Array<number>(days).fill(0), metrics: metric() };
		const m = p.models.get(r.model) ?? { total: 0, metrics: metric() };
		const addRecord = (target: UsageTotals) => {
			target.cost.total += costTotal;
			if (r.cost) {
				for (const c of ["input", "output", "cacheRead", "cacheWrite"] as const) target.cost[c] += r.cost[c] ?? 0;
				if ([r.cost.input, r.cost.output, r.cost.cacheRead, r.cost.cacheWrite].some((v) => v === undefined)) target.missingBreakdownMessages++;
			} else target.unpricedMessages++;
			if (r.tokens) {
				for (const c of ["input", "output", "cacheRead", "cacheWrite"] as const) target.tokens[c] += r.tokens[c];
				target.tokens.total += r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite;
				if (r.tokens.cacheRead > 0) {
					const savings = target.cacheSavings!;
					if (r.tokens.input > 0 && r.cost?.input !== undefined && r.cost.cacheRead !== undefined) {
						savings.estimated += Math.max(0, r.tokens.cacheRead * (r.cost.input / r.tokens.input) - r.cost.cacheRead);
						savings.coveredTokens += r.tokens.cacheRead;
					} else savings.unratedTokens += r.tokens.cacheRead;
				}
			}
		};
		addRecord(metrics); addRecord(p.metrics); addRecord(m.metrics);
		if (dayIndex >= 0 && dayIndex < days) {
			daily[dayIndex]! += costTotal;
			if (r.tokens) dailyTokens[dayIndex]! += r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite;
		}
		m.total += costTotal; p.models.set(r.model, m);
		if (dayIndex >= 0 && dayIndex < days) {
			p.daily[dayIndex]! += costTotal;
			if (r.tokens) p.dailyTokens[dayIndex]! += r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite;
		}
		providers.set(r.provider, p);
	}
	return { total, messages, days, complete, daily, dailyTokens, metrics, byProvider: [...providers].map(([provider, p]) => ({
		provider, total: [...p.models.values()].reduce((sum, m) => sum + m.total, 0), daily: p.daily, dailyTokens: p.dailyTokens, metrics: p.metrics,
		models: [...p.models].map(([model, m]) => ({ model, total: m.total, metrics: m.metrics })).sort((a, b) => b.total - a.total),
	})).sort((a, b) => b.total - a.total) };
}

/** API-equivalent cost and token usage of assistant messages in the selected interval. */
export async function readSpend({ dir, days = 30, from, to, now = Date.now }: SpendOptions): Promise<Spend> {
	const currentTime = now();
	const { records, complete } = await scan(dir);
	return aggregate(records, complete, currentTime, days, from, to);
}

/** One scan of saved sessions, summarized for all time and rolling 7/30/60-day windows. */
export async function readSpendReport({ dir, now = Date.now }: { dir: string; now?: () => number }): Promise<SpendReport> {
	const currentTime = now();
	const { records, complete } = await scan(dir);
	return {
		allTime: aggregate(records, complete, currentTime, 60, undefined, undefined, true),
		week: aggregate(records, complete, currentTime, 7),
		month: aggregate(records, complete, currentTime, 30),
		twoMonths: aggregate(records, complete, currentTime, 60),
	};
}
