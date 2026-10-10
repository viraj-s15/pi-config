import { fileURLToPath } from "node:url";
import { createTestLoader } from "./pi-runtime.mjs";

const suites = {
  btw: "../extensions/btw/tests/btw.test.ts",
  "oxo-ui": "../extensions/oxo-ui/tests/rolling-tps.test.ts",
};
const requested = process.argv.slice(2);
const selected = requested.length ? requested : Object.keys(suites);
if (selected.some(name => !Object.hasOwn(suites, name))) {
  console.error("Usage: node tests/run.mjs [btw] [oxo-ui]");
  process.exit(2);
}
const loader = await createTestLoader();
for (const name of new Set(selected)) {
  await loader.import(fileURLToPath(new URL(suites[name], import.meta.url)));
}
