import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestLoader } from "../../tests/pi-runtime.mjs";

const loader = await createTestLoader();
const { findImagePathSpans, projectImagePathChips, removeImagePathAt } = await loader.import(join(dirname(fileURLToPath(import.meta.url)), "chips.ts"));

test("projects shell-escaped unicode image paths to compact chips without changing source", () => {
  const path = "/tmp/Screen shot 你好.png".replace(/ /g, "\\ ");
  const source = `look ${path} now`;
  const spans = findImagePathSpans(source);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].path, path.replace(/\\(.)/g, "$1"));
  assert.equal(projectImagePathChips(source).text, "look [Image 1 · Screen shot 你好.png ×] now");
  assert.equal(source, `look ${path} now`);
});

test("removes exactly one attachment span and leaves surrounding multiline text intact", () => {
  const source = `a /tmp/a.png\nb /tmp/b.png`;
  const spans = findImagePathSpans(source);
  assert.equal(removeImagePathAt(source, spans[1].start), "a /tmp/a.png\nb ");
  assert.equal(removeImagePathAt(source, -1), source);
});

test("does not treat URLs, unsupported extensions, or image-name suffixes as image paths", () => {
  const source = "https://host/a.png /tmp/a.svg /tmp/b.png.txt /tmp/c.png.backup prose";
  assert.deepEqual(findImagePathSpans(source).map((span) => span.path), []);
});

test("keeps prose and unsupported filenames before a later supported path", () => {
  const source = "look at /tmp/report.pdf and /tmp/photo.png please";
  assert.deepEqual(findImagePathSpans(source).map((span) => span.path), ["/tmp/photo.png"]);
  assert.equal(projectImagePathChips(source).text, "look at /tmp/report.pdf and [Image 1 · photo.png ×] please");
});
