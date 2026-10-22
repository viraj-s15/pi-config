import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestLoader } from "../../../tests/pi-runtime.mjs";

const loader = await createTestLoader();
const clientUrl = new URL("../client.mjs", import.meta.url);
const client = await import(fileURLToPath(clientUrl));
const { searchWeb, resolveApiKey, keyPath } = client;
const reply = (status: number, payload: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => "SENSITIVE SERVER BODY" });
const credentials = { EXA_API_KEY: "  test-secret  ", PI_CODING_AGENT_DIR: "/tmp/pi-test" };

test("resolves trimmed environment key before secret-file fallback without reading real credentials", async () => {
  assert.equal(await resolveApiKey({ env: credentials as NodeJS.ProcessEnv, home: "/tmp/home" }), "test-secret");
  assert.equal(keyPath({ env: { PI_CODING_AGENT_DIR: "/tmp/custom" } as NodeJS.ProcessEnv, home: "/tmp/home" }), "/tmp/custom/secrets/exa-api-key");
  assert.equal(keyPath({ env: {} as NodeJS.ProcessEnv, home: "/tmp/home" }), join("/tmp/home", ".pi/agent/secrets/exa-api-key"));
});

test("search sends Exa's authenticated request and maps only valid HTTP results", async () => {
  let request: any;
  const result = await searchWeb({ query: "  latest news  ", limit: 3 }, {
    env: credentials as NodeJS.ProcessEnv,
    fetchImpl: async (url: any, init: any) => { request = { url, init }; return reply(200, { results: [
      { title: "One", url: "https://example.com", highlights: ["first", "second"] },
      { url: "http://example.org", highlights: [] },
      { title: "bad", url: "javascript:alert(1)", highlights: ["x"] },
      { title: "ignored", url: "https://later.test", highlights: ["x"] },
    ] }); },
  });
  assert.equal(request.url, "https://api.exa.ai/search");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["x-api-key"], "test-secret");
  assert.equal(request.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(request.init.body), { query: "latest news", type: "auto", numResults: 3, contents: { highlights: true } });
  assert.equal(request.init.signal instanceof AbortSignal, true);
  assert.deepEqual(result, { query: "latest news", results: [
    { title: "One", url: "https://example.com", snippet: "first\n\nsecond" },
    { title: "", url: "http://example.org", snippet: "" },
    { title: "ignored", url: "https://later.test", snippet: "x" },
  ] });
});

test("uses secret-file key fallback and rejects missing keys before network access", async () => {
  let reads = 0;
  const directory = await mkdtemp(join(tmpdir(), "exa-test-"));
  const env = { PI_CODING_AGENT_DIR: directory } as NodeJS.ProcessEnv;
  try {
    await mkdir(join(directory, "secrets"));
    await writeFile(keyPath({ env }), " file-test-secret\n", { mode: 0o600 });
    assert.equal(await resolveApiKey({ env }), "file-test-secret");
    await searchWeb({ query: "x" }, { env, fetchImpl: async (_url: unknown, init: any) => {
      reads++;
      assert.equal(init.headers["x-api-key"], "file-test-secret");
      return reply(200, { results: [] });
    } });
    assert.equal(reads, 1);
    await writeFile(keyPath({ env }), "\n");
    await assert.rejects(searchWeb({ query: "x" }, { env, fetchImpl: async () => { reads++; return reply(200, {}); } }), /EXA_API_KEY|secrets\/exa-api-key/i);
    await assert.rejects(resolveApiKey({ env: {}, home: directory }), /EXA_API_KEY/i);
    assert.equal(reads, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects hidden paste markers and invalid key characters without exposing credentials", async () => {
  for (const key of ["\u001b[200~test-secret\u001b[201~", "test-secret\u0000", "test secret", "test-secret\u2603"]) {
    await assert.rejects(resolveApiKey({ env: { EXA_API_KEY: key } }), error => {
      assert.match(String(error), /control characters|whitespace/i);
      assert.doesNotMatch(String(error), /test-secret/);
      return true;
    });
  }
});

test("validates trimmed query and integer limit without fetching", async () => {
  let calls = 0;
  const options = { env: credentials as NodeJS.ProcessEnv, fetchImpl: async () => { calls++; return reply(200, { results: [] }); } };
  for (const query of ["", "  "]) await assert.rejects(searchWeb({ query }, options), /query/i);
  for (const limit of [0, 11, 1.5, NaN]) await assert.rejects(searchWeb({ query: "x", limit }, options), /limit/i);
  assert.equal(calls, 0);
});

test("handles empty results and rejects malformed payloads and HTTP failures without leaking details", async () => {
  assert.deepEqual(await searchWeb({ query: "x" }, { env: credentials as NodeJS.ProcessEnv, fetchImpl: async () => reply(200, { results: [] }) }), { query: "x", results: [] });
  for (const payload of [{}, { results: null }, { results: "bad" }]) await assert.rejects(searchWeb({ query: "x" }, { env: credentials as NodeJS.ProcessEnv, fetchImpl: async () => reply(200, payload) }), /invalid|malformed|payload/i);
  await assert.rejects(searchWeb({ query: "x" }, { env: credentials as NodeJS.ProcessEnv, fetchImpl: async () => reply(401, { error: "SENSITIVE SERVER BODY test-secret" }) }), error => {
    assert.match(String(error), /401/);
    assert.doesNotMatch(String(error), /SENSITIVE|test-secret/);
    return true;
  });
});

test("propagates caller cancellation to the request signal", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const pending = searchWeb({ query: "x" }, { env: credentials as NodeJS.ProcessEnv, signal: controller.signal, fetchImpl: async (_url: any, init: any) => {
    requestSignal = init.signal;
    return await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  } });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(requestSignal?.aborted, true);
});

test("registers web_search and executes through searchWeb result formatting", async () => {
  const { default: extension } = await loader.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
  const previousKey = process.env.EXA_API_KEY;
  const previousFetch = globalThis.fetch;
  let registered: any;
  process.env.EXA_API_KEY = "test-secret";
  globalThis.fetch = async () => reply(200, { results: [{ title: "A", url: "https://a.test", highlights: ["snippet"] }] }) as any;
  try {
    extension({ registerTool: (tool: any) => { registered = tool; } } as any);
    assert.equal(registered.name, "web_search");
    assert.deepEqual(await registered.execute("call", { query: "test", limit: 1 }, new AbortController().signal), {
      content: [{ type: "text", text: JSON.stringify({ query: "test", results: [{ title: "A", url: "https://a.test", snippet: "snippet" }] }, null, 2) }],
      details: { provider: "exa", resultCount: 1 },
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = previousKey;
  }
});
