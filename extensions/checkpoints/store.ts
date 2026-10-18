/**
 * File snapshots kept in a separate git object store under ~/.pi/agent/checkpoints, so the
 * project's own repo, index and stash are never touched. Snapshots follow the project's .gitignore.
 */

import { execFile, spawn } from "node:child_process";
import type { DiffReport } from "./diff-view.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SnapshotStore {
	/** The repository's top folder; snapshots cover all of it. */
	root: string;
	/** Record the current files and return the snapshot's id. */
	snapshot(): Promise<string>;
	/** Paths (relative to root) that differ between two snapshots. */
	changed(from: string, to: string): Promise<string[]>;
	/** Read a bounded, read-only unified diff, optionally restricted to literal paths. */
	diff(from: string, to: string, paths?: string[]): Promise<DiffReport>;
	/** Put these paths back as they were in a snapshot; paths missing from it are deleted. */
	restore(snapshot: string, paths: string[]): Promise<void>;
}

const CHUNK = 200;
const PATCH_LIMIT = 128 * 1024;
const REPORT_LIMIT = 1024 * 1024;

/** Drain oversized output without keeping it in memory or interrupting Git mid-command. */
function boundedGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, limit: number): Promise<{ text: string; truncated: boolean }> {
	return new Promise((resolve, reject) => {
		const proc = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let size = 0;
		let truncated = false;
		let error = "";
		proc.stdout.on("data", (chunk: Buffer) => {
			const take = Math.min(chunk.length, Math.max(0, limit - size));
			if (take) chunks.push(chunk.subarray(0, take));
			size += take;
			if (take < chunk.length) truncated = true;
		});
		proc.stderr.on("data", (chunk: Buffer) => { if (error.length < 4096) error += chunk.toString().slice(0, 4096 - error.length); });
		proc.on("error", reject);
		proc.on("close", (code) => code === 0 ? resolve({ text: Buffer.concat(chunks).toString("utf8"), truncated }) : reject(new Error(error.trim() || `git exited ${code}`)));
	});
}

function git(args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<string> {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd: options.cwd, env: { ...env, GIT_LITERAL_PATHSPECS: "1", ...options.env }, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(stderr.trim() || error.message));
			else resolve(stdout);
		});
	});
}

export const defaultStoreDir = () => join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "checkpoints");

/** A store for the git repository containing `cwd`, or undefined when `cwd` is not in one. */
export async function openStore(cwd: string, storesDir = defaultStoreDir()): Promise<SnapshotStore | undefined> {
	let root: string;
	try {
		root = (await git(["rev-parse", "--show-toplevel"], { cwd })).trim();
	} catch {
		return undefined;
	}
	if (!root) return undefined;
	const dir = join(storesDir, `${createHash("sha1").update(root).digest("hex").slice(0, 16)}.git`);
	if (!existsSync(join(dir, "HEAD"))) {
		mkdirSync(storesDir, { recursive: true });
		// Publish a completely initialized store atomically. Concurrent sessions
		// may each initialize a candidate, but only one becomes the shared store.
		const candidate = mkdtempSync(join(storesDir, ".init-"));
		try {
			await git(["init", "--bare", "-q", candidate], { cwd: root });
			await git(["config", "gc.auto", "0"], { cwd: root, env: { GIT_DIR: candidate } });
			try { renameSync(candidate, dir); }
			catch (error) { if (!existsSync(join(dir, "HEAD"))) throw error; }
		} finally { rmSync(candidate, { recursive: true, force: true }); }
	}
	const env = { GIT_DIR: dir, GIT_WORK_TREE: root, GIT_INDEX_FILE: join(dir, "index") };
	const run = (args: string[]) => git(args, { cwd: root, env });
	const chunks = (paths: string[]) => Array.from({ length: Math.ceil(paths.length / CHUNK) }, (_, i) => paths.slice(i * CHUNK, (i + 1) * CHUNK));

	return {
		root,
		async snapshot() {
			// Each transaction gets its own index, even across Pi processes. Sharing
			// an index allows another add between our add and write-tree.
			const temp = mkdtempSync(join(dir, "snapshot-"));
			const snapshotEnv = { ...env, GIT_INDEX_FILE: join(temp, "index") };
			try {
				await git(["add", "-A", "--", "."], { cwd: root, env: snapshotEnv });
				return (await git(["write-tree"], { cwd: root, env: snapshotEnv })).trim();
			} finally {
				rmSync(temp, { recursive: true, force: true });
			}
		},
		async changed(from, to) {
			if (from === to) return [];
			const out = await run(["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to]);
			return out.split("\0").filter(Boolean);
		},
		async diff(from, to, paths) {
			if (from === to || paths?.length === 0) return { files: [] };
			// Numstat's NUL format preserves tabs, newlines and Unicode in filenames.
			const stats = await run(["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", from, to, "--"]);
			const scope = paths ? new Set(paths) : undefined;
			const files: DiffReport["files"] = [];
			for (const entry of stats.split("\0").filter(Boolean)) {
				const first = entry.indexOf("\t");
				const second = entry.indexOf("\t", first + 1);
				if (first < 0 || second < 0) continue;
				const path = entry.slice(second + 1);
				if (scope && !scope.has(path)) continue;
				const added = entry.slice(0, first), removed = entry.slice(first + 1, second);
				files.push({ path, added: Number(added) || 0, removed: Number(removed) || 0, binary: added === "-" || removed === "-", patch: "" });
			}
			const cleanEnv: NodeJS.ProcessEnv = {};
			for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) cleanEnv[key] = value;
			let remaining = REPORT_LIMIT;
			for (const file of files) {
				if (file.binary) continue;
				if (remaining <= 0) { file.truncated = true; continue; }
				const patch = await boundedGit(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", from, to, "--", file.path], root, { ...cleanEnv, ...env, GIT_LITERAL_PATHSPECS: "1" }, Math.min(PATCH_LIMIT, remaining));
				file.patch = patch.text;
				file.truncated = patch.truncated || undefined;
				remaining -= Buffer.byteLength(patch.text);
			}
			return { files, truncated: files.some((file) => file.truncated) || undefined };
		},
		async restore(snapshot, paths) {
			const present = new Set<string>();
			for (const chunk of chunks(paths)) {
				const out = await run(["ls-tree", "-r", "-z", "--name-only", snapshot, "--", ...chunk]);
				for (const path of out.split("\0")) if (path) present.add(path);
			}
			const back = paths.filter((path) => present.has(path));
			for (const chunk of chunks(back)) await run(["checkout", snapshot, "--", ...chunk]);
			for (const path of paths) if (!present.has(path)) rmSync(join(root, path), { force: true });
		},
	};
}
