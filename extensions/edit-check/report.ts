/** Which errors an edit introduced, and how to tell the agent about them. */

export interface Diagnostic {
	line: number;
	column: number;
	code: string;
	message: string;
}

const MAX = 10;
const keyOf = (d: Diagnostic) => `${d.code}\0${d.message}`;

/** Errors in `after` that were not in `before`. Line numbers are ignored, since edits move lines. */
export function newDiagnostics(before: Diagnostic[], after: Diagnostic[]): Diagnostic[] {
	const seen = new Map<string, number>();
	for (const d of before) seen.set(keyOf(d), (seen.get(keyOf(d)) ?? 0) + 1);
	const fresh: Diagnostic[] = [];
	for (const d of after) {
		const left = seen.get(keyOf(d)) ?? 0;
		if (left > 0) seen.set(keyOf(d), left - 1);
		else fresh.push(d);
	}
	return fresh;
}

export function formatReport(path: string, checker: string, diagnostics: Diagnostic[]): string {
	const lines = [`New errors in ${path} after this change (${checker}):`];
	for (const d of diagnostics.slice(0, MAX)) lines.push(`- ${d.line}:${d.column} ${d.code} ${d.message}`);
	if (diagnostics.length > MAX) lines.push(`…and ${diagnostics.length - MAX} more`);
	lines.push("Errors that were already there are not listed.");
	return lines.join("\n");
}
