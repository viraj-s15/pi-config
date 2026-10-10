// Use the same TypeScript loader and packages as the installed Pi, without npm install.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PI_MANAGED_INSTALL_ROOT || join(homedir(), ".pi/agent/install");
const version = readFileSync(join(root, "current-version"), "utf8").trim();
const modules = join(root, "releases", version, "node_modules");
if (!existsSync(modules)) throw new Error(`Pi installation not found at ${modules}`);
const { createJiti } = await import(pathToFileURL(join(modules, "jiti/lib/jiti.mjs")).href);
const alias = Object.fromEntries(["pi-ai", "pi-coding-agent", "pi-tui", "pi-agent-core"].map(name => [
  `@earendil-works/${name}`, join(modules, "@earendil-works", name, "dist/index.js"),
]));
const jiti = createJiti(import.meta.url, { alias, moduleCache: true });
await jiti.import(resolve(import.meta.dirname, "btw.test.ts"));
