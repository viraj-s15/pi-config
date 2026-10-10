import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createImagePaste } from "../index.ts";
import { EMPTY_PASTE, saveClipboardImage, type ClipboardReader } from "../clipboard.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const TIFF = Buffer.from([0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4]);

function dir(t: TestContext) {
  const d = mkdtempSync(join(tmpdir(), "pi-clip-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A clipboard that, like Apple's pasteboard, crashes if two reads overlap. */
function clipboard(contents: { text?: string | null; image?: Uint8Array | null; files?: string[] | null }, log: string[] = []): ClipboardReader {
  let busy = false;
  const read = <T>(name: string, value: T) => async () => {
    assert.equal(busy, false, "clipboard reads must not overlap");
    busy = true;
    log.push(name);
    await new Promise(r => setImmediate(r));
    busy = false;
    return value;
  };
  return { getText: read("text", contents.text ?? null), getImage: read("image", contents.image ?? null), getFilePaths: read("files", contents.files ?? null) };
}

test("an image-only clipboard is saved to a private temp file and its path returned", async t => {
  const d = dir(t);
  const path = await saveClipboardImage({ clipboard: clipboard({ image: PNG }), dir: d });
  assert.ok(path && path.startsWith(d) && /pi-clipboard-[\w-]+\.png$/.test(path), String(path));
  assert.deepEqual(readFileSync(path!), PNG);
  assert.equal(statSync(path!).mode & 0o777, 0o600);
});

test("the file extension follows the real image format", async t => {
  const path = await saveClipboardImage({ clipboard: clipboard({ image: JPEG }), dir: dir(t) });
  assert.match(path ?? "", /\.jpg$/);
});

test("clipboard reads are sequential, and the image is only read once text and files are ruled out", async t => {
  const log: string[] = [];
  await saveClipboardImage({ clipboard: clipboard({ image: PNG }, log), dir: dir(t) });
  assert.deepEqual(log, ["text", "files", "image"]);
});

test("when the clipboard has text, nothing is saved: the normal paste already inserted it", async t => {
  const d = dir(t);
  const log: string[] = [];
  const path = await saveClipboardImage({ clipboard: clipboard({ text: "hello", image: PNG }, log), dir: d });
  assert.equal(path, undefined);
  assert.deepEqual(log, ["text"], "does not even look at the image");
  assert.deepEqual(readdirSync(d), []);
});

test("copied files are left to the normal paste, which already inserted their paths", async t => {
  const path = await saveClipboardImage({ clipboard: clipboard({ files: ["/tmp/a.png"], image: PNG }), dir: dir(t) });
  assert.equal(path, undefined);
});

test("no image, an empty image, and an unavailable clipboard all mean nothing to do", async t => {
  const d = dir(t);
  assert.equal(await saveClipboardImage({ clipboard: clipboard({}), dir: d }), undefined);
  assert.equal(await saveClipboardImage({ clipboard: clipboard({ image: new Uint8Array() }), dir: d }), undefined);
  assert.equal(await saveClipboardImage({ clipboard: null, dir: d }), undefined);
  assert.deepEqual(readdirSync(d), []);
});

test("an unsupported format such as TIFF is converted to PNG, or skipped when it cannot be", async t => {
  const d = dir(t);
  const converted = await saveClipboardImage({ clipboard: clipboard({ image: TIFF }), dir: d, convert: async () => PNG });
  assert.match(converted ?? "", /\.png$/);
  assert.deepEqual(readFileSync(converted!), PNG);
  const skipped = await saveClipboardImage({ clipboard: clipboard({ image: TIFF }), dir: d, convert: async () => undefined });
  assert.equal(skipped, undefined);
  const garbage = await saveClipboardImage({ clipboard: clipboard({ image: Buffer.from("not an image at all") }), dir: d, convert: async () => undefined });
  assert.equal(garbage, undefined);
});

test("a failing clipboard read is reported to the caller", async t => {
  const broken: ClipboardReader = { getText: async () => { throw new Error("denied"); }, getImage: async () => null };
  await assert.rejects(saveClipboardImage({ clipboard: broken, dir: dir(t) }), /denied/);
});

// ---- wiring: Ghostty's Cmd+V sends an empty bracketed paste ----

function wiring(t: TestContext, contents: Parameters<typeof clipboard>[0]) {
  const handlers = new Map<string, any>();
  const d = dir(t);
  createImagePaste({ clipboard: clipboard(contents), dir: d })({ on: (e: string, h: any) => handlers.set(e, h) } as any);
  const pasted: string[] = [];
  const notes: string[] = [];
  let listener: ((data: string) => any) | undefined;
  let unsubscribed = 0;
  let editorText = "";
  const ctx = { hasUI: true, ui: {
    onTerminalInput: (l: any) => { listener = l; return () => { unsubscribed++; }; },
    pasteToEditor: (text: string) => pasted.push(text),
    getEditorText: () => editorText,
    notify: (m: string) => notes.push(m),
  } };
  return {
    start: () => handlers.get("session_start")?.({ reason: "startup" }, ctx),
    send: (data: string) => listener?.(data),
    settle: () => new Promise(r => setTimeout(r, 30)),
    pasted, notes, dir: d, unsubscribed: () => unsubscribed, setEditor: (s: string) => { editorText = s; }, handlers,
  };
}

test("an empty paste with an image on the clipboard inserts the saved file's path into the editor", async t => {
  const w = wiring(t, { image: PNG });
  w.start();
  assert.deepEqual(w.send(EMPTY_PASTE), { consume: true });
  await w.settle();
  assert.equal(w.pasted.length, 1);
  assert.match(w.pasted[0]!, new RegExp(`^${w.dir}/pi-clipboard-[\\w-]+\\.png $`));
});

test("a space is added in front when the editor already ends in a word", async t => {
  const w = wiring(t, { image: PNG });
  w.start();
  w.setEditor("look at");
  w.send(EMPTY_PASTE);
  await w.settle();
  assert.match(w.pasted[0]!, /^ \//);
});

test("an empty paste with text on the clipboard is swallowed and inserts nothing", async t => {
  const w = wiring(t, { text: "hello", image: PNG });
  w.start();
  assert.deepEqual(w.send(EMPTY_PASTE), { consume: true });
  await w.settle();
  assert.deepEqual(w.pasted, []);
});

test("ordinary input, and pastes that have content, are never touched", async t => {
  const w = wiring(t, { image: PNG });
  w.start();
  for (const data of ["a", "\x16", "\x1b[200~hello\x1b[201~", "\x1b[200~\x1b[201~x"]) {
    assert.equal(w.send(data), undefined, JSON.stringify(data));
  }
  await w.settle();
  assert.deepEqual(w.pasted, []);
});

test("a clipboard error is shown to the user instead of failing silently", async t => {
  const handlers = new Map<string, any>();
  createImagePaste({ clipboard: { getText: async () => { throw new Error("no access"); }, getImage: async () => null }, dir: dir(t) })({ on: (e: string, h: any) => handlers.set(e, h) } as any);
  let listener: any; const notes: string[] = [];
  handlers.get("session_start")({}, { hasUI: true, ui: { onTerminalInput: (l: any) => { listener = l; return () => {}; }, pasteToEditor() {}, getEditorText: () => "", notify: (m: string) => notes.push(m) } });
  listener(EMPTY_PASTE);
  await new Promise(r => setTimeout(r, 30));
  assert.match(notes.join(" "), /clipboard/i);
});

test("reloading replaces the old listener instead of stacking a second one", async t => {
  const w = wiring(t, { image: PNG });
  w.start();
  w.start();
  assert.equal(w.unsubscribed(), 1);
});

test("without a UI there is nothing to listen to", t => {
  const handlers = new Map<string, any>();
  createImagePaste({ clipboard: clipboard({ image: PNG }), dir: dir(t) })({ on: (e: string, h: any) => handlers.set(e, h) } as any);
  assert.doesNotThrow(() => handlers.get("session_start")({}, { hasUI: false, ui: {} }));
});
