import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTodos, sessionCutoff } from "../index.ts";
import { getTodosDir } from "../../todos/storage.ts";

const HOUR = 3600_000;

function project(t: TestContext, todos: Array<{ id: string; status: string; assigned?: boolean; ageHours: number }>) {
	const cwd = mkdtempSync(join(tmpdir(), "todo-widget-"));
	const agent = process.env.PI_CODING_AGENT_DIR, override = process.env.PI_TODO_PATH;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	delete process.env.PI_TODO_PATH;
	t.after(() => {
		if (agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = agent;
		if (override === undefined) delete process.env.PI_TODO_PATH; else process.env.PI_TODO_PATH = override;
		rmSync(cwd, { recursive: true, force: true });
	});
	const dir = getTodosDir(cwd);
	mkdirSync(dir, { recursive: true });
	for (const todo of todos) {
		const file = join(dir, `${todo.id}.md`);
		const front = { id: todo.id, title: `Todo ${todo.id}`, status: todo.status, created_at: "2026-10-01T00:00:00.000Z",
			...(todo.assigned ? { assigned_to_session: "some-session" } : {}) };
		writeFileSync(file, `${JSON.stringify(front, null, 2)}\n\nbody\n`);
		const when = new Date(Date.now() - todo.ageHours * HOUR);
		utimesSync(file, when, when);
	}
	return cwd;
}

test("an open todo nobody touched since this session began is not shown", (t) => {
	const cwd = project(t, [{ id: "stale", status: "open", ageHours: 5 }]);
	assert.deepEqual(readTodos(cwd, Date.now() - HOUR).map((t) => t.id), []);
});

test("open todos created or edited during this session are shown", (t) => {
	const cwd = project(t, [{ id: "fresh", status: "open", ageHours: 0 }]);
	assert.deepEqual(readTodos(cwd, Date.now() - HOUR).map((t) => [t.id, t.state]), [["fresh", "todo"]]);
});

test("work in progress is always shown, however old", (t) => {
	const cwd = project(t, [
		{ id: "claimed", status: "open", assigned: true, ageHours: 48 },
		{ id: "doing", status: "in-progress", ageHours: 48 },
	]);
	assert.deepEqual(readTodos(cwd, Date.now() - HOUR).map((t) => [t.id, t.state]).sort(), [["claimed", "working"], ["doing", "working"]]);
});

test("finished todos only show if they were finished during this session", (t) => {
	const cwd = project(t, [
		{ id: "old-done", status: "closed", ageHours: 5 },
		{ id: "new-done", status: "done", ageHours: 0 },
	]);
	assert.deepEqual(readTodos(cwd, Date.now() - HOUR).map((t) => t.id), ["new-done"]);
});

test("the session cutoff survives /reload but resets for a new, resumed or forked session", () => {
	const first = sessionCutoff("startup", 1000);
	assert.equal(first, 1000);
	assert.equal(sessionCutoff("reload", 5000), 1000, "reload keeps the cutoff, so todos made before it stay visible");
	for (const reason of ["new", "resume", "fork", undefined]) {
		assert.equal(sessionCutoff(reason, 9000), 9000, `reason ${reason}`);
		sessionCutoff("startup", 1000);
	}
});
