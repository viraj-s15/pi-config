import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitize, showDiff, summary, TurnDiffComponent, type DiffReport } from "../diff-view.ts";

const theme = { fg: (_name: string, text: string) => text };
const report: DiffReport = {
	files: [
		{ path: "src/一.ts", added: 2, removed: 1, binary: false, patch: "@@ -1 +1,2 @@\n-old\n+new\n+二" },
		{ path: "image.png", added: 0, removed: 0, binary: true, patch: "" },
	],
};

const click = (component: TurnDiffComponent, y: number) => component.handleMouse!({
	type: "click", button: "left", x: 0, y, screenX: 0, screenY: y, width: 80, height: 20,
	shift: false, alt: false, ctrl: false,
});

test("summary reports file count and line totals", () => {
	assert.equal(summary(report), "▸ Changes · 2 files · +2 −1");
});

test("mouse toggles the report and individual file patches", () => {
	const component = new TurnDiffComponent(report, theme);
	assert.equal(component.render(80).length, 1);
	click(component, 0);
	let lines = component.render(80);
	assert.match(lines[1]!, /src\/一\.ts/);
	assert.equal(lines.length, 3, "header expansion initially opens file headers without patches");
	click(component, 1);
	lines = component.render(80);
	assert.equal(lines.length, 7, "opening a file shows its patch");
	assert.match(lines[1]!, /▾ src\/一\.ts/);
});

test("expanded host mode renders patches and narrow Unicode lines fit the requested width", () => {
	const component = new TurnDiffComponent(report, theme, true);
	const lines = component.render(9);
	assert.ok(lines.length > 2);
	for (const line of lines) assert.ok(visibleWidth(line) <= 9, `${visibleWidth(line)} > 9: ${line}`);
	assert.ok(lines.some((line) => line.includes("+new")));
});

test("inline preview is capped across the whole report and escapes path newlines", () => {
	const files = Array.from({ length: 2 }, (_, i) => ({ path: `part${i}\n+forged`, added: 0, removed: 0, binary: false, patch: Array.from({ length: 100 }, (_, n) => `+line-${i}-${n}`).join("\n") }));
	const lines = new TurnDiffComponent({ files }, theme, true).render(200);
	assert.equal(lines.filter((line) => /\+line-/.test(line)).length, 160);
	assert.ok(lines.some((line) => line.includes("preview limited; use /diff last")));
	assert.ok(lines.some((line) => line.includes("part0\\n+forged")));
	assert.equal(lines.filter((line) => line.includes("forged")).length, 2);
});

test("sanitizer removes ANSI/OSC controls and neutralizes tabs and other controls", () => {
	const dirty = "name\t\x1b[31mred\x1b[0m\x1b]8;;https://evil.test\x07link\x1b]8;;\x07\x07\x1b]2;title\x1b\\\x01";
	const clean = sanitize(dirty);
	assert.equal(clean, "name redlink");
	assert.equal(/[\x00-\x1f\x7f]/.test(clean), false);
	const component = new TurnDiffComponent({ files: [{ ...report.files[0]!, path: "bad\x1b]2;pwn\x07.ts", patch: "+\x1b[2Jsafe" }] }, theme, true);
	const rendered = component.render(80).join("\n");
	assert.equal(rendered.includes("\x1b]"), false);
	assert.equal(rendered.includes("\x1b[2J"), false);
	assert.match(rendered, /bad\.ts/);
});

test("dedicated panel supports keyboard scrolling, toggling, and close", async () => {
	let panel: any;
	let closed = false;
	const ctx = { ui: { custom: async (factory: Function) => { panel = factory({ terminal: { rows: 8 }, requestRender() {} }, theme, {}, () => { closed = true; }); } } };
	await showDiff(ctx, { files: Array.from({ length: 5 }, (_, i) => ({ path: `file-${i}.ts`, added: 1, removed: 0, binary: false, patch: `@@ ${i} @@\n+line` })) }, "Last turn");
	assert.ok(panel.render(16).length <= 8);
	panel.handleInput("n");
	panel.handleInput("\r");
	assert.match(panel.render(40).join("\n"), /▶ ▸ file-1\.ts/);
	panel.handleInput(" ");
	assert.match(panel.render(40).join("\n"), /▶ ▾ file-1\.ts/);
	panel.handleInput("a");
	panel.handleInput("p");
	panel.handleInput("n");
	panel.handleInput("n");
	panel.handleInput("n");
	panel.handleInput("n");
	const resized = panel.render(40);
	assert.ok(resized.length <= 8);
	assert.match(resized.join("\n"), /▶/);
	panel.handleInput("q");
	assert.equal(closed, true);
});
