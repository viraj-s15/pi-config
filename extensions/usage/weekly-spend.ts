import { readSpend, type Spend, type SpendOptions } from "./spend.ts";

export const WEEK_SECONDS = 7 * 24 * 60 * 60;
const WEEK_MS = WEEK_SECONDS * 1000;

export interface QuotaWindow {
	label: string;
	used: number;
	resetsAt?: number;
	durationSeconds?: number;
}
export interface WeeklySpendRange { from: number; to: number }
export type WeeklyCost =
	| { status: "loading" }
	| { status: "unavailable"; reason: string }
	| { status: "ready"; total: number; from: number; to: number; asOf: number };

/** Use the actual reset boundary, never the calendar week or a model-specific cap in place of an overall cap. */
export function weeklySpendRange(
	windowsByProvider: Record<string, readonly QuotaWindow[]>,
	providerIds: readonly string[],
	now: number,
): WeeklySpendRange | undefined {
	for (const provider of providerIds) {
		const weekly = (windowsByProvider[provider] ?? []).filter(w => w.durationSeconds === WEEK_SECONDS);
		const general = weekly.filter(w => /^(?:7d|7\s*day|weekly)$/i.test(w.label.trim()));
		// Anthropic's model-only caps cannot stand in for a missing overall window.
		if (!general.length && weekly.some(w => /^7d\s+/i.test(w.label.trim()))) continue;
		// Separate model groups are usable only if they share the same, known reset.
		const candidates = general.length ? general : weekly;
		if (!candidates.length || candidates.some(w => typeof w.resetsAt !== "number" || !Number.isFinite(w.resetsAt)
			|| w.resetsAt <= now || w.resetsAt > now + WEEK_MS)) continue;
		const resets = new Set(candidates.map(w => w.resetsAt!));
		if (resets.size !== 1) continue;
		const reset = candidates[0]!.resetsAt!;
		return { from: reset - WEEK_MS, to: reset };
	}
	return undefined;
}

/** Sum explicit saved-session provider IDs. This does not claim account-level or cross-client attribution. */
export function sumProviderSpend(spend: Spend, providerIds: readonly string[]): number {
	const aliases = new Set(providerIds.map(canonicalProvider));
	return spend.byProvider.reduce((total, entry) => aliases.has(canonicalProvider(entry.provider)) ? total + entry.total : total, 0);
}

function canonicalProvider(provider: string): string {
	return provider === "openai-codex" ? "openai" : provider;
}

/** Read the exact reset-aligned interval; callers cannot accidentally pass a 30-day total as weekly spend. */
export async function readWeeklyCost(
	windows: readonly QuotaWindow[], providerIds: readonly string[], dir: string, now: number,
	reader: (options: SpendOptions) => Promise<Spend> = readSpend,
): Promise<WeeklyCost> {
	const range = weeklySpendRange({ subscription: windows }, ["subscription"], now);
	if (!range || !providerIds.length) {
		const weekly = windows.filter(w => w.durationSeconds === WEEK_SECONDS);
		const multipleResets = new Set(weekly.map(w => w.resetsAt)).size > 1;
		return { status: "unavailable", reason: multipleResets ? "model groups reset separately" : "weekly reset unavailable" };
	}
	try {
		const spend = await reader({ dir, days: 7, from: range.from, to: range.to, now: () => now });
		if (spend.complete === false) return { status: "unavailable", reason: "session history could not be fully read" };
		return { status: "ready", total: sumProviderSpend(spend, providerIds), ...range, asOf: now };
	} catch {
		return { status: "unavailable", reason: "session history could not be read" };
	}
}
