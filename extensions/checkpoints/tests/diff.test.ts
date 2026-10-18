import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import checkpoints from "../index.ts";
import { openStore } from "../store.ts";

function project() {
	const base = mkdtempSync(join(tmpdir(), "pi-diff-test-"));
	const root = join(base, "repo"), stores = join(base, "stores");
	mkdirSync(root); mkdirSync(stores);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	const write = (path: string, value: string | Buffer) => writeFileSync(join(root, path), value);
	git("init", "-q");
	write(".gitignore", "ignored/\n");
	write("a.ts", "original\n"); write("b.ts", "untouched\n");
	git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial");
	return { root, stores, git, write, done: () => rmSync(base, { recursive: true, force: true }) };
}

function harness(root: string, entries: any[] = []) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const renderers = new Map<string, Function>();
	const notes: string[] = [];
	let panel: any;
	let closed = false;
	const pi = {
		on: (name: string, fn: Function) => handlers.set(name, fn),
		registerCommand: (name: string, spec: any) => commands.set(name, spec),
		registerEntryRenderer: (name: string, fn: Function) => renderers.set(name, fn),
		appendEntry: (customType: string, data: unknown) => entries.push({ id: `e${entries.length}`, type: "custom", customType, data }),
	};
	checkpoints(pi as any);
	const ctx: any = {
		cwd: root, hasUI: true, isIdle: () => true,
		sessionManager: { getBranch: () => entries },
		ui: {
			notify: (note: string) => notes.push(note),
			custom: async (factory: Function) => { panel = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_c: string, s: string) => s }, {}, () => { closed = true; }); },
		},
	};
	return {
		entries, handlers, commands, renderers, notes, ctx,
		start: () => handlers.get("session_start")!({}, ctx),
		async turn(change: () => void, prompt = "make a change") {
			entries.push({ id: `u${entries.length}`, type: "message", message: { role: "user", content: prompt, timestamp: Date.now() - 1000 } });
			await handlers.get("before_agent_start")!({}, ctx);
			change();
			await handlers.get("agent_settled")!({}, ctx);
		},
		async diff(mode = "") { panel = undefined; await commands.get("diff").handler(mode, ctx); return panel; },
		get closed() { return closed; },
	};
}

async function withAgent(fn: (p: ReturnType<typeof project>) => Promise<void>) {
	const p = project();
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = p.stores;
	try { await fn(p); }
	finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; p.done(); }
}

const text = (panel: any) => panel.render(180).join("\n");

test("unified diffs cover edits, additions, deletion, binary, mode and unusual filenames without touching real index", async () => {
	const p = project();
	try {
		p.write("a.ts", "already staged\n"); p.git("add", "a.ts"); p.write("b.ts", "already unstaged\n");
		const indexBefore = p.git("diff", "--cached");
		const store = (await openStore(p.root, p.stores))!;
		const before = await store.snapshot();
		p.write("a.ts", "agent edit\n"); rmSync(join(p.root, "b.ts"));
		p.write("new\t名\nfile.ts", "new\n"); p.write("binary.dat", Buffer.from([0, 1, 2, 0]));
		p.write("executable.sh", "echo hi\n"); chmodSync(join(p.root, "executable.sh"), 0o755);
		mkdirSync(join(p.root, "ignored")); p.write("ignored/no.txt", "hidden\n");
		const after = await store.snapshot();
		const report = await store.diff(before, after);
		assert.equal(report.files.length, 5);
		assert.match(report.files.find((f) => f.path === "a.ts")!.patch, /-already staged\n\+agent edit/);
		assert.match(report.files.find((f) => f.path === "b.ts")!.patch, /deleted file mode/);
		assert.match(report.files.find((f) => f.path === "executable.sh")!.patch, /100755/);
		assert.equal(report.files.find((f) => f.path === "binary.dat")!.binary, true);
		assert.equal(report.files.find((f) => f.path === "new\t名\nfile.ts")!.added, 1);
		assert.equal(p.git("diff", "--cached"), indexBefore);
		assert.equal(p.git("stash", "list"), "");
		assert.deepEqual(await store.diff(before, after, []), { files: [] });
		assert.deepEqual(await store.diff(after, after), { files: [] });
		assert.deepEqual((await store.diff(before, after, ["a.ts"])).files.map((f) => f.path), ["a.ts"]);
	} finally { p.done(); }
});

test("mode-only changes appear even when line counts are zero", async () => {
	const p = project();
	try {
		const store = (await openStore(p.root, p.stores))!;
		const before = await store.snapshot(); chmodSync(join(p.root, "a.ts"), 0o755);
		const report = await store.diff(before, await store.snapshot());
		assert.equal(report.files.length, 1); assert.equal(report.files[0].added, 0);
		assert.match(report.files[0].patch, /old mode 100644\nnew mode 100755/);
	} finally { p.done(); }
});

test("oversized patches are bounded and explicitly flagged without dropping file statistics", async () => {
	const p = project();
	try {
		const store = (await openStore(p.root, p.stores))!;
		const before = await store.snapshot(); p.write("huge.txt", "x".repeat(300_000) + "\n");
		const report = await store.diff(before, await store.snapshot());
		assert.equal(report.truncated, true); assert.equal(report.files[0].truncated, true);
		assert.equal(report.files[0].added, 1); assert.ok(Buffer.byteLength(report.files[0].patch) <= 128 * 1024 + 3);
	} finally { p.done(); }
});

test("concurrent snapshots use independent temporary indexes and clean them up", async () => {
	const p = project();
	try {
		const stores = await Promise.all(Array.from({ length: 8 }, () => openStore(p.root, p.stores)));
		const trees = await Promise.all(stores.map((s) => s!.snapshot()));
		assert.equal(new Set(trees).size, 1);
		for (const folder of readdirSync(p.stores)) assert.ok(!readdirSync(join(p.stores, folder)).some((name) => name.startsWith("snapshot-")));
	} finally { p.done(); }
});

test("turn and session diffs use filesystem baselines, retain initial dirty work, and exclude unrelated between-turn edits", async () => withAgent(async (p) => {
	p.write("a.ts", "user's existing work\n"); p.git("add", "a.ts");
	const staged = p.git("diff", "--cached");
	const h = harness(p.root); await h.start();
	await h.turn(() => p.write("a.ts", "first agent change\n"));
	let panel = await h.diff("last");
	assert.match(text(panel), /-user's existing work/); assert.match(text(panel), /\+first agent change/);
	p.write("b.ts", "user's unrelated later work\n");
	await h.turn(() => p.write("a.ts", "second agent change\n"));
	panel = await h.diff("last"); assert.match(text(panel), /-first agent change/); assert.doesNotMatch(text(panel), /-user's existing work/);
	panel = await h.diff(); assert.match(text(panel), /-user's existing work/); assert.match(text(panel), /\+second agent change/);
	assert.doesNotMatch(text(panel), /unrelated later work|b\.ts/);
	assert.equal(p.git("diff", "--cached"), staged);
	const records = h.entries.filter((e) => e.customType === "checkpoint");
	assert.equal(records.length, 2); assert.match(records[0].data.entryId, /^u/);
	const view = h.renderers.get("checkpoint")!(records[0], { expanded: false }, { fg: (_c: string, s: string) => s });
	assert.match(view.render(80)[0], /Changes · 1 file · \+1 −1/);
	assert.ok(h.entries.every((e) => e.type !== "custom_message"), "diffs remain non-context custom entries");
}));

test("latest no-op turn has an empty diff rather than showing an older change", async () => withAgent(async (p) => {
	const h = harness(p.root); await h.start();
	await h.turn(() => p.write("a.ts", "changed\n"));
	await h.turn(() => {}, "explain it");
	assert.match(text(await h.diff("last")), /No file changes/);
	assert.match(text(await h.diff()), /\+changed/);
	assert.equal(h.entries.filter((e) => e.customType === "checkpoint").length, 1, "no-op turns do not clutter rewind");
}));

test("session view is a net diff: adding then deleting disappears", async () => withAgent(async (p) => {
	const h = harness(p.root); await h.start();
	await h.turn(() => p.write("ephemeral.ts", "temporary\n"));
	await h.turn(() => rmSync(join(p.root, "ephemeral.ts")));
	assert.match(text(await h.diff()), /No file changes/);
	assert.match(text(await h.diff("last")), /deleted file mode/);
}));

test("resuming reconstructs baseline and history without resetting or duplicating it", async () => withAgent(async (p) => {
	const h = harness(p.root); await h.start(); await h.turn(() => p.write("a.ts", "first\n"));
	const resumed = harness(p.root, h.entries); await resumed.start();
	assert.equal(resumed.entries.filter((e) => e.customType === "checkpoint-baseline").length, 1);
	await resumed.turn(() => p.write("a.ts", "second\n"));
	assert.match(text(await resumed.diff()), /-original/); assert.match(text(await resumed.diff()), /\+second/);
}));

test("older sessions fall back to first checkpoint baseline and can regenerate legacy turn diffs", async () => withAgent(async (p) => {
	const h = harness(p.root); await h.start(); await h.turn(() => p.write("a.ts", "legacy\n"));
	const entries = h.entries.filter((e) => e.customType !== "checkpoint-baseline");
	delete entries.find((e) => e.customType === "checkpoint").data.diff;
	const resumed = harness(p.root, entries); await resumed.start();
	assert.match(text(await resumed.diff("last")), /\+legacy/);
	assert.match(text(await resumed.diff()), /-original/);
}));

test("branch navigation ignores abandoned records and restored files disappear from session net diff", async () => withAgent(async (p) => {
	const h = harness(p.root); await h.start(); await h.turn(() => p.write("a.ts", "first\n"));
	const branch = [...h.entries];
	await h.turn(() => p.write("b.ts", "abandoned\n"));
	const store = (await openStore(p.root, join(p.stores, "checkpoints")))!;
	const first = branch.find((e) => e.customType === "checkpoint").data;
	await store.restore(first.after, ["b.ts"]);
	const fork = harness(p.root, branch); await fork.start();
	assert.doesNotMatch(text(await fork.diff()), /abandoned|b\.ts/);
	await store.restore(first.before, ["a.ts"]);
	assert.match(text(await fork.diff()), /No file changes/);
}));

test("diff command handles invalid arguments, running agent, missing history and non-Git folders", async () => withAgent(async (p) => {
	const h = harness(p.root); await h.start();
	await h.diff("nonsense"); assert.match(h.notes.at(-1)!, /Usage/);
	await h.diff(); assert.match(h.notes.at(-1)!, /No recorded turns/);
	h.ctx.isIdle = () => false; await h.diff(); assert.match(h.notes.at(-1)!, /Wait/);
	const loose = harness(p.stores); await loose.start(); await loose.diff(); assert.match(loose.notes.at(-1)!, /Git repository/);
}));

test("same-run continuations keep the first baseline and record once at agent_settled", async () => withAgent(async (p) => {
	const h = harness(p.root); await h.start();
	h.entries.push({ type: "message", id: "user", message: { role: "user", content: "two stages", timestamp: 1 } });
	await h.handlers.get("before_agent_start")!({}, h.ctx); p.write("a.ts", "stage one\n");
	await h.handlers.get("before_agent_start")!({}, h.ctx); p.write("a.ts", "stage two\n");
	await h.handlers.get("agent_settled")!({}, h.ctx);
	assert.equal(h.entries.filter((e) => e.customType === "checkpoint").length, 1);
	assert.match(text(await h.diff("last")), /-original/); assert.match(text(await h.diff("last")), /\+stage two/);
}));
