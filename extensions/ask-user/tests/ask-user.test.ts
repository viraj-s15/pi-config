import assert from "node:assert/strict";
import { test } from "node:test";
import { showQuestions } from "../ui/index.ts";

const UP = "\x1b[A", DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b", SPACE = " ";

/** Drive the picker like a user: render it, press keys, collect what it resolves with. */
function picker() {
	let component: any;
	let result: any = "pending";
	const ctx = {
		ui: {
			custom: (factory: any) => new Promise((resolve) => {
				component = factory({ requestRender() {}, terminal: { rows: 40, columns: 100 } }, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, (value: any) => { result = value; resolve(value); });
			}),
			input: async () => null,
		},
	} as any;
	return {
		ctx,
		press: (...keys: string[]) => { for (const key of keys) component.handleInput(key); },
		screen: () => component.render(100).join("\n"),
		result: () => result,
	};
}

const question = (multiSelect?: boolean) => ({
	question: "Which ones?", multiSelect,
	options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
});

test("multi-select shows checkboxes and returns every ticked option", async () => {
	const p = picker();
	const answer = showQuestions([question(true)], p.ctx);
	await Promise.resolve();
	assert.match(p.screen(), /\[ \] 1\. Alpha/);
	p.press(SPACE, DOWN, DOWN, SPACE);
	assert.match(p.screen(), /\[x\] 1\. Alpha[\s\S]*\[ \] 2\. Beta[\s\S]*\[x\] 3\. Gamma/);
	assert.match(p.screen(), /2 selected/);
	p.press(ENTER);
	const { answers } = (await answer)!;
	assert.deepEqual(answers[0]!.answer, ["Alpha", "Gamma"]);
	assert.equal(answers[0]!.wasCustom, false);
});

test("number keys toggle in multi-select instead of submitting", async () => {
	const p = picker();
	const answer = showQuestions([question(true)], p.ctx);
	await Promise.resolve();
	p.press("2", "3", "3", "1");
	assert.equal(p.result(), "pending", "a number key does not submit");
	p.press(ENTER);
	assert.deepEqual((await answer)!.answers[0]!.answer, ["Alpha", "Beta"], "answers keep the options' order");
});

test("Enter with nothing ticked takes the highlighted option", async () => {
	const p = picker();
	const answer = showQuestions([question(true)], p.ctx);
	await Promise.resolve();
	p.press(DOWN, ENTER);
	assert.deepEqual((await answer)!.answers[0]!.answer, ["Beta"]);
});

test("Other adds a typed answer alongside the ticked ones", async () => {
	const p = picker();
	const answer = showQuestions([question(true)], p.ctx);
	await Promise.resolve();
	p.press("1", "0");
	assert.match(p.screen(), /Your answer/);
	p.press(..."Delta", ENTER);
	assert.match(p.screen(), /\[x\] 4\. Other: Delta/);
	assert.equal(p.result(), "pending", "typing Other goes back to the list");
	p.press(ENTER);
	const result = (await answer)!.answers[0]!;
	assert.deepEqual(result.answer, ["Alpha", "Delta"]);
	assert.equal(result.wasCustom, true);
});

test("Esc cancels a multi-select question", async () => {
	const p = picker();
	const answer = showQuestions([question(true)], p.ctx);
	await Promise.resolve();
	p.press(SPACE, ESC);
	assert.equal(await answer, null);
});

test("single-select is unchanged: a number key picks and submits", async () => {
	const p = picker();
	const answer = showQuestions([question()], p.ctx);
	await Promise.resolve();
	assert.doesNotMatch(p.screen(), /\[ \]/);
	p.press("2");
	assert.equal((await answer)!.answers[0]!.answer, "Beta");
});
