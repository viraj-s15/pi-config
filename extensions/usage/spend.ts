import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const DAY_MS = 86_400_000;

export interface SpendOptions {
	dir: string;
	days?: number;
	now?: () => number;
}

export interface Spend {
	total: number;
	messages: number;
	days: number;
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

async function recordsOf(path: string, mtimeMs: number, size: number): Promise<Charge[]> {
	const hit = cache.get(path);
	if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.records;
	let records: Charge[] = [];
	try {
		records = (await readFile(path, "utf8")).split("\n").flatMap((line) => parseLine(line) ?? []);
	} catch {}
	cache.set(path, { mtimeMs, size, records });
	return records;
}

/** API-equivalent cost of every assistant message in the last `days` days, across all saved sessions. */
export async function readSpend({ dir, days = 30, now = Date.now }: SpendOptions): Promise<Spend> {
	const cutoff = now() - days * DAY_MS;
	let names: string[] = [];
	try {
		names = (await readdir(dir, { recursive: true })).filter((n) => n.endsWith(".jsonl"));
	} catch {}

	const seen = new Set<string>();
	const providers = new Map<string, { models: Map<string, number>; daily: number[] }>();
	const daily = new Array<number>(days).fill(0);
	const end = now();
	let total = 0;
	let messages = 0;
	// Sorted so duplicates resolve the same way every time.
	for (const name of names.sort()) {
		const path = join(dir, name);
		let info;
		try {
			info = await stat(path);
		} catch {
			continue;
		}
		if (info.mtimeMs < cutoff) continue; // untouched for the whole window
		for (const r of await recordsOf(path, info.mtimeMs, info.size)) {
			if (r.at <= cutoff || seen.has(r.key)) continue;
			seen.add(r.key);
			total += r.cost;
			messages++;
			const daysAgo = Math.max(0, Math.floor((end - r.at) / DAY_MS));
			daily[days - 1 - daysAgo]! += r.cost;
			const entry = providers.get(r.provider) ?? { models: new Map<string, number>(), daily: new Array<number>(days).fill(0) };
			entry.models.set(r.model, (entry.models.get(r.model) ?? 0) + r.cost);
			entry.daily[days - 1 - daysAgo]! += r.cost;
			providers.set(r.provider, entry);
		}
	}

	const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
	return {
		total,
		messages,
		days,
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
