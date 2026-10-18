import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "../store.ts";
import { describeRewind, filesToRestore, type RunRecord } from "../plan.ts";
import checkpoints from "../index.ts";

function project() {
	const root = mkdtempSync(join(tmpdir(), "ckpt-proj-"));
	const stores = mkdtempSync(join(tmpdir(), "ckpt-store-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	writeFileSync(join(root, ".gitignore"), "node_modules/\n");
	writeFileSync(join(root, "a.ts"), "a1\n");
	writeFileSync(join(root, "mine.ts"), "mine1\n");
	mkdirSync(join(root, "node_modules"));
	writeFileSync(join(root, "node_modules", "dep.js"), "dep\n");
	execFileSync("git", ["add", "-A"], { cwd: root });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: root });
	return { root, stores, read: (f: string) => readFileSync(join(root, f), "utf8"), write: (f: string, s: string) => writeFileSync(join(root, f), s), done: () => { rmSync(root, { recursive: true, force: true }); rmSync(stores, { recursive: true, force: true }); } };
}

test("snapshots live outside the project and do not touch its git state", async () => {
	const p = project();
	try {
		const store = (await openStore(p.root, p.stores))!;
		assert.ok(store);
		const before = execFileSync("git", ["status", "--porcelain"], { cwd: p.root, encoding: "utf8" });
		await store.snapshot();
		assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: p.root, encoding: "utf8" }), before);
		assert.equal(execFileSync("git", ["stash", "list"], { cwd: p.root, encoding: "utf8" }), "");
	} finally { p.done(); }
});

test("a subfolder of a repo snapshots the whole repo; outside a repo there is no store", async () => {
	const p = project();
	const loose = mkdtempSync(join(tmpdir(), "ckpt-loose-"));
	try {
		mkdirSync(join(p.root, "sub"));
		const store = (await openStore(join(p.root, "sub"), p.stores))!;
		assert.equal(store.root, execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: p.root, encoding: "utf8" }).trim());
		assert.equal(await openStore(loose, p.stores), undefined);
	} finally { p.done(); rmSync(loose, { recursive: true, force: true }); }
});

test("lists the files a run changed: edits, new files and deletions, but not ignored ones", async () => {
	const p = project();
	try {
		const store = (await openStore(p.root, p.stores))!;
		const before = await store.snapshot();
		p.write("a.ts", "a2\n");
		p.write("new.ts", "new\n");
		rmSync(join(p.root, "mine.ts"));
		p.write("node_modules/dep.js", "changed\n");
		const after = await store.snapshot();
		assert.deepEqual((await store.changed(before, after)).sort(), ["a.ts", "mine.ts", "new.ts"]);
		assert.deepEqual(await store.changed(after, after), []);
	} finally { p.done(); }
});

test("restoring puts back only the listed files: changed ones revert, created ones go, deleted ones return", async () => {
	const p = project();
	try {
		const store = (await openStore(p.root, p.stores))!;
		const before = await store.snapshot();
		p.write("a.ts", "a2\n");
		p.write("new.ts", "new\n");
		rmSync(join(p.root, "mine.ts"));
		const after = await store.snapshot();
		p.write("yours.ts", "you made this\n");
		await store.restore(before, await store.changed(before, after));
		assert.equal(p.read("a.ts"), "a1\n");
		assert.equal(existsSync(join(p.root, "new.ts")), false);
		assert.equal(p.read("mine.ts"), "mine1\n");
		assert.equal(p.read("yours.ts"), "you made this\n", "files outside the list are left alone");
		assert.equal(execFileSync("git", ["status", "--porcelain", "a.ts"], { cwd: p.root, encoding: "utf8" }), "", "the real index is untouched");
	} finally { p.done(); }
});

const run = (entryId: string, before: string, files: string[], at = 0): RunRecord => ({ entryId, before, after: `${before}'`, files, at, prompt: `prompt ${entryId}` });

test("rewinding to a prompt restores every file changed from that run on, each to its state before that run", () => {
	const runs = [run("p1", "T1", ["a.ts"]), run("p2", "T2", ["a.ts", "b.ts"]), run("p3", "T3", ["c.ts"])];
	assert.deepEqual(filesToRestore(runs, "p2"), { tree: "T2", files: ["a.ts", "b.ts", "c.ts"] });
	assert.deepEqual(filesToRestore(runs, "p1"), { tree: "T1", files: ["a.ts", "b.ts", "c.ts"] });
	assert.deepEqual(filesToRestore(runs, "p3"), { tree: "T3", files: ["c.ts"] });
	assert.equal(filesToRestore(runs, "nope"), undefined);
});

test("the picker shows each prompt with how long ago and how many files rewinding would restore", () => {
	const now = 10_000_000;
	const runs = [run("p1", "T1", ["a.ts"], now - 3 * 3600_000), run("p2", "T2", ["b.ts", "c.ts"], now - 4 * 60_000)];
	runs[1]!.prompt = "fix the footer so that it\nshows cost";
	assert.deepEqual(describeRewind(runs, now), [
		{ entryId: "p2", label: "4m ago · fix the footer so that it · 2 files" },
		{ entryId: "p1", label: "3h ago · prompt p1 · 3 files" },
	]);
});

test("registers /rewind and the run hooks", () => {
	const commands: string[] = [];
	const events: string[] = [];
	checkpoints({ registerCommand: (name: string) => commands.push(name), on: (event: string) => events.push(event), registerEntryRenderer() {}, appendEntry() {} } as any);
	assert.deepEqual(commands, ["diff", "rewind"]);
	for (const event of ["session_start", "before_agent_start", "agent_settled"]) assert.ok(events.includes(event), event);
});

test("a run is recorded against its prompt, and /rewind restores the agent's files and rewinds the chat", async () => {
	const p = project();
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = p.stores;
	try {
		const handlers = new Map<string, Function>();
		const commands = new Map<string, any>();
		const entries: any[] = [];
		const pi = {
			on: (event: string, fn: Function) => handlers.set(event, fn),
			registerCommand: (name: string, spec: any) => commands.set(name, spec),
			registerEntryRenderer() {},
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", id: `c${entries.length}`, customType, data }),
		};
		checkpoints(pi as any);
		const answers: string[] = [];
		const notes: string[] = [];
		const navigated: string[] = [];
		const ctx: any = {
			cwd: p.root, hasUI: true, isIdle: () => true,
			sessionManager: { getBranch: () => entries },
			ui: { select: async (_title: string, options: string[]) => options.find((o) => o.startsWith(answers.shift()!)), notify: (m: string) => notes.push(m) },
			navigateTree: async (id: string) => { navigated.push(id); return { cancelled: false }; },
		};
		await handlers.get("session_start")!({}, ctx);
		await handlers.get("before_agent_start")!({}, ctx);
		entries.push({ type: "message", id: "u1", message: { role: "user", content: "make a better", timestamp: Date.now() } });
		p.write("a.ts", "agent wrote this\n");
		p.write("made.ts", "new file\n");
		await handlers.get("agent_settled")!({}, ctx);
		assert.equal(entries.length, 3);
		const checkpoint = entries.find((entry) => entry.customType === "checkpoint");
		assert.deepEqual(checkpoint.data.files, ["a.ts", "made.ts"]);
		assert.equal(checkpoint.data.entryId, "u1");
		assert.match(checkpoint.data.diff.files[0].patch, /\+agent wrote this/);

		p.write("mine.ts", "my own edit\n"); // never touched by the agent
		answers.push("just now · make a better", "Restore files and rewind");
		await commands.get("rewind").handler("", ctx);
		assert.equal(p.read("a.ts"), "a1\n");
		assert.equal(existsSync(join(p.root, "made.ts")), false);
		assert.equal(p.read("mine.ts"), "my own edit\n");
		assert.deepEqual(navigated, ["u1"]);

		answers.push("↶ Undo the last rewind");
		await commands.get("rewind").handler("", ctx);
		assert.equal(p.read("a.ts"), "agent wrote this\n");
		assert.equal(p.read("made.ts"), "new file\n");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		p.done();
	}
});
