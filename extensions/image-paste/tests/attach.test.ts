import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import imagePaste from "../index.ts";
import { attachImagePaths } from "../attach.ts";

// A real 1x1 PNG, so Pi's own magic-byte detection accepts it.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

function dir(t: TestContext) {
  const d = mkdtempSync(join(tmpdir(), "pi-image-paste-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const put = (path: string, bytes: Buffer = PNG) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, bytes); return path; };
const run = (text: string, extra: object = {}) => attachImagePaths(text, extra);

test("text without an image path is left alone", async () => {
  const r = await run("explain /etc/hosts and why 1/2 is 0.5 in https://example.com/a.png");
  assert.equal(r.text, "explain /etc/hosts and why 1/2 is 0.5 in https://example.com/a.png");
  assert.deepEqual(r.images, []);
});

test("an image path becomes an attached base64 image and a numbered placeholder", async t => {
  const file = put(join(dir(t), "shot.png"));
  const r = await run(`what is wrong here? ${file}`);
  assert.equal(r.text, "what is wrong here? [image 1: shot.png]");
  assert.deepEqual(r.images, [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
});

test("the path can be the whole message, or sit mid-sentence before punctuation", async t => {
  const file = put(join(dir(t), "a.png"));
  assert.equal((await run(file)).text, "[image 1: a.png]");
  assert.equal((await run(`look at ${file}, then fix it.`)).text, "look at [image 1: a.png], then fix it.");
  assert.equal((await run(`(${file})`)).text, "([image 1: a.png])");
});

test("shell-escaped spaces, as a terminal drag-and-drop pastes them", async t => {
  const file = put(join(dir(t), "Screenshot 2026-10-10 at 2.07.51 PM.png"));
  const escaped = file.replace(/ /g, "\\ ");
  const r = await run(`${escaped} what is this`);
  assert.equal(r.text, "[image 1: Screenshot 2026-10-10 at 2.07.51 PM.png] what is this");
  assert.equal(r.images.length, 1);
});

test("macOS screenshot names with a narrow no-break space before PM", async t => {
  const file = put(join(dir(t), "Screenshot 2026-10-10 at 2.07.51\u202fPM.png"));
  const r = await run(`${file.replace(/ /g, "\\ ").replace(/\u202f/g, "\\\u202f")} hi`);
  assert.equal(r.images.length, 1);
  const raw = await run(`${file} hi`);
  assert.equal(raw.images.length, 1, "also when the spaces were not escaped");
});

test("unescaped spaces, as Finder file copies are pasted", async t => {
  const file = put(join(dir(t), "My Folder", "pic one.png"));
  const r = await run(`see ${file} please`);
  assert.equal(r.text, "see [image 1: pic one.png] please");
});

test("single- and double-quoted paths", async t => {
  const file = put(join(dir(t), "q q.png"));
  assert.equal((await run(`'${file}'`)).images.length, 1);
  assert.equal((await run(`"${file}" explain`)).text, "[image 1: q q.png] explain");
});

test("~/ paths expand to the home directory", async t => {
  const home = dir(t);
  put(join(home, "Pictures", "x.png"));
  const r = await run("~/Pictures/x.png", { home });
  assert.equal(r.images.length, 1);
});

test("a missing file stays as plain text, and does not stop later images", async t => {
  const good = put(join(dir(t), "b.png"));
  const r = await run(`/nope/a.png and ${good}`);
  assert.equal(r.text, "/nope/a.png and [image 1: b.png]");
  assert.equal(r.images.length, 1);
});

test("a file named like an image but not an image is not attached", async t => {
  const fake = put(join(dir(t), "fake.png"), Buffer.from("just some text, not a png"));
  const r = await run(`read ${fake}`);
  assert.equal(r.text, `read ${fake}`);
  assert.deepEqual(r.images, []);
});

test("the real format wins over the extension", async t => {
  const file = put(join(dir(t), "actually-jpeg.png"), JPEG);
  const r = await run(file);
  assert.equal(r.images[0]?.mimeType, "image/jpeg");
});

test("directories and unreadable targets are ignored", async t => {
  const d = dir(t);
  mkdirSync(join(d, "folder.png"));
  symlinkSync(join(d, "missing-target"), join(d, "dangling.png"));
  const r = await run(`${join(d, "folder.png")} ${join(d, "dangling.png")}`);
  assert.deepEqual(r.images, []);
});

test("several images keep their order, and numbering continues after existing attachments", async t => {
  const d = dir(t);
  const a = put(join(d, "a.png")), b = put(join(d, "b.png"), JPEG);
  const r = await run(`${a} versus ${b}`);
  assert.equal(r.text, "[image 1: a.png] versus [image 2: b.png]");
  assert.deepEqual(r.images.map(i => i.mimeType), ["image/png", "image/jpeg"]);
  const after = await run(a, { firstNumber: 3 });
  assert.equal(after.text, "[image 3: a.png]");
});

test("the same file mentioned twice is attached once per mention", async t => {
  const a = put(join(dir(t), "a.png"));
  const r = await run(`${a} ${a}`);
  assert.equal(r.images.length, 2);
});

test("the original bytes are attached untouched; Pi shrinks them to the model's limits later", async t => {
  const file = put(join(dir(t), "orig.png"));
  const r = await run(file);
  assert.equal(r.images[0]?.data, PNG.toString("base64"));
});

test("files over 32 MB are left as text with a warning, and never read", async t => {
  const huge = put(join(dir(t), "huge.png"), Buffer.concat([PNG, Buffer.alloc(33 * 1024 * 1024)]));
  const r = await run(huge);
  assert.deepEqual(r.images, []);
  assert.equal(r.text, huge);
  assert.match(r.warnings[0] ?? "", /too large/);
});

test("at most eight images per message; the rest stay as text", async t => {
  const d = dir(t);
  const files = Array.from({ length: 10 }, (_, i) => put(join(d, `p${i}.png`)));
  const r = await run(files.join(" "));
  assert.equal(r.images.length, 8);
  assert.ok(r.text.endsWith(`${files[8]} ${files[9]}`));
  assert.match(r.warnings.join(" "), /8/);
});

// ---- the extension hook ----

function hook() {
  let handler: any;
  imagePaste({ on: (event: string, h: any) => { if (event === "input") handler = h; } } as any);
  const notes: string[] = [];
  const ctx = { hasUI: true, ui: { notify: (m: string) => notes.push(m) } };
  return { call: (e: any) => handler(e, ctx), notes };
}

test("hook: attaches images for interactive input and keeps images already attached", async t => {
  const file = put(join(dir(t), "h.png"));
  const existing = { type: "image", data: "old", mimeType: "image/png" };
  const r = await hook().call({ type: "input", text: `see ${file}`, images: [existing], source: "interactive" });
  assert.equal(r.action, "transform");
  assert.equal(r.text, "see [image 2: h.png]");
  assert.deepEqual(r.images[0], existing);
  assert.equal(r.images.length, 2);
});

test("hook: does nothing when there is no image path", async () => {
  const r = await hook().call({ type: "input", text: "hello there", source: "interactive" });
  assert.deepEqual(r, { action: "continue" });
});

test("hook: ignores input from rpc and other extensions", async t => {
  const file = put(join(dir(t), "x.png"));
  for (const source of ["rpc", "extension"]) {
    const r = await hook().call({ type: "input", text: file, source });
    assert.deepEqual(r, { action: "continue" }, source);
  }
});

test("hook: warnings reach the user without blocking the message", async t => {
  const huge = put(join(dir(t), "huge.png"), Buffer.concat([PNG, Buffer.alloc(40 * 1024 * 1024)]));
  const h = hook();
  const r = await h.call({ type: "input", text: huge, source: "interactive" });
  assert.deepEqual(r, { action: "continue" });
  assert.match(h.notes.join(" "), /too large/);
});
