/**
 * Errors after edits: when the agent edits or writes a file, check that file and, if the change
 * introduced errors, add them to the tool result so the agent sees them and fixes them in the same
 * turn. Only new errors are listed; ones that were already there are left out.
 *
 * Checkers: TypeScript (the project's own tsc, whole project, incremental), Python (ruff, if the
 * project or PATH has it) and JSON (parse). Files with no checker are left alone. Toggle: /checks.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkJson } from "./json.ts";
import { formatReport, newDiagnostics, type Diagnostic } from "./report.ts";
import { findRuff, runRuff } from "./ruff.ts";
import { findTsProject, runTsc, type TsProject } from "./typescript.ts";

type Results = Map<string, Diagnostic[]>;

interface Pending {
	file: string;
	checker: string;
	before: Promise<Diagnostic[] | undefined>;
	after: () => Promise<Diagnostic[] | undefined>;
}

const readOr = (file: string, fallback = "") => {
	try {
		return existsSync(file) ? readFileSync(file, "utf8") : fallback;
	} catch {
		return fallback;
	}
};

export default function (pi: ExtensionAPI) {
	let enabled = true;
	/** Latest whole-project tsc results, per tsconfig folder. Reset each run so they are fresh. */
	const tsLatest = new Map<string, Promise<Results | undefined>>();
	/** One tsc at a time per project (they share an incremental build file). */
	const tsQueue = new Map<string, Promise<unknown>>();
	const pending = new Map<string, Pending>();

	const queued = (project: TsProject) => {
		const next = (tsQueue.get(project.dir) ?? Promise.resolve()).then(() => runTsc(project));
		tsQueue.set(project.dir, next.catch(() => undefined));
		return next;
	};
	const latest = (project: TsProject) => {
		if (!tsLatest.has(project.dir)) tsLatest.set(project.dir, queued(project));
		return tsLatest.get(project.dir)!;
	};

	pi.on("before_agent_start", (_event, ctx) => {
		tsLatest.clear();
		pending.clear();
		if (!enabled) return;
		// Start the baseline early, so the first edit rarely waits for it.
		const project = findTsProject(join(ctx.cwd, "index.ts"));
		if (project) void latest(project);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const raw = (event.input as { path?: unknown }).path;
		if (typeof raw !== "string" || !raw) return;
		const file = resolve(ctx.cwd, raw.replace(/^~(?=$|\/)/, homedir()));
		const old = readOr(file);

		const project = findTsProject(file);
		if (project) {
			// The baseline must be read before the edit lands, so wait for it here.
			const before = await latest(project);
			pending.set(event.toolCallId, {
				file,
				checker: "TypeScript",
				before: Promise.resolve(before?.get(file) ?? (before ? [] : undefined)),
				after: async () => {
					const results = queued(project);
					tsLatest.set(project.dir, results);
					return (await results)?.get(file) ?? ((await results) ? [] : undefined);
				},
			});
			return;
		}
		if (/\.pyi?$/.test(file)) {
			const ruff = findRuff(file);
			if (ruff) pending.set(event.toolCallId, { file, checker: "ruff", before: runRuff(ruff, file, old), after: () => runRuff(ruff, file, readOr(file)) });
			return;
		}
		if (checkJson(file, "{}") !== undefined) {
			pending.set(event.toolCallId, { file, checker: "JSON", before: Promise.resolve(existsSync(file) ? checkJson(file, old) : []), after: async () => checkJson(file, readOr(file)) });
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const check = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (!check || event.isError) return;
		try {
			const [before, after] = await Promise.all([check.before, check.after()]);
			if (!before || !after) return;
			const fresh = newDiagnostics(before, after);
			if (!fresh.length) return;
			const shown = relative(ctx.cwd, check.file) || check.file;
			return { content: [...event.content, { type: "text" as const, text: `\n\n${formatReport(shown.startsWith("..") ? check.file : shown, check.checker, fresh)}` }] };
		} catch {
			return undefined; // a checker failing never gets in the way of the edit
		}
	});

	pi.registerCommand("checks", {
		description: "Check files after the agent edits them and report new errors: on | off",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
			ctx.ui.notify(`Checks after edits ${enabled ? "on" : "off"}`, "info");
		},
	});
}
