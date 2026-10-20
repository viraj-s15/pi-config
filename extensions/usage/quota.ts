export interface Win {
	label: string;
	used: number;
	resetsAt?: number;
	note?: string;
	durationSeconds?: number;
}

const num = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined;
const clampPct = (n: number) => Math.max(0, Math.min(100, n));
const iso = (v: unknown): number | undefined => {
	if (typeof v !== "string") return undefined;
	const t = Date.parse(v);
	return Number.isFinite(t) ? t : undefined;
};
const ensureWins = (wins: Win[]): Win[] => {
	if (!wins.length) throw new Error("no quota windows returned");
	return wins;
};

export function parseAnthropicUsage(d: any): { wins: Win[] } {
	const wins: Win[] = [];
	const known: [string, string][] = [
		["five_hour", "5h"],
		["seven_day", "7d"],
		["seven_day_opus", "7d Opus"],
		["seven_day_sonnet", "7d Sonnet"],
	];
	for (const [key, label] of known) {
		const w = d?.[key];
		const used = num(w?.utilization);
		if (used !== undefined) wins.push({
			label,
			used: clampPct(used),
			resetsAt: iso(w.resets_at),
			durationSeconds: key === "five_hour" ? 5 * 3600 : 7 * 86400,
		});
	}
	for (const [key, w] of Object.entries<any>(d ?? {})) {
		if (known.some(([k]) => k === key) || !w || typeof w !== "object") continue;
		const limit = num(w.limit_dollars);
		const usedDollars = num(w.used_dollars);
		if (limit && usedDollars !== undefined) wins.push({
			label: "Spend cap",
			used: clampPct(num(w.utilization) ?? (usedDollars / limit) * 100),
			resetsAt: iso(w.resets_at),
			note: `$${usedDollars.toFixed(2)} / $${limit.toFixed(0)}`,
		});
	}
	return { wins: ensureWins(wins) };
}

function windowLabel(seconds: number | undefined, fallback: string): string {
	if (!seconds || seconds <= 0) return fallback;
	if (seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	return fallback;
}

export function parseCodexUsage(d: any, now = Date.now()): { plan?: string; wins: Win[]; extra: string[] } {
	const rl = d?.rate_limit ?? {};
	const wins: Win[] = [];
	for (const [w, fallback] of [[rl.primary_window, "5h"], [rl.secondary_window, "7d"]] as const) {
		const used = num(w?.used_percent);
		if (used === undefined) continue;
		const rawDuration = num(w.limit_window_seconds);
		const durationSeconds = rawDuration !== undefined && rawDuration > 0 ? rawDuration : undefined;
		const at = num(w.reset_at);
		const after = num(w.reset_after_seconds);
		const resetsAt = at !== undefined && at > 0 ? at * 1000
			: after !== undefined && after >= 0 ? now + after * 1000 : undefined;
		wins.push({ label: windowLabel(durationSeconds, fallback), used: clampPct(used), resetsAt, durationSeconds });
	}
	const extra: string[] = [];
	const bal = d?.credits?.balance;
	if (d?.credits?.has_credits && bal !== undefined) extra.push(`credits balance: ${bal}`);
	return {
		plan: typeof d?.plan_type === "string" ? d.plan_type : undefined,
		wins: ensureWins(wins),
		extra,
	};
}

export function parseAntigravityUsage(body: any): { wins: Win[] } {
	const wins: Win[] = [];
	for (const g of body?.command?.data?.groups ?? []) {
		const words = String(g.name ?? "").split(/\s+/).filter(Boolean);
		if (words.at(-1)?.toLowerCase() === "models") words.pop();
		const group = words.join(" ").replace(" and ", "/");
		for (const b of g.buckets ?? []) {
			const remaining = num(b.remaining_fraction);
			if (remaining === undefined) continue;
			const weekly = b.window === "weekly";
			wins.push({
				label: `${group} ${weekly ? "7d" : (b.window ?? "")}`.trim(),
				used: clampPct((1 - remaining) * 100),
				resetsAt: iso(b.reset_time),
				...(weekly ? { durationSeconds: 7 * 86400 } : {}),
			});
		}
	}
	return { wins: ensureWins(wins) };
}
