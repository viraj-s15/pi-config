import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PI_MANAGED_INSTALL_ROOT || join(homedir(), ".pi/agent/install");
const currentVersion = join(root, "current-version");
if (!existsSync(currentVersion)) {
  throw new Error(`Managed Pi installation not found at ${root}. Set PI_MANAGED_INSTALL_ROOT to your Pi install directory.`);
}
const modules = join(root, "releases", readFileSync(currentVersion, "utf8").trim(), "node_modules");
if (!existsSync(modules)) throw new Error(`Pi packages not found at ${modules}`);

export const piModuleUrl = relativePath => pathToFileURL(join(modules, relativePath)).href;

export async function createTestLoader() {
  const { createJiti } = await import(piModuleUrl("jiti/lib/jiti.mjs"));
  const alias = Object.fromEntries(["pi-ai", "pi-coding-agent", "pi-tui", "pi-agent-core"].map(name => [
    `@earendil-works/${name}`, join(modules, "@earendil-works", name, "dist/index.js"),
  ]));
  // Pi maps the old typebox package name onto the one it ships; do the same here.
  const typebox = JSON.parse(readFileSync(join(modules, "typebox", "package.json"), "utf8"));
  const entry = sub => join(modules, "typebox", typebox.exports?.[sub]?.import?.default ?? typebox.exports?.[sub]?.import ?? typebox.exports?.[sub]?.default ?? typebox.exports?.[sub] ?? "");
  for (const [name, sub] of [["", "."], ["/compile", "./compile"], ["/value", "./value"]]) {
    alias[`@sinclair/typebox${name}`] = entry(sub);
    alias[`typebox${name}`] = entry(sub);
  }
  return createJiti(import.meta.url, { alias, moduleCache: true });
}
