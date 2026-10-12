/** What a rewind restores, worked out from the recorded runs. */

export interface RunRecord {
	/** The user message that started the run. */
	entryId: string;
	/** First line of that message, for the picker. */
	prompt: string;
	/** Snapshots before and after the run. */
	before: string;
	after: string;
	/** Files the run changed. */
	files: string[];
	/** When the run started (ms). */
	at: number;
}

/**
 * Rewinding to a prompt undoes that run and every later one: each file any of them changed goes back
 * to how it was before that prompt. Files no run changed (your own edits) are left alone.
 */
export function filesToRestore(runs: RunRecord[], entryId: string): { tree: string; files: string[] } | undefined {
	const index = runs.findIndex((run) => run.entryId === entryId);
	if (index < 0) return undefined;
	const files = new Set<string>();
	for (const run of runs.slice(index)) for (const file of run.files) files.add(file);
	return { tree: runs[index]!.before, files: [...files].sort() };
}

function ago(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function describeRewind(runs: RunRecord[], now = Date.now()): Array<{ entryId: string; label: string }> {
	return runs
		.map((run) => {
			const files = filesToRestore(runs, run.entryId)!.files.length;
			let prompt = run.prompt.split("\n")[0]!.trim();
			if (prompt.length > 50) prompt = `${prompt.slice(0, 49)}…`;
			return { entryId: run.entryId, label: `${ago(now - run.at)} · ${prompt} · ${files} file${files === 1 ? "" : "s"}` };
		})
		.reverse();
}
