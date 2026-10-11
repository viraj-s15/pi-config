import assert from "node:assert/strict";
import { test } from "node:test";
import { operationLabel, summarizeOperation } from "../summaries.ts";

test("recognizes node tests/run.mjs and complete Node runner counts", () => {
	assert.equal(operationLabel("bash", { command: "node tests/run.mjs" }), "Tests");
	assert.equal(
		summarizeOperation("bash", { command: "node tests/run.mjs" }, "ℹ tests 176\nℹ pass 176\nℹ fail 0", false),
		"Tests 176 passed 0 failed",
	);
});

test("only reports failures observed in a complete runner summary", () => {
	assert.equal(summarizeOperation("bash", { command: "npm test" }, "176 passed", false), "Tests 176 passed");
	assert.equal(summarizeOperation("bash", { command: "npm test" }, "Tests: 3 failed, 176 passed, 179 total", false), "Tests 176 passed 3 failed");
	assert.equal(summarizeOperation("bash", { command: "npm test" }, "Tests 2 failed | 176 passed (178)", false), "Tests 176 passed 2 failed");
	assert.equal(summarizeOperation("bash", { command: "pytest" }, "2 failed, 176 passed in 2.3s", false), "Tests 176 passed 2 failed");
	assert.equal(summarizeOperation("bash", { command: "pytest" }, "176 passed in 2.3s", false), "Tests 176 passed");
	assert.equal(summarizeOperation("bash", { command: "npm test" }, "Tests: 176 passed, 176 total", false), "Tests 176 passed");
	assert.equal(summarizeOperation("bash", { command: "npm test" }, "ℹ tests 178\nℹ pass 176\nℹ fail 2", false), "Tests 176 passed 2 failed");
	assert.equal(summarizeOperation("bash", { command: "npm test" }, "Tests 176 passed (176)\nDuration 3s", false), "Tests 176 passed");
	assert.equal(summarizeOperation("bash", { command: "npm test" }, "3 failed\nTests 176 passed", false), "Tests");
});

test("recognizes common test runners, not lint or typecheck as tests", () => {
	for (const command of ["npx vitest run", "npx jest", "python -m pytest", "pytest", "npm test"]) {
		assert.equal(operationLabel("bash", { command }), "Tests", command);
	}
	for (const command of ["npm run lint", "npm run typecheck", "npx eslint .", "tsc --noEmit"]) {
		assert.notEqual(operationLabel("bash", { command }), "Tests", command);
	}
	assert.equal(operationLabel("bash", { command: "echo 'npm test'" }), "echo 'npm test'");
});

test("does not claim success for a tool error or unsuccessful exit status", () => {
	assert.equal(summarizeOperation("bash", { command: "node tests/run.mjs" }, "ℹ tests 176\nℹ pass 176\nℹ fail 0\nCommand exited with code 1", true), "Tests failed (exit code 1)");
	assert.equal(summarizeOperation("bash", { command: "npm test" }, "176 passed\nexit code 1", false), "Tests failed (exit code 1)");
});

test("recognizes git operations only in executable shell segments", () => {
	assert.equal(operationLabel("bash", { command: "echo 'git push origin production'" }), "echo 'git push origin production'");
	assert.equal(operationLabel("bash", { command: "cd repo; git commit -am 'ship'" }), "Git commit");
	assert.equal(operationLabel("bash", { command: "cd repo && git push origin main" }), "Git push");
	assert.equal(operationLabel("bash", { command: "sh -c 'git push origin main'" }), "sh -c 'git push origin main'");
	assert.equal(operationLabel("bash", { command: "git push origin main | tee log" }), "Git push", "a pipeline still runs the push; its output is what gets summarized");
});

test("summarizes observed successful non-bash results only when recognizable", () => {
	assert.equal(summarizeOperation("read", { path: "src/a.ts" }, "a\nb\nc", false), "Read src/a.ts · 3 lines");
	assert.equal(summarizeOperation("grep", { pattern: "needle" }, "src/a.ts:1: needle\nsrc/b.ts:4: needle", false), "Search needle · 2 matches");
	assert.equal(summarizeOperation("grep", { pattern: "needle" }, "", false), "Search needle · no matches");
	assert.equal(summarizeOperation("write", { path: "a.txt", content: "héllo" }, "Successfully wrote to a.txt", false), "Wrote a.txt · 6 bytes");
	assert.equal(summarizeOperation("edit", { path: "a.ts" }, "Successfully replaced 2 block(s) in a.ts.", false), "Updated a.ts · 2 edits");
	assert.equal(summarizeOperation("edit", { path: "a.ts" }, "done", false), "");
	assert.equal(summarizeOperation("read", { path: "a.ts" }, "", false), "");
});

test("find counts paths, not Pi's no-results and limit notices", () => {
	assert.equal(summarizeOperation("find", { pattern: "*.ts" }, "No files found matching pattern", false), "Find *.ts · no matches");
	assert.equal(summarizeOperation("find", { pattern: "*.ts" }, "src/a.ts\nsrc/b.ts\n\n[2 results limit reached. Use limit=4 for more, or refine pattern]", false), "Find *.ts · 2 paths shown · limited");
	assert.equal(summarizeOperation("find", { pattern: "*.ts" }, "src/a.ts\n\n[50.0KB limit reached]", false), "Find *.ts · 1 path shown · limited");
	assert.equal(summarizeOperation("find", { pattern: "*.ts" }, "src/a.ts\n\nsrc/b.ts", false), "Find *.ts · 2 paths shown");
});

test("retains existing operation summaries", () => {
	assert.equal(summarizeOperation("bash", { command: "echo 'npm test'" }, "Tests 176 passed", false), "echo 'npm test'");
	assert.match(summarizeOperation("bash", { command: "git commit -am 'ship'" }, "[main abc1234] ship\n 2 files changed, 4 insertions(+)", false), /Git commit abc1234 · 2 files/);
	assert.match(summarizeOperation("bash", { command: "git push origin main" }, "To github.com:owner/repo.git\n   abc1234..def5678  main -> main", false), /Git push github\.com:owner\/repo\.git · main -> main/);
	assert.equal(summarizeOperation("bash", { command: "echo hi" }, "hi", false), "echo hi");
	assert.equal(summarizeOperation("bash", { command: "npm test" }, "", false), "Tests");
	assert.equal(summarizeOperation("read", { path: "src/a.ts" }, "contents", false), "Read src/a.ts · 1 line");
});

const NODE_OK = "ℹ tests 228\nℹ pass 228\nℹ fail 0";

test("real-world compound commands still get a summary: redirects, pipes, env prefixes, status checks", () => {
	const redirected = "node tests/run.mjs > /tmp/pi-final.log 2>&1; r=$?; tail -9 /tmp/pi-final.log | head -4; echo TEST_EXIT=$r";
	assert.equal(operationLabel("bash", { command: redirected }), "Tests");
	assert.equal(summarizeOperation("bash", { command: redirected }, NODE_OK, false), "Tests 228 passed 0 failed");
	for (const command of [
		"npm test 2>&1 | tail -5",
		"CI=1 npm test",
		"cd ~/Documents/github/pi-config && node tests/run.mjs 2>&1 | tail -20",
		"node tests/run.mjs > /tmp/x.log 2>&1; result=$?; if [ \"$result\" -ne 0 ]; then exit \"$result\"; fi",
		"time npm test",
	]) assert.equal(operationLabel("bash", { command }), "Tests", command);
	assert.equal(summarizeOperation("bash", { command: "node tests/run.mjs > /tmp/x.log 2>&1; tail -9 /tmp/x.log" }, "ℹ tests 3\nℹ pass 2\nℹ fail 1", false), "Tests 2 passed 1 failed");
});

test("a redirect or pipe never turns a quoted mention into an executed command", () => {
	for (const command of ["echo 'npm test' > /tmp/note", "cat notes.txt | grep 'npm test'", "echo \"git push origin main\" >> log"]) {
		assert.ok(!["Tests", "Git push"].includes(operationLabel("bash", { command })), command);
	}
});

test("git commit and push are recognized inside pipelines and redirects", () => {
	assert.equal(operationLabel("bash", { command: "git add -A && git commit -m 'x' 2>&1 | tail -3" }), "Git commit");
	assert.equal(operationLabel("bash", { command: "git push origin main 2>&1" }), "Git push");
	assert.equal(summarizeOperation("bash", { command: "git commit -m x 2>&1 | tail -3" }, "[main abc1234] x\n 2 files changed, 4 insertions(+)", false), "Git commit abc1234 · 2 files");
});
