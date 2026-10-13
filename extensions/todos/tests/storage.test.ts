import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import todosExtension from "../index.ts";
import { readTodos } from "../../todo-widget/index.ts";

function fixture(t: TestContext) {
	const tmp = mkdtempSync(join(tmpdir(), "pi-todo-storage-"));
	const env = { agent: process.env.PI_CODING_AGENT_DIR, todos: process.env.PI_TODO_PATH };
	const agent = join(tmp, "agent");
	process.env.PI_CODING_AGENT_DIR = agent;
	delete process.env.PI_TODO_PATH;
	t.after(() => {
		for (const [key, value] of [["PI_CODING_AGENT_DIR", env.agent], ["PI_TODO_PATH", env.todos]]) {
			if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
		}
		rmSync(tmp, { recursive: true, force: true });
	});
	const project = (name = "app") => {
		const cwd = join(tmp, name);
		mkdirSync(cwd, { recursive: true });
		return cwd;
	};
	const central = (root: string) => {
		root = realpathSync(root);
		const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
		return join(agent, "todos", `${basename(root)}-${hash}`);
	};
	return { tmp, agent, project, central };
}

function harness(cwd: string) {
	let start!: (event: any, ctx: any) => Promise<void>;
	let tool: any;
	todosExtension({
		on: (event: string, handler: any) => { if (event === "session_start") start = handler; },
		registerTool: (definition: any) => { tool = definition; },
		registerCommand: () => {},
	} as any);
	const ctx = { cwd, hasUI: false, sessionManager: { getSessionId: () => "storage-test", getSessionFile: () => undefined } };
	return {
		start: () => start({ reason: "startup" }, ctx),
		call: (params: any) => tool.execute("test-call", params, undefined, undefined, ctx),
	};
}

function legacy(cwd: string, id = "deadbeef", title = "Existing task") {
	const dir = join(cwd, ".pi/todos");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${id}.md`);
	writeFileSync(file, JSON.stringify({ id, title, tags: [], status: "open", created_at: new Date().toISOString() }) + "\n\nExisting body\n");
	return { dir, file };
}

test("new todos are stored outside the project and the widget reads that same store", async (t) => {
	const f = fixture(t), cwd = f.project(), h = harness(cwd);
	await h.start();
	const result = await h.call({ action: "create", title: "Central task" });
	const id = result.details.todo.id;
	assert.ok(existsSync(join(f.central(cwd), `${id}.md`)), "the todo belongs in the global per-project store");
	assert.equal(existsSync(join(cwd, ".pi")), false, "startup and creation must not create project-local files");
	assert.deepEqual(readTodos(cwd, 0).map((todo) => [todo.id, todo.title]), [[id, "Central task"]]);
});

test("projects with the same name have separate global stores", async (t) => {
	const f = fixture(t), a = f.project("a/app"), b = f.project("b/app");
	const ha = harness(a), hb = harness(b);
	await ha.start(); await hb.start();
	const created = await ha.call({ action: "create", title: "Only project A" });
	assert.deepEqual((await hb.call({ action: "list" })).details.todos, []);
	assert.ok(existsSync(join(f.central(a), `${created.details.todo.id}.md`)));
	assert.notEqual(f.central(a), f.central(b));
	assert.ok(existsSync(f.central(b)));
});

test("the Git root and its subdirectories share one project store", async (t) => {
	const f = fixture(t), root = f.project(), child = join(root, "src");
	mkdirSync(child);
	execFileSync("git", ["init", "--quiet", root]);
	const parent = harness(root), nested = harness(child);
	await parent.start(); await nested.start();
	const created = await parent.call({ action: "create", title: "Repo task" });
	assert.deepEqual((await nested.call({ action: "list" })).details.todos.map((todo: any) => todo.id), [created.details.todo.id]);
	assert.equal(readTodos(child, 0)[0]?.title, "Repo task");
});

test("a symlink to a project uses the same store as its real path", async (t) => {
	const f = fixture(t), root = f.project(), alias = join(f.tmp, "alias");
	symlinkSync(root, alias);
	const h = harness(root), throughAlias = harness(alias);
	await h.start(); await throughAlias.start();
	const created = await h.call({ action: "create", title: "Same project" });
	assert.deepEqual((await throughAlias.call({ action: "list" })).details.todos.map((todo: any) => todo.id), [created.details.todo.id]);
	assert.ok(existsSync(join(f.central(root), `${created.details.todo.id}.md`)));
});

test("legacy todos and settings are copied once, with timestamps preserved and originals untouched", async (t) => {
	const f = fixture(t), cwd = f.project(), old = legacy(cwd);
	writeFileSync(join(old.dir, "settings.json"), '{"gc":false,"gcDays":30}');
	writeFileSync(join(old.dir, "deadbeef.lock"), "active lock");
	writeFileSync(join(old.dir, "unrelated.md"), "not a todo");
	const when = new Date(Date.now() - 5 * 3600_000);
	utimesSync(old.file, when, when);
	const contents = readFileSync(old.file, "utf8"), mtime = statSync(old.file).mtimeMs;
	const h = harness(cwd);
	await h.start();
	const target = join(f.central(cwd), "deadbeef.md");
	assert.ok(existsSync(target), "existing tasks must still be available after changing the default");
	assert.equal(readFileSync(target, "utf8"), contents);
	assert.ok(Math.abs(statSync(target).mtimeMs - mtime) < 1);
	assert.equal(readFileSync(old.file, "utf8"), contents);
	assert.equal(readFileSync(join(f.central(cwd), "settings.json"), "utf8"), '{"gc":false,"gcDays":30}');
	assert.equal(existsSync(join(f.central(cwd), "deadbeef.lock")), false);
	assert.equal(existsSync(join(f.central(cwd), "unrelated.md")), false);
	assert.equal((await h.call({ action: "list" })).details.todos[0]?.title, "Existing task");
	assert.deepEqual(readTodos(cwd, Date.now() - 3600_000), [], "migration must not make old work look freshly edited");
	unlinkSync(target);
	await h.start();
	assert.equal(existsSync(target), false, "a deleted task must not be resurrected from its backup on reload");
});

test("migration never overwrites an existing central todo or its settings", async (t) => {
	const f = fixture(t), cwd = f.project();
	legacy(cwd);
	const dir = f.central(cwd);
	mkdirSync(dir, { recursive: true });
	const contents = '{"id":"deadbeef","title":"Newer version","status":"open","tags":[]}\n\nNew body';
	writeFileSync(join(dir, "deadbeef.md"), contents);
	writeFileSync(join(dir, "settings.json"), '{"gc":false}');
	const h = harness(cwd);
	await h.start();
	assert.equal(readFileSync(join(dir, "deadbeef.md"), "utf8"), contents);
	assert.equal((await h.call({ action: "list" })).details.todos[0]?.title, "Newer version");
	assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), '{"gc":false}');
});

test("starting from a Git subdirectory imports both root and local legacy todos", async (t) => {
	const f = fixture(t), root = f.project(), child = join(root, "src");
	mkdirSync(child);
	execFileSync("git", ["init", "--quiet", root]);
	legacy(root, "aaaa0000", "Root legacy task");
	legacy(child, "bbbb0000", "Nested legacy task");
	const h = harness(child);
	await h.start();
	assert.deepEqual((await h.call({ action: "list" })).details.todos.map((todo: any) => todo.title).sort(), ["Nested legacy task", "Root legacy task"]);
	assert.equal(readTodos(root, 0).length, 2);
});

test("simultaneous sessions can import the same legacy store without losing data", async (t) => {
	const f = fixture(t), cwd = f.project(), old = legacy(cwd);
	const first = harness(cwd), second = harness(cwd);
	await Promise.all([first.start(), second.start()]);
	assert.ok(existsSync(join(f.central(cwd), "deadbeef.md")));
	assert.equal(readFileSync(old.file, "utf8"), readFileSync(join(f.central(cwd), "deadbeef.md"), "utf8"));
});

for (const absolute of [false, true]) {
	test(`PI_TODO_PATH still supports ${absolute ? "absolute" : "relative"} overrides without importing legacy todos`, async (t) => {
		const f = fixture(t), cwd = f.project();
		legacy(cwd);
		process.env.PI_TODO_PATH = `  ${absolute ? join(f.tmp, "override") : "custom-todos"}  `;
		const h = harness(cwd);
		await h.start();
		const created = await h.call({ action: "create", title: "Custom task" });
		const dir = absolute ? join(f.tmp, "override") : join(cwd, "custom-todos");
		assert.ok(existsSync(join(dir, `${created.details.todo.id}.md`)));
		assert.equal(existsSync(join(dir, "deadbeef.md")), false);
		assert.deepEqual(readTodos(cwd, 0).map((todo) => todo.title), ["Custom task"]);
		assert.equal(existsSync(join(f.agent, "todos")), false);
	});
}
