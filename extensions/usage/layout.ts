import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** ANSI- and wide-character-safe fixed columns. Amounts retain their own right-hand lane. */
export function fit(text: string, width: number, right = false): string {
	width = Math.max(0, width);
	const value = truncateToWidth(text, width);
	const space = " ".repeat(Math.max(0, width - visibleWidth(value)));
	return right ? space + value : value + space;
}

export function pair(left: string, right: string, width: number, gap = 2): string {
	width = Math.max(0, width);
	if (!right) return fit(left, width);
	const rightWidth = Math.min(width, visibleWidth(right));
	const leftWidth = Math.max(0, width - rightWidth - gap);
	return fit(left, leftWidth) + " ".repeat(Math.min(gap, width - rightWidth)) + fit(right, rightWidth, true);
}

export function usageColumns(inner: number, labels: string[]) {
	const width = Math.max(0, inner - 4); // two spaces of inset on each side
	// Limits owns the full content width; monetary analytics live on the Spend tab.
	const split = false;
	const valueWidth = 0;
	const quotaWidth = width;
	const resetWidth = 13;
	const labelWidth = Math.max(0, Math.min(18, Math.max(14, ...labels.map(s => visibleWidth(s) + 2)), quotaWidth - resetWidth - 10));
	const barWidth = Math.max(0, quotaWidth - labelWidth - resetWidth - 8);
	const resetGap = Math.max(2, quotaWidth - labelWidth - barWidth - 6 - resetWidth);
	return { width, split, valueWidth, quotaWidth, resetWidth, labelWidth, barWidth, resetGap };
}

/** Keep the window suffix visible if an unusually long model-group name needs truncation. */
export function windowLabel(label: string, width: number): string {
	const suffix = /^(.*)(\s+\d+[hd])$/.exec(label);
	if (visibleWidth(label) > width && suffix && visibleWidth(suffix[2]!) < width) {
		return fit(suffix[1]!, width - visibleWidth(suffix[2]!)) + suffix[2];
	}
	return fit(label, width);
}
