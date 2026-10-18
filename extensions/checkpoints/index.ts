/**
 * Checkpoints: before and after every agent run the project's files are snapshotted (in a separate
 * git store, never the project's own repo). /rewind picks one of your prompts and puts back every file
 * the agent changed from that prompt on, then rewinds the chat to it with the prompt in the editor.
 * Files the agent did not touch, like your own edits elsewhere, are left alone.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeRewind, filesToRestore, type RunRecord } from "./plan.ts";
import { openStore, type SnapshotStore } from "./store.ts";
import { showDiff, TurnDiffComponent } from "./diff-view.ts";

const ENTRY = "checkpoint";
const BASELINE = "checkpoint-baseline";
const EMPTY_TURN = "checkpoint-empty-turn";
const BOTH = "Restore files and rewind the chat";
const FILES_ONLY = "Restore files only";

const textOf = (content: unknown) =>
	typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";

function list(files: string[], max = 4): string {
	return files.length <= max ? files.join(", ") : `${files.slice(0, max).join(", ")} +${files.length - max} more`;
}

export default function (pi: ExtensionAPI) {
	let store: Promise<SnapshotStore | undefined> | undefined;
	let pending: { before: string; at: number; entryId?: string; prompt?: string } | undefined;
	let undo: { tree: string; files: string[] } | undefined;
	const storeFor = (cwd: string) => (store ??= openStore(cwd).catch(() => undefined));

	const runsOf = (ctx: ExtensionContext): RunRecord[] =>
		ctx.sessionManager.getBranch().flatMap((entry: any) => (entry.type === "custom" && entry.customType === ENTRY && entry.data ? [entry.data as RunRecord] : []));

	// Custom entries are rendered in the transcript but never sent to the model.
	pi.registerEntryRenderer<RunRecord>(ENTRY, (entry, options, theme) =>
		entry.data?.diff ? new TurnDiffComponent(entry.data.diff, theme, options.expanded) : undefined);

	const baselineOf = (ctx: ExtensionContext): string | undefined => {
		const entries = ctx.sessionManager.getBranch();
		const baseline = entries.find((entry: any) => entry.type === "custom" && entry.customType === BASELINE) as any;
		return baseline?.data?.tree ?? runsOf(ctx)[0]?.before;
	};

	pi.on("session_start", async (_event, ctx) => {
		store = undefined;
		pending = undefined;
		undo = undefined;
		try {
			const s = await storeFor(ctx.cwd);
			if (s && !baselineOf(ctx)) pi.appendEntry(BASELINE, { tree: await s.snapshot() });
		} catch {
			// Retry a missing baseline before the first run; never block the session.
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (pending) return; // a follow-up in the same run
		const s = await storeFor(ctx.cwd);
		if (!s) return;
		try {
			const prompt = [...ctx.sessionManager.getBranch()].reverse().find((entry: any) => entry.type === "message" && entry.message?.role === "user") as any;
			const at = Date.now();
			const before = await s.snapshot();
			if (!baselineOf(ctx)) pi.appendEntry(BASELINE, { tree: before });
			pending = { before, at, entryId: prompt?.id, prompt: prompt ? textOf(prompt.message.content) : undefined };
		} catch {
			pending = undefined;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const run = pending;
		pending = undefined;
		if (!run) return;
		const s = await storeFor(ctx.cwd);
		if (!s) return;
		try {
			const after = await s.snapshot();
			const files = await s.changed(run.before, after);
			if (!files.length) {
				pi.appendEntry(EMPTY_TURN, { before: run.before, after, files: [], at: run.at });
				return;
			}
			// The user message normally precedes before_agent_start. Capture its ID there,
			// rather than relying on millisecond timestamps after an expensive snapshot.
			const prompt = [...ctx.sessionManager.getBranch()].reverse().find((entry: any) => entry.type === "message" && entry.message?.role === "user") as any;
			const entryId = run.entryId ?? prompt?.id;
			if (!entryId) return;
			// Preserve rewind even when generating a display patch fails.
			const diff = await s.diff(run.before, after).catch(() => undefined);
			pi.appendEntry<RunRecord>(ENTRY, { entryId, prompt: run.prompt ?? textOf(prompt.message.content), before: run.before, after, files, at: run.at, diff });
		} catch {
			// A failed snapshot only means this run cannot be rewound.
		}
	});

	pi.registerCommand("diff", {
		description: "View net session changes, or /diff last for the latest turn (read-only)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (!ctx.isIdle()) return ctx.ui.notify("Wait for the agent to finish first.", "warning");
			const mode = args.trim().toLowerCase();
			if (mode && mode !== "last") return ctx.ui.notify("Usage: /diff or /diff last", "info");
			const s = await storeFor(ctx.cwd);
			if (!s) return ctx.ui.notify("Diffs need a Git repository.", "warning");
			const runs = runsOf(ctx);
			const lastEntry = [...ctx.sessionManager.getBranch()].reverse().find((entry: any) => entry.type === "custom" && (entry.customType === ENTRY || entry.customType === EMPTY_TURN)) as any;
			const last = lastEntry?.data as RunRecord | undefined;
			if (!last) return ctx.ui.notify("No recorded turns yet. Diffs start with the first turn after checkpoints is loaded.", "info");
			try {
				const from = mode === "last" ? last.before : baselineOf(ctx);
				if (!from) return ctx.ui.notify("No session baseline is available.", "warning");
				// Limit session diffs to paths changed during recorded turns. Unrelated
				// edits between turns are not shown as agent work. Overlapping edits
				// cannot be attributed: this is a filesystem diff, not authorship proof.
				const report = mode === "last"
					? await s.diff(from, last.after)
					: await s.diff(from, await s.snapshot(), [...new Set(runs.flatMap((run) => run.files))]);
				await showDiff(ctx, report, mode === "last" ? "Last turn · read-only" : "Session net changes · recorded paths · read-only");
			} catch {
				ctx.ui.notify("Could not read these diff snapshots. They may no longer be available.", "warning");
			}
		},
	});

	pi.registerCommand("rewind", {
		description: "Put back the files the agent changed since one of your prompts, and rewind the chat",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (!ctx.isIdle()) return ctx.ui.notify("Wait for the agent to finish first.", "warning");
			const s = await storeFor(ctx.cwd);
			if (!s) return ctx.ui.notify("Rewind needs the project to be in a git repository.", "warning");
			const runs = runsOf(ctx);
			const choices = describeRewind(runs);
			const UNDO = undo ? `↶ Undo the last rewind (${undo.files.length} file${undo.files.length === 1 ? "" : "s"})` : undefined;
			if (!choices.length && !UNDO) return ctx.ui.notify("Nothing to rewind yet. Runs are recorded from the first prompt after Pi loaded checkpoints, and none since then has changed files.", "info");

			const picked = await ctx.ui.select("Rewind to before which prompt?", [...(UNDO ? [UNDO] : []), ...choices.map((c) => c.label)]);
			if (!picked) return;
			if (picked === UNDO && undo) {
				const { tree, files } = undo;
				await s.restore(tree, files);
				undo = undefined;
				return ctx.ui.notify(`Put back ${files.length} file${files.length === 1 ? "" : "s"} as they were before the rewind.`, "info");
			}
			const target = choices.find((c) => c.label === picked);
			const plan = target && filesToRestore(runs, target.entryId);
			if (!target || !plan) return;

			// Warn when you edited one of these files yourself after the agent's last change to it.
			const now = await s.snapshot();
			const touched = new Set(await s.changed(runs[runs.length - 1]!.after, now));
			const yours = plan.files.filter((file) => touched.has(file));
			const warning = yours.length ? `  Your later edits to ${list(yours, 3)} will be lost.` : "";
			const how = await ctx.ui.select(`Restore ${plan.files.length} file${plan.files.length === 1 ? "" : "s"}: ${list(plan.files)}.${warning}`, [BOTH, FILES_ONLY, "Cancel"]);
			if (how !== BOTH && how !== FILES_ONLY) return;

			await s.restore(plan.tree, plan.files);
			undo = { tree: now, files: plan.files };
			if (how === BOTH) await ctx.navigateTree(target.entryId);
			ctx.ui.notify(`Restored ${plan.files.length} file${plan.files.length === 1 ? "" : "s"}. /rewind can undo this.`, "info");
		},
	});
}
