import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatReport, newDiagnostics, type Diagnostic } from "../report.ts";
import { parseTscOutput } from "../typescript.ts";
import { parseRuffOutput } from "../ruff.ts";
import { checkJson } from "../json.ts";
import editCheck from "../index.ts";

const d = (line: number, code: string, message: string): Diagnostic => ({ line, column: 1, code, message });

test("only errors that were not there before count as new; moved lines do not make old errors new", () => {
	const before = [d(3, "TS2322", "Type 'string' is not assignable to type 'number'."), d(9, "TS7006", "Parameter 'x' implicitly has an 'any' type.")];
	const after = [d(5, "TS2322", "Type 'string' is not assignable to type 'number'."), d(9, "TS7006", "Parameter 'x' implicitly has an 'any' type."), d(12, "TS2304", "Cannot find name 'foo'.")];
	assert.deepEqual(newDiagnostics(before, after), [d(12, "TS2304", "Cannot find name 'foo'.")]);
	assert.deepEqual(newDiagnostics([d(1, "E", "same")], [d(1, "E", "same"), d(2, "E", "same")]), [d(2, "E", "same")], "a second copy of an old error is new");
});

test("the report names the file, the checker and each error, and caps the list", () => {
	const many = Array.from({ length: 12 }, (_, i) => d(i + 1, "TS2304", `Cannot find name 'n${i}'.`));
	const text = formatReport("src/a.ts", "TypeScript", many);
	assert.match(text, /^New errors in src\/a\.ts after this change \(TypeScript\):/);
	assert.match(text, /- 1:1 TS2304 Cannot find name 'n0'\./);
	assert.match(text, /…and 2 more/);
	assert.match(text, /Errors that were already there are not listed\./);
});

test("reads tsc output, including messages that continue on the next lines", () => {
	const out = [
		"src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
		"src/b.ts(3,1): error TS2345: Argument of type '{ a: number; }' is not assignable to parameter of type 'B'.",
		"  Property 'b' is missing in type '{ a: number; }' but required in type 'B'.",
		"Found 2 errors in 2 files.",
	].join("\n");
	const byFile = parseTscOutput(out, "/proj");
	assert.deepEqual(byFile.get("/proj/src/a.ts"), [{ line: 12, column: 5, code: "TS2322", message: "Type 'string' is not assignable to type 'number'." }]);
	assert.match(byFile.get("/proj/src/b.ts")![0]!.message, /parameter of type 'B'\. Property 'b' is missing/);
});

test("reads ruff's JSON output", () => {
	const out = JSON.stringify([{ code: "F821", message: "Undefined name `foo`", location: { row: 4, column: 7 }, filename: "/p/a.py" }]);
	assert.deepEqual(parseRuffOutput(out), [{ line: 4, column: 7, code: "F821", message: "Undefined name `foo`" }]);
	assert.deepEqual(parseRuffOutput(""), []);
});

test("JSON files are checked by parsing; config files that allow comments are skipped", () => {
	assert.deepEqual(checkJson("/p/data.json", '{"a": 1}'), []);
	assert.equal(checkJson("/p/data.json", '{"a": 1,}')![0]!.code, "JSON");
	assert.equal(checkJson("/p/tsconfig.json", "{ // comment\n}"), undefined);
	assert.equal(checkJson("/p/.vscode/settings.json", "{ // c\n}"), undefined);
});

function harness(cwd: string) {
	const handlers = new Map<string, Function>();
	editCheck({ on: (event: string, fn: Function) => handlers.set(event, fn), registerCommand() {} } as any);
	const ctx = { cwd, hasUI: false, ui: { notify() {} } };
	let n = 0;
	return {
		async start() { await handlers.get("before_agent_start")?.({}, ctx); },
		/** Runs the tool_call hook, applies the change, then returns what tool_result adds (or undefined). */
		async edit(tool: "edit" | "write", path: string, apply: () => void, isError = false) {
			const id = `t${n++}`;
			const input = { path };
			await handlers.get("tool_call")!({ type: "tool_call", toolName: tool, toolCallId: id, input }, ctx);
			apply();
			const result = await handlers.get("tool_result")!({ type: "tool_result", toolName: tool, toolCallId: id, input, content: [{ type: "text", text: "Edited." }], isError }, ctx);
			return result?.content?.map((c: any) => c.text).join("") as string | undefined;
		},
	};
}

test("after an edit that breaks a JSON file, the agent is told; an already broken file is not reported again", async () => {
	const dir = mkdtempSync(join(tmpdir(), "edit-check-"));
	try {
		const file = join(dir, "data.json");
		writeFileSync(file, '{"a": 1}');
		const h = harness(dir);
		await h.start();
		const broke = await h.edit("edit", "data.json", () => writeFileSync(file, '{"a": 1,}'));
		assert.match(broke!, /^Edited\.\n\nNew errors in data\.json after this change \(JSON\):/);
		const still = await h.edit("edit", "data.json", () => writeFileSync(file, '{"a": 2,}'));
		assert.equal(still, undefined, "the error was there before this edit");
		const failed = await h.edit("edit", "data.json", () => writeFileSync(file, "{"), true);
		assert.equal(failed, undefined, "failed edits are not checked");
		const created = await h.edit("write", "new.json", () => writeFileSync(join(dir, "new.json"), "nope"));
		assert.match(created!, /New errors in new\.json/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TypeScript: the project's own tsc runs; only new errors in the edited file are reported", async () => {
	const dir = mkdtempSync(join(tmpdir(), "edit-check-ts-"));
	try {
		writeFileSync(join(dir, "tsconfig.json"), "{}");
		mkdirSync(join(dir, "src"));
		mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
		const a = join(dir, "src", "a.ts");
		writeFileSync(a, "old\n");
		writeFileSync(join(dir, "src", "other.ts"), "x\n");
		// A stand-in tsc: always one old error in other.ts and a.ts; a new error in a.ts when it contains BROKEN.
		const tsc = join(dir, "node_modules", ".bin", "tsc");
		writeFileSync(tsc, `#!/bin/sh
echo "src/other.ts(1,1): error TS1000: Old error elsewhere."
echo "src/a.ts(1,1): error TS1001: Old error here."
if grep -q BROKEN src/a.ts; then echo "src/a.ts(2,3): error TS2304: Cannot find name 'BROKEN'."; fi
exit 2
`);
		chmodSync(tsc, 0o755);
		const h = harness(dir);
		await h.start();
		const report = await h.edit("edit", "src/a.ts", () => writeFileSync(a, "old\nBROKEN\n"));
		assert.match(report!, /New errors in src\/a\.ts after this change \(TypeScript\):\n- 2:3 TS2304 Cannot find name 'BROKEN'\./);
		assert.doesNotMatch(report!, /Old error/);
		const clean = await h.edit("edit", "src/a.ts", () => writeFileSync(a, "old\n"));
		assert.equal(clean, undefined);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("files with no checker are passed through untouched", async () => {
	const dir = mkdtempSync(join(tmpdir(), "edit-check-none-"));
	try {
		const h = harness(dir);
		await h.start();
		assert.equal(await h.edit("write", "notes.md", () => writeFileSync(join(dir, "notes.md"), "# hi")), undefined);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
