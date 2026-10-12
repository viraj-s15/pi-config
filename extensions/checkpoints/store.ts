/**
 * File snapshots kept in a separate git object store under ~/.pi/agent/checkpoints, so the
 * project's own repo, index and stash are never touched. Snapshots follow the project's .gitignore.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SnapshotStore {
	/** The repository's top folder; snapshots cover all of it. */
	root: string;
	/** Record the current files and return the snapshot's id. */
	snapshot(): Promise<string>;
	/** Paths (relative to root) that differ between two snapshots. */
	changed(from: string, to: string): Promise<string[]>;
	/** Put these paths back as they were in a snapshot; paths missing from it are deleted. */
	restore(snapshot: string, paths: string[]): Promise<void>;
}

const CHUNK = 200;

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
		await git(["init", "--bare", "-q", dir], { cwd: root });
		await git(["config", "gc.auto", "0"], { cwd: root, env: { GIT_DIR: dir } }); // snapshots are only referenced from sessions
	}
	const env = { GIT_DIR: dir, GIT_WORK_TREE: root, GIT_INDEX_FILE: join(dir, "index") };
	const run = (args: string[]) => git(args, { cwd: root, env });
	const chunks = (paths: string[]) => Array.from({ length: Math.ceil(paths.length / CHUNK) }, (_, i) => paths.slice(i * CHUNK, (i + 1) * CHUNK));

	return {
		root,
		async snapshot() {
			await run(["add", "-A", "--", "."]);
			return (await run(["write-tree"])).trim();
		},
		async changed(from, to) {
			if (from === to) return [];
			const out = await run(["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to]);
			return out.split("\0").filter(Boolean);
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
