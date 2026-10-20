import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configureSemble, updateGuidance } from "../bin/setup-semble.mjs";

const entry = version => ({ command: "uvx", args: ["--from", `semble[mcp]==${version}`, "semble"] });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-semble-setup-"));
  return { root, write: data => writeFileSync(join(root, "mcp.json"), JSON.stringify(data)), read: () => JSON.parse(readFileSync(join(root, "mcp.json"), "utf8")), done: () => rmSync(root, { recursive: true, force: true }) };
}

test("native MCP setup preserves upstream version pin, other servers and environment while enabling resource-conscious direct tools", () => {
  const f = fixture();
  try {
    f.write({ otherRootSetting: true, mcpServers: { other: { command: "existing", env: { SECRET: "keep-me" } }, semble: { ...entry("0.7.0"), env: { CUSTOM: "preserved", OMP_NUM_THREADS: "8" } } } });
    configureSemble(f.root);
    const config = f.read(), server = config.mcpServers.semble;
    assert.equal(config.otherRootSetting, true);
    assert.deepEqual(config.mcpServers.other, { command: "existing", env: { SECRET: "keep-me" } });
    assert.deepEqual(server.args, ["--from", "semble[mcp]==0.7.0", "semble"]);
    assert.equal(server.env.CUSTOM, "preserved");
    for (const name of ["OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "RAYON_NUM_THREADS"]) assert.equal(server.env[name], "1");
    assert.equal(server.env.SEMBLE_INDEX_WORKERS, "0");
    assert.equal(server.env.SEMBLE_MCP_IDLE_TIMEOUT, "120");
    assert.equal(server.exposure, "direct"); assert.equal(server.enabled, true); assert.equal(server.timeout, 300);
    assert.equal(statSync(join(f.root, "AGENTS.md")).mode & 0o777, 0o600);
    const instructions = readFileSync(join(f.root, "AGENTS.md"), "utf8");
    assert.match(instructions, /mcp__semble__search/); assert.match(instructions, /first use|First use/); assert.match(instructions, /cooldown/);
  } finally { f.done(); }
});

test("configuration is idempotent and reapplies defaults after an upstream installer upgrade rewrites its entry", () => {
  const f = fixture();
  try {
    f.write({ mcpServers: { semble: entry("0.7.0"), other: { command: "keep" } } });
    writeFileSync(join(f.root, "AGENTS.md"), "# Personal rules\nNever remove these.\n");
    configureSemble(f.root);
    const before = readFileSync(join(f.root, "mcp.json"), "utf8"), instructions = readFileSync(join(f.root, "AGENTS.md"), "utf8");
    configureSemble(f.root);
    assert.equal(readFileSync(join(f.root, "mcp.json"), "utf8"), before);
    assert.equal(readFileSync(join(f.root, "AGENTS.md"), "utf8"), instructions);
    const next = f.read(); next.mcpServers.semble = entry("0.8.0"); f.write(next);
    configureSemble(f.root);
    assert.equal(f.read().mcpServers.semble.args[1], "semble[mcp]==0.8.0");
    assert.equal(f.read().mcpServers.semble.env.SEMBLE_INDEX_WORKERS, "0");
    assert.equal(f.read().mcpServers.other.command, "keep");
    assert.equal(readFileSync(join(f.root, "AGENTS.md"), "utf8"), instructions);
    assert.equal((instructions.match(/pi-config:semble:start/g) || []).length, 1);
    assert.match(instructions, /Never remove these/);
  } finally { f.done(); }
});

test("guidance starts discovery with Semble without restricting exact-match tools", () => {
  const guidance = updateGuidance("");
  assert.match(guidance, /Start code discovery with Semble/);
  assert.match(guidance, /All search tools remain available/);
  assert.match(guidance, /If Semble fails or returns insufficient results, continue with rg/);
  assert.match(guidance, /Subagents should use Semble for code discovery too/);
  assert.match(guidance, /file path is already known, read it directly/);
});

test("managed instructions preserve surrounding text and reject malformed markers", () => {
  const first = updateGuidance("before\n");
  const withAfter = first + "\nafter\n";
  assert.equal(updateGuidance(withAfter), withAfter);
  assert.throws(() => updateGuidance("before\n<!-- pi-config:semble:start -->broken"), /Incomplete/);
  assert.throws(() => updateGuidance("<!-- pi-config:semble:end -->"), /Incomplete/);
});

test("invalid installer output or incomplete instructions do not overwrite user files", () => {
  const f = fixture();
  try {
    f.write({ mcpServers: { other: { command: "existing" } } });
    const missing = readFileSync(join(f.root, "mcp.json"), "utf8");
    assert.throws(() => configureSemble(f.root), /valid MCP entry/);
    assert.equal(readFileSync(join(f.root, "mcp.json"), "utf8"), missing);
    f.write({ mcpServers: { semble: entry("0.7.0") } });
    writeFileSync(join(f.root, "AGENTS.md"), "<!-- pi-config:semble:start -->bad");
    const before = readFileSync(join(f.root, "mcp.json"), "utf8");
    assert.throws(() => configureSemble(f.root), /Incomplete/);
    assert.equal(readFileSync(join(f.root, "mcp.json"), "utf8"), before);
  } finally { f.done(); }
});

test("configuration updates preserve symlinks and existing file permissions", () => {
  const f = fixture();
  try {
    const target = join(f.root, "actual.json");
    writeFileSync(target, JSON.stringify({ mcpServers: { semble: entry("0.7.0") } }), { mode: 0o640 });
    symlinkSync(target, join(f.root, "mcp.json"));
    configureSemble(f.root);
    assert.equal(statSync(target).mode & 0o777, 0o640);
    assert.equal(JSON.parse(readFileSync(target, "utf8")).mcpServers.semble.exposure, "direct");
  } finally { f.done(); }
});
