import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const roots = new Map<string, string>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

function canonical(path: string): string {
	try { return realpathSync(path); } catch { return resolve(path); }
}

/** Git subdirectories share a store; other directories are independent projects. */
function projectRoot(cwd: string): string {
	const directory = canonical(cwd);
	const cached = roots.get(directory);
	if (cached) return cached;
	let root = directory;
	try {
		// Don't let inherited Git plumbing variables select a different repository.
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		root = canonical(execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
			encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], env,
		}).trim());
	} catch { /* Outside Git (or Git unavailable): use the working directory. */ }
	roots.set(directory, root);
	return root;
}

/** Shared by the todo tool and widget. PI_TODO_PATH keeps its existing cwd-relative semantics. */
export function getTodosDir(cwd: string): string {
	const override = process.env.PI_TODO_PATH?.trim();
	if (override) return resolve(cwd, override);
	const root = projectRoot(cwd);
	const agentDir = resolve(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"));
	return join(agentDir, "todos", `${basename(root) || "project"}-${hash(root)}`);
}

/** Import each old store once. Originals remain as backups; existing central files always win. */
export async function migrateLegacyTodos(cwd: string): Promise<void> {
	if (process.env.PI_TODO_PATH?.trim()) return;
	const target = getTodosDir(cwd);
	const sources = new Set([join(projectRoot(cwd), ".pi", "todos"), join(canonical(cwd), ".pi", "todos")]);
	for (const source of sources) {
		const marker = join(target, `.migrated-${hash(source)}.json`);
		if (existsSync(marker)) continue;
		let entries;
		try { entries = await readdir(source, { withFileTypes: true }); }
		catch (error) { if (errorCode(error) === "ENOENT") continue; throw error; }
		await mkdir(target, { recursive: true });
		for (const entry of entries) {
			if (!entry.isFile() || !(entry.name === "settings.json" || /^[a-f0-9]{8}\.md$/i.test(entry.name))) continue;
			const from = join(source, entry.name), to = join(target, entry.name);
			const times = await stat(from);
			try { await copyFile(from, to, constants.COPYFILE_EXCL); }
			catch (error) { if (errorCode(error) === "EEXIST") continue; throw error; }
			await utimes(to, times.atime, times.mtime);
		}
		try { await writeFile(marker, JSON.stringify({ source }) + "\n", { flag: "wx" }); }
		catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
	}
}
