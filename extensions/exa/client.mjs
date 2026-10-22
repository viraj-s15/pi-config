import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function keyPath({ env = process.env, home = homedir() } = {}) {
  return join(env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), "secrets", "exa-api-key");
}

function validateApiKey(key) {
  if (!/^[\x21-\x7E]+$/.test(key)) {
    throw new Error("Exa API key contains invalid whitespace or terminal control characters. Re-run bin/setup-exa-key.py in your terminal to save a clean key.");
  }
  return key;
}

export async function resolveApiKey(options = {}) {
  const env = options.env ?? process.env;
  if (env.EXA_API_KEY?.trim()) return validateApiKey(env.EXA_API_KEY.trim());
  const path = keyPath(options);
  let key;
  try {
    key = (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Cannot read Exa API key at ${path}; check its permissions.`);
  }
  if (key) return validateApiKey(key);
  throw new Error(`Exa API key is missing. Run python3 ~/Documents/github/pi-config/bin/setup-exa-key.py in your terminal, or set EXA_API_KEY. Do not paste the key into chat.`);
}

export async function searchWeb({ query, limit = 5 }, options = {}) {
  if (typeof query !== "string" || !query.trim()) throw new Error("Search query must not be empty.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("Search limit must be an integer from 1 to 10.");
  const apiKey = await resolveApiKey(options);
  const timeout = AbortSignal.timeout(20000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  let response;
  try {
    response = await (options.fetchImpl ?? globalThis.fetch)("https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ query: query.trim(), type: "auto", numResults: limit, contents: { highlights: true } }),
      signal,
    });
  } catch {
    if (signal.aborted) signal.throwIfAborted();
    throw new Error("Exa search request failed; check your network connection.");
  }
  if (!response.ok) {
    // Never echo the remote body: it may contain credentials or request headers.
    const hint = {
      401: "API key rejected; update your Exa key.",
      403: "Access denied; check your Exa account and API key.",
      402: "Credits exhausted; check your Exa dashboard or wait for the monthly reset.",
      429: "Rate limit or quota reached; check your Exa dashboard before retrying.",
    }[response.status] ?? "Search failed; try again later.";
    throw new Error(`Exa returned HTTP ${response.status}. ${hint}`);
  }
  let data;
  try { data = await response.json(); } catch {
    if (signal.aborted) signal.throwIfAborted();
    throw new Error("Exa returned invalid JSON.");
  }
  if (!data || !Array.isArray(data.results)) throw new Error("Exa returned an invalid results payload.");
  const results = data.results.filter(result => {
    if (!result || typeof result.url !== "string") return false;
    try { return ["http:", "https:"].includes(new URL(result.url).protocol); } catch { return false; }
  }).slice(0, limit).map(result => ({
    title: typeof result.title === "string" ? result.title : "",
    url: result.url,
    snippet: Array.isArray(result.highlights) ? result.highlights.filter(item => typeof item === "string").join("\n\n") : "",
  }));
  return { query: query.trim(), results };
}
