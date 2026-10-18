import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { piModuleUrl } from "../../../tests/pi-runtime.mjs";
import { showDiff, TurnDiffComponent } from "../diff-view.ts";

const theme = { fg: (_name: string, value: string) => value };
const mouse = (y: number) => ({ type: "click", button: "left", x: 0, y, screenX: 0, screenY: y, width: 80, height: 40, shift: false, alt: false, ctrl: false });

test("real Pi custom-entry host renders, routes clicks, expands with Ctrl+O state, and excludes diffs from context", async () => {
	const { CustomEntryComponent } = await import(piModuleUrl("@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js"));
	const { sessionEntryToContextMessages } = await import(piModuleUrl("@earendil-works/pi-coding-agent/dist/core/session-manager.js"));
	const entry = { id: "diff", parentId: null, timestamp: new Date().toISOString(), type: "custom", customType: "checkpoint", data: { diff: { files: [{ path: "sample.ts", added: 1, removed: 1, binary: false, patch: "@@ -1 +1 @@\n-old\n+new" }] } } };
	const host = new CustomEntryComponent(entry, (e: any, options: any) => new TurnDiffComponent(e.data.diff, theme, options.expanded));
	assert.ok(host.hasContent());
	assert.equal(host.render(80).length, 2, "host spacer plus collapsed changes row");
	assert.ok(host.handleMouse(mouse(1))?.handled);
	assert.match(host.render(80).join("\n"), /sample\.ts/);
	assert.ok(host.handleMouse(mouse(2))?.handled);
	assert.match(host.render(80).join("\n"), /\+new/);
	host.setExpanded(true);
	assert.match(host.render(80).join("\n"), /\+new/);
	for (const line of host.render(7)) assert.ok(visibleWidth(line) <= 7);
	assert.deepEqual(sessionEntryToContextMessages(entry), []);
});

test("scrolling can leave the selected header behind and reach the end of a long patch", async () => {
	let panel: any;
	await showDiff({ ui: { custom: async (factory: Function) => { panel = factory({ terminal: { rows: 12 }, requestRender() {} }, theme, {}, () => {}); } } }, { files: [{ path: "long.ts", added: 100, removed: 0, binary: false, patch: Array.from({ length: 100 }, (_, i) => `+line-${i}`).join("\n") }] }, "Long patch");
	assert.match(panel.render(80).join("\n"), /long\.ts/);
	for (let i = 0; i < 30; i++) panel.handleInput("j");
	assert.match(panel.render(80).join("\n"), /line-29/);
	assert.doesNotMatch(panel.render(80).join("\n"), /long\.ts/);
	panel.handleInput("\x1b[F");
	assert.match(panel.render(80).join("\n"), /line-99/);
	panel.handleInput("\x1b[H");
	assert.match(panel.render(80).join("\n"), /long\.ts/);
});

test("inline click targets match the shared preview layout after multiple truncated patches", () => {
	const files = Array.from({ length: 3 }, (_, i) => ({ path: `file-${i}.ts`, added: 100, removed: 0, binary: false, patch: Array.from({ length: 100 }, (_, n) => `+${i}-${n}`).join("\n") }));
	const component = new TurnDiffComponent({ files }, theme, true);
	const lines = component.render(100);
	const thirdRow = lines.findIndex((line) => line.startsWith("▾ file-2.ts"));
	assert.ok(thirdRow > 0);
	component.handleMouse(mouse(thirdRow) as any);
	assert.ok(component.render(100).some((line) => line.startsWith("▸ file-2.ts")));
});
