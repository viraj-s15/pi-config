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

export interface Spend {
	total: number;
	messages: number;
	days: number;
	/** False when a directory or session file could not be read; zero must not imply complete accounting. */
	complete?: boolean;
	/** Cost per day, oldest first; the last entry is the most recent 24 hours. */
	daily: number[];
	byProvider: { provider: string; total: number; daily: number[]; models: { model: string; total: number }[] }[];
}

interface Charge {
	key: string;
	at: number;
	cost: number;
	provider: string;
	model: string;
}

// Parsed records per session file, reused until the file changes.
const cache = new Map<string, { mtimeMs: number; size: number; records: Charge[] }>();

function parseLine(line: string): Charge | undefined {
	if (!line.includes('"cost"')) return; // cheap skip for the vast majority of lines
	let entry: any;
	try {
		entry = JSON.parse(line);
	} catch {
		return;
	}
	const message = entry?.message;
	const cost = message?.usage?.cost?.total;
	if (message?.role !== "assistant" || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return;
	const at = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
	if (!Number.isFinite(at)) return;
	const provider = String(message.provider ?? "unknown");
	// Forked sessions copy earlier messages, so identify a message by its response, not its file.
	const key = message.responseId ? `${provider}|${message.responseId}` : `${entry.id}|${at}`;
	return { key, at, cost, provider, model: String(message.model ?? "unknown") };
}

async function recordsOf(path: string, mtimeMs: number, size: number): Promise<Charge[] | undefined> {
	const hit = cache.get(path);
	if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.records;
	let records: Charge[] = [];
	try {
		records = (await readFile(path, "utf8")).split("\n").flatMap((line) => parseLine(line) ?? []);
	} catch { return undefined; }
	cache.set(path, { mtimeMs, size, records });
	return records;
}

/** API-equivalent cost of assistant messages in the selected interval, across all saved sessions. */
export async function readSpend({ dir, days = 30, from, to, now = Date.now }: SpendOptions): Promise<Spend> {
	const currentTime = now();
	const cutoff = from ?? currentTime - days * DAY_MS;
	const upperBound = to;
	let names: string[] = [];
	let complete = true;
	try {
		names = (await readdir(dir, { recursive: true })).filter((n) => n.endsWith(".jsonl"));
	} catch { complete = false; }

	const seen = new Set<string>();
	const providers = new Map<string, { models: Map<string, number>; daily: number[] }>();
	const daily = new Array<number>(days).fill(0);
	const end = currentTime;
	let total = 0;
	let messages = 0;
	// Sorted so duplicates resolve the same way every time.
	for (const name of names.sort()) {
		const path = join(dir, name);
		let info;
		try {
			info = await stat(path);
		} catch {
			complete = false;
			continue;
		}
		if (from === undefined && info.mtimeMs < cutoff) continue; // untouched for the whole window
		const records = await recordsOf(path, info.mtimeMs, info.size);
		if (!records) { complete = false; continue; }
		for (const r of records) {
			if ((from === undefined ? r.at <= cutoff : r.at < cutoff) || (upperBound !== undefined && r.at >= upperBound) || r.at > currentTime || seen.has(r.key)) continue;
			seen.add(r.key);
			total += r.cost;
			messages++;
			const daysAgo = Math.floor((end - r.at) / DAY_MS);
			const dayIndex = days - 1 - daysAgo;
			if (dayIndex >= 0 && dayIndex < days) daily[dayIndex]! += r.cost;
			const entry = providers.get(r.provider) ?? { models: new Map<string, number>(), daily: new Array<number>(days).fill(0) };
			entry.models.set(r.model, (entry.models.get(r.model) ?? 0) + r.cost);
			if (dayIndex >= 0 && dayIndex < days) entry.daily[dayIndex]! += r.cost;
			providers.set(r.provider, entry);
		}
	}

	const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
	return {
		total,
		messages,
		days,
		complete,
		daily,
		byProvider: [...providers]
			.map(([provider, { models, daily: providerDaily }]) => ({
				provider,
				total: sum(models),
				daily: providerDaily,
				models: [...models].map(([model, t]) => ({ model, total: t })).sort((a, b) => b.total - a.total),
			}))
			.sort((a, b) => b.total - a.total),
	};
}
