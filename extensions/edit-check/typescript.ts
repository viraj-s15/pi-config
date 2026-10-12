import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Diagnostic } from "./report.ts";

export interface TsProject {
	/** Folder holding tsconfig.json; tsc runs here. */
	dir: string;
	tsc: string;
}

const LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/** tsc --pretty false output, grouped by absolute file path. */
export function parseTscOutput(out: string, dir: string): Map<string, Diagnostic[]> {
	const byFile = new Map<string, Diagnostic[]>();
	let last: Diagnostic | undefined;
	for (const line of out.split(/\r?\n/)) {
		const match = LINE.exec(line);
		if (match) {
			const file = resolve(dir, match[1]!);
			last = { line: Number(match[2]), column: Number(match[3]), code: match[4]!, message: match[5]!.trim() };
			byFile.set(file, [...(byFile.get(file) ?? []), last]);
		} else if (last && /^\s+\S/.test(line)) {
			last.message += ` ${line.trim()}`;
		} else {
			last = undefined;
		}
	}
	return byFile;
}

/** The nearest tsconfig.json above a .ts file, with the project's own tsc. */
export function findTsProject(file: string): TsProject | undefined {
	if (!/\.(c|m)?tsx?$/.test(file) || file.endsWith(".d.ts")) return undefined;
	for (let dir = dirname(file); ; dir = dirname(dir)) {
		if (existsSync(join(dir, "tsconfig.json"))) {
			for (let up = dir; ; up = dirname(up)) {
				const tsc = join(up, "node_modules", ".bin", "tsc");
				if (existsSync(tsc)) return { dir, tsc };
				if (dirname(up) === up) return undefined;
			}
		}
		if (dirname(dir) === dir) return undefined;
	}
}

/** Type-check the whole project (incrementally, so repeat runs are quick). */
export function runTsc(project: TsProject, timeoutMs = 60_000): Promise<Map<string, Diagnostic[]> | undefined> {
	const cache = join(tmpdir(), "pi-edit-check");
	mkdirSync(cache, { recursive: true });
	const buildInfo = join(cache, `${createHash("sha1").update(project.dir).digest("hex").slice(0, 16)}.tsbuildinfo`);
	return new Promise((done) => {
		execFile(project.tsc, ["--noEmit", "--pretty", "false", "--incremental", "--tsBuildInfoFile", buildInfo], { cwd: project.dir, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
			if (error && (error as any).killed) return done(undefined); // timed out: no answer rather than a wrong one
			done(parseTscOutput(stdout, project.dir));
		});
	});
}
