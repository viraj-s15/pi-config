#!/usr/bin/env node
/** Use Semble's upstream installer, then apply this config's Pi-specific defaults. */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const START = "<!-- pi-config:semble:start -->";
const END = "<!-- pi-config:semble:end -->";
const GUIDANCE = `${START}
## Code discovery with Semble

- Start code discovery with Semble's MCP search tool (mcp__semble__search): use it to find where behavior is implemented, understand an unfamiliar feature, or locate an unfamiliar symbol. Do not default to rg for these discovery tasks; Semble can find relevant code without knowing its exact names. Use the current Git repository root as repo; do not search sibling or remote repos unless the task calls for them. If the relevant file path is already known, read it directly.
- Start with top_k=5 and max_snippet_lines=10. Follow returned paths and line ranges with targeted reads rather than grepping for the same code again. Search content="docs" or "config" only when needed; code is the default.
- Use mcp__semble__find_related to explore implementations related to a promising result. It is similarity search, not an exhaustive reference/caller finder.
- All search tools remain available. Use rg for exact strings, error messages, regexes, exhaustive reference checks, and follow-up searches within discovered code. If Semble fails or returns insufficient results, continue with rg rather than getting stuck. Search results are candidates, not proof of complete coverage.
- First use in each repository builds an index. Wait for it; do not launch duplicate searches or parallel index builds. Later searches reuse the cache and incrementally refresh changed files.
- MCP freshness checks have a build-time cooldown. After edits or a branch switch, read the live source; if results look stale, use the CLI fallback, which revalidates its disk cache on each invocation.
- Subagents should use Semble for code discovery too; include this workflow when delegating exploration. If MCP is unavailable, use the CLI fallback: SEMBLE_INDEX_WORKERS=0 TOKENIZERS_PARALLELISM=false RAYON_NUM_THREADS=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1 semble search "describe the implementation" . --top-k 5 --max-snippet-lines 10
${END}`;

export function updateGuidance(existing) {
  const start = existing.indexOf(START), end = existing.indexOf(END);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) throw new Error("Incomplete Semble instruction markers; fix AGENTS.md before rerunning setup.");
  if (start >= 0) return existing.slice(0, start) + GUIDANCE + existing.slice(end + END.length);
  return existing + (existing ? (existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n") : "") + GUIDANCE + "\n";
}

function atomicWrite(path, text) {
  const target = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: existsSync(target) ? statSync(target).mode & 0o777 : 0o600 });
  renameSync(temp, target);
}

export function configureSemble(agentDir) {
  const configPath = join(agentDir, "mcp.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const server = config.mcpServers?.semble;
  if (!server?.command || !Array.isArray(server.args)) throw new Error("Semble's installer did not create a valid MCP entry.");
  const instructionsPath = join(agentDir, "AGENTS.md");
  // Validate instructions before changing either file.
  const instructions = updateGuidance(existsSync(instructionsPath) ? readFileSync(instructionsPath, "utf8") : "");
  Object.assign(server, {
    enabled: true,
    exposure: "direct",
    description: "Start code discovery here: locate implementations by behavior, concept, or unfamiliar symbol without knowing exact names. find_related discovers similar code. Indexes on first search and refreshes incrementally.",
    timeout: 300,
    env: {
      ...server.env,
      SEMBLE_INDEX_WORKERS: "0",
      SEMBLE_MCP_IDLE_TIMEOUT: "120",
      TOKENIZERS_PARALLELISM: "false",
      RAYON_NUM_THREADS: "1",
      OMP_NUM_THREADS: "1",
      OPENBLAS_NUM_THREADS: "1",
      VECLIB_MAXIMUM_THREADS: "1",
      HF_HUB_DISABLE_TELEMETRY: "1",
    },
  });
  atomicWrite(configPath, JSON.stringify(config, null, 2) + "\n");
  atomicWrite(instructionsPath, instructions);
}

export function main() {
  const agentDir = join(homedir(), ".pi", "agent");
  if (process.env.PI_CODING_AGENT_DIR && resolve(process.env.PI_CODING_AGENT_DIR) !== resolve(agentDir)) {
    throw new Error("Semble's upstream Pi installer targets ~/.pi/agent. Unset PI_CODING_AGENT_DIR before using this setup command.");
  }
  for (const [command, args] of [
    ["uv", ["tool", "install", "--upgrade", "semble[mcp]"]],
    ["semble", ["install", "--agent", "pi", "--type", "mcp", "--yes"]],
  ]) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}).`);
  }
  configureSemble(agentDir);
  console.log("Semble installed/updated for Pi. Run /reload; use /mcp to inspect the connection. No repositories were indexed by setup.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
