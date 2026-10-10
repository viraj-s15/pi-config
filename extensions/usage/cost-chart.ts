export type RGB = [number, number, number];

const RESET = "\x1b[0m";
const fg = ([r, g, b]: RGB, s: string) => `\x1b[38;2;${r};${g};${b}m${s}${RESET}`;
const fgbg = (f: RGB, b: RGB, s: string) => `\x1b[38;2;${f[0]};${f[1]};${f[2]}m\x1b[48;2;${b[0]};${b[1]};${b[2]}m${s}${RESET}`;

/** Block glyphs that fill the bottom 1..8 eighths of a cell. */
const BLOCKS = "▁▂▃▄▅▆▇█";

// ---------- stacked bar (the terminal-friendly pie) ----------

/** One horizontal bar split in proportion to each value. Widths add up to `width`; a real value never rounds to nothing. */
export function stackedBar(parts: { value: number; color: RGB }[], width: number, track: RGB): string {
	const live = parts.filter((p) => p.value > 0);
	const total = live.reduce((a, p) => a + p.value, 0);
	if (total <= 0 || width <= 0) return fg(track, "█".repeat(Math.max(0, width)));

	// Largest-remainder allocation, with at least one cell for every nonzero part.
	const raw = live.map((p) => (p.value / total) * width);
	const cells = raw.map((r) => Math.max(1, Math.floor(r)));
	let diff = width - cells.reduce((a, c) => a + c, 0);
	const byRemainder = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((a, b) => b.rem - a.rem);
	for (let k = 0; diff > 0; k++, diff--) cells[byRemainder[k % byRemainder.length]!.i]!++;
	for (let k = 0; diff < 0; k++) {
		const biggest = cells.indexOf(Math.max(...cells));
		if (cells[biggest]! > 1) {
			cells[biggest]!--;
			diff++;
		} else if (k > width) break;
	}
	return live.map((p, i) => fg(p.color, "█".repeat(cells[i]!))).join("");
}

// ---------- stacked column chart ----------

export interface Series {
	color: RGB;
	daily: number[];
}
export interface ColumnChartOptions {
	height: number; // rows
	colWidth: 1 | 2; // 2 = a glyph followed by a gap
	width: number; // max visible columns' width
	track: RGB;
}

/** Stacked daily columns, oldest first. Series[0] is the bottom of each stack. Heights use eighth-blocks, so a 4-row chart has 32 levels. */
export function columnChart(series: Series[], o: ColumnChartOptions): { rows: string[]; peak: number; shown: number } {
	const days = series[0]?.daily.length ?? 0;
	const shown = Math.max(0, Math.min(days, Math.floor(o.width / o.colWidth)));
	const first = days - shown;
	const totals = Array.from({ length: shown }, (_, d) => series.reduce((a, s) => a + (s.daily[first + d] ?? 0), 0));
	const peak = Math.max(0, ...totals);
	const levels = o.height * 8;
	const gap = o.colWidth === 2 ? " " : "";

	// Per day: the stack as segments of whole eighths, bottom first.
	const stacks = Array.from({ length: shown }, (_, d) => {
		const segs: { color: RGB; size: number }[] = [];
		if (peak > 0) {
			for (const s of series) {
				const v = s.daily[first + d] ?? 0;
				if (v > 0) segs.push({ color: s.color, size: Math.max(1, Math.round((v / peak) * levels)) });
			}
		}
		let over = segs.reduce((a, s) => a + s.size, 0) - levels;
		while (over > 0) {
			const big = segs.reduce((m, s) => (s.size > m.size ? s : m), segs[0]!);
			big.size--;
			over--;
		}
		return segs;
	});

	const rows: string[] = [];
	for (let r = o.height - 1; r >= 0; r--) {
		const lo = r * 8;
		let line = "";
		for (const segs of stacks) {
			const height = segs.reduce((a, s) => a + s.size, 0);
			if (height === 0) {
				line += (r === 0 ? fg(o.track, "▁") : " ") + gap;
				continue;
			}
			const hi = Math.min(height, lo + 8);
			if (hi <= lo) {
				line += " " + gap;
				continue;
			}
			// Which segments occupy this cell, and how many eighths each?
			const inCell: { color: RGB; n: number }[] = [];
			let at = 0;
			for (const s of segs) {
				const n = Math.min(at + s.size, hi) - Math.max(at, lo);
				if (n > 0) inCell.push({ color: s.color, n });
				at += s.size;
			}
			const filled = hi - lo;
			const bottom = inCell[0]!;
			const top = inCell[inCell.length - 1]!;
			if (inCell.length === 1) {
				line += fg(bottom.color, filled === 8 ? "█" : BLOCKS[filled - 1]!) + gap;
			} else if (filled === 8) {
				// Two colours in one full cell: the glyph is the lower part, the background the upper.
				line += fgbg(bottom.color, top.color, BLOCKS[bottom.n - 1]!) + gap;
			} else {
				const dominant = inCell.reduce((m, c) => (c.n > m.n ? c : m), inCell[0]!);
				line += fg(dominant.color, BLOCKS[filled - 1]!) + gap;
			}
		}
		rows.push(line);
	}
	return { rows, peak, shown };
}

// ---------- providers, plans and value multiples ----------

export interface CostRow {
	provider: string;
	total: number;
	plan?: number; // monthly plan price in USD
	multiple?: number; // API-equivalent spend / plan price, rounded to 0.1
}

/** Biggest spender first. Every provider with a configured plan is included, even if it spent nothing. */
export function costRows(spend: { provider: string; total: number }[], plans: { [provider: string]: number }): CostRow[] {
	const rows: CostRow[] = spend.map((s) => ({ provider: s.provider, total: s.total }));
	for (const provider of Object.keys(plans)) {
		if (!rows.some((r) => r.provider === provider)) rows.push({ provider, total: 0 });
	}
	for (const r of rows) {
		const plan = plans[r.provider];
		if (plan && plan > 0) {
			r.plan = plan;
			r.multiple = Math.round((r.total / plan) * 10) / 10;
		}
	}
	return rows.sort((a, b) => b.total - a.total);
}
