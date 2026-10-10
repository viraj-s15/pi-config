import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CodexAuthError, codexAuthPath, withCodexCredentials } from "../codex-auth.ts";

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const jwt = (expiresAtMs: number) =>
  `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) })).toString("base64url")}.s`;
const rejected = (error: unknown) => error instanceof Error && error.message === "rejected";

function setup(t: TestContext, accessExpiresAt = NOW + 10 * 86_400_000) {
  const dir = mkdtempSync(join(tmpdir(), "pi-codex-auth-"));
  t.after(() => { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, "auth.json");
  const original = {
    OPENAI_API_KEY: null, auth_mode: "chatgpt", last_refresh: "2026-10-01T00:00:00.000Z",
    tokens: { id_token: "old-id", access_token: jwt(accessExpiresAt), refresh_token: "old-refresh", account_id: "acct-1" },
  };
  writeFileSync(path, JSON.stringify(original, null, 2), { mode: 0o600 });
  const requests: { url: string; body: URLSearchParams }[] = [];
  let response: () => Response = () => Response.json({ access_token: jwt(NOW + 10 * 86_400_000), refresh_token: "new-refresh", id_token: "new-id" });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: new URLSearchParams(init.body as string) });
    return response();
  }) as typeof fetch;
  return {
    path, original, requests, fetchImpl,
    options: { path, fetch: fetchImpl, now: () => NOW },
    onRefresh: (next: () => Response) => { response = next; },
    stored: () => JSON.parse(readFileSync(path, "utf8")),
  };
}

test("a valid token is used as-is, without refreshing or writing the file", async t => {
  const s = setup(t);
  const before = readFileSync(s.path, "utf8");
  const { value, warning } = await withCodexCredentials(async c => c, rejected, s.options);
  assert.equal(value.token, s.original.tokens.access_token);
  assert.equal(value.account, "acct-1");
  assert.equal(warning, undefined);
  assert.equal(s.requests.length, 0);
  assert.equal(readFileSync(s.path, "utf8"), before);
});

test("an expired token is refreshed before use and saved atomically with other fields preserved", async t => {
  const s = setup(t, NOW - 1000);
  const { value } = await withCodexCredentials(async c => c, rejected, s.options);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].url, "https://auth.openai.com/oauth/token");
  assert.equal(s.requests[0].body.get("grant_type"), "refresh_token");
  assert.equal(s.requests[0].body.get("refresh_token"), "old-refresh");
  assert.equal(s.requests[0].body.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  const saved = s.stored();
  assert.equal(value.token, saved.tokens.access_token);
  assert.notEqual(saved.tokens.access_token, s.original.tokens.access_token);
  assert.equal(saved.tokens.refresh_token, "new-refresh");
  assert.equal(saved.tokens.id_token, "new-id");
  assert.equal(saved.tokens.account_id, "acct-1");
  assert.equal(saved.auth_mode, "chatgpt");
  assert.equal(saved.OPENAI_API_KEY, null);
  assert.equal(saved.last_refresh, new Date(NOW).toISOString());
  assert.equal(statSync(s.path).mode & 0o777, 0o600);
});

test("tokens within five minutes of expiry are refreshed; ten minutes is left alone", async t => {
  const soon = setup(t, NOW + 4 * 60_000);
  await withCodexCredentials(async c => c, rejected, soon.options);
  assert.equal(soon.requests.length, 1);
  const later = setup(t, NOW + 10 * 60_000);
  await withCodexCredentials(async c => c, rejected, later.options);
  assert.equal(later.requests.length, 0);
});

test("fields missing from the refresh response keep their previous values", async t => {
  const s = setup(t, NOW - 1000);
  s.onRefresh(() => Response.json({ access_token: jwt(NOW + 86_400_000) }));
  await withCodexCredentials(async c => c, rejected, s.options);
  assert.equal(s.stored().tokens.refresh_token, "old-refresh");
  assert.equal(s.stored().tokens.id_token, "old-id");
});

test("a token the server rejects is refreshed once and the request retried", async t => {
  const s = setup(t);
  let calls = 0;
  const { value } = await withCodexCredentials(async c => {
    if (++calls === 1) throw new Error("rejected");
    return c.token;
  }, rejected, s.options);
  assert.equal(calls, 2);
  assert.equal(s.requests.length, 1);
  assert.equal(value, s.stored().tokens.access_token);
});

test("a rejection after a fresh refresh is final: no second refresh, no loop", async t => {
  const s = setup(t, NOW - 1000);
  let calls = 0;
  await assert.rejects(withCodexCredentials(async () => { calls++; throw new Error("rejected"); }, rejected, s.options), /rejected/);
  assert.equal(calls, 1);
  assert.equal(s.requests.length, 1);
  const retried = setup(t);
  calls = 0;
  await assert.rejects(withCodexCredentials(async () => { calls++; throw new Error("rejected"); }, rejected, retried.options), /rejected/);
  assert.equal(calls, 2);
  assert.equal(retried.requests.length, 1);
});

test("errors that are not token rejections never trigger a refresh", async t => {
  const s = setup(t);
  await assert.rejects(withCodexCredentials(async () => { throw new Error("HTTP 500"); }, rejected, s.options), /HTTP 500/);
  assert.equal(s.requests.length, 0);
});

test("simultaneous callers share one refresh request", async t => {
  const s = setup(t, NOW - 1000);
  const results = await Promise.all([1, 2, 3].map(() => withCodexCredentials(async c => c.token, rejected, s.options)));
  assert.equal(s.requests.length, 1);
  assert.equal(new Set(results.map(r => r.value)).size, 1);
});

test("a token another process already refreshed is picked up without calling the server", async t => {
  const s = setup(t);
  const newer = jwt(NOW + 9 * 86_400_000);
  const { value } = await withCodexCredentials(async c => {
    if (c.token === s.original.tokens.access_token) {
      const file = s.stored();
      file.tokens.access_token = newer;
      writeFileSync(s.path, JSON.stringify(file));
      throw new Error("rejected");
    }
    return c.token;
  }, rejected, s.options);
  assert.equal(value, newer);
  assert.equal(s.requests.length, 0);
});

test("network failures and rejected refresh tokens give actionable errors and leave the file untouched", async t => {
  const offline = setup(t, NOW - 1000);
  const before = readFileSync(offline.path, "utf8");
  const failing = { ...offline.options, fetch: (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as typeof fetch };
  await assert.rejects(withCodexCredentials(async c => c, rejected, failing), (e: unknown) =>
    e instanceof CodexAuthError && /could not reach OpenAI/.test(e.message));
  assert.equal(readFileSync(offline.path, "utf8"), before);

  const revoked = setup(t, NOW - 1000);
  revoked.onRefresh(() => Response.json({ error: "invalid_grant", detail: "secret-body-text" }, { status: 400 }));
  await assert.rejects(withCodexCredentials(async c => c, rejected, revoked.options), (e: unknown) =>
    e instanceof CodexAuthError && /codex login/.test(e.message) && !/secret-body-text/.test(e.message));
  assert.deepEqual(revoked.stored(), revoked.original);

  const down = setup(t, NOW - 1000);
  down.onRefresh(() => new Response("oops", { status: 503 }));
  await assert.rejects(withCodexCredentials(async c => c, rejected, down.options), /HTTP 503/);

  const malformed = setup(t, NOW - 1000);
  malformed.onRefresh(() => Response.json({ nothing: true }));
  await assert.rejects(withCodexCredentials(async c => c, rejected, malformed.options), /no access token/);
  assert.deepEqual(malformed.stored(), malformed.original);
});

test("missing credentials, API-key logins and logins without a refresh token are reported", async t => {
  const s = setup(t);
  rmSync(s.path);
  await assert.rejects(withCodexCredentials(async c => c, rejected, s.options), /codex login/);
  writeFileSync(s.path, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" }));
  await assert.rejects(withCodexCredentials(async c => c, rejected, s.options), /codex login/);
  const file = { ...s.original, tokens: { ...s.original.tokens, access_token: jwt(NOW - 1000), refresh_token: undefined } };
  writeFileSync(s.path, JSON.stringify(file));
  await assert.rejects(withCodexCredentials(async c => c, rejected, s.options), /no refresh token/);
  assert.equal(s.requests.length, 0);
});

test("if the refreshed token cannot be saved, it is still used and not refreshed again this process", async t => {
  const s = setup(t, NOW - 1000);
  chmodSync(join(s.path, ".."), 0o500);
  const first = await withCodexCredentials(async c => c.token, rejected, s.options);
  assert.match(first.warning ?? "", /could not be saved/);
  assert.equal(s.requests.length, 1);
  const second = await withCodexCredentials(async c => c.token, rejected, s.options);
  assert.equal(second.value, first.value);
  assert.equal(s.requests.length, 1, "the one-time refresh token must not be spent twice");
});

test("an existing file's permissions are preserved, not widened or narrowed", async t => {
  const s = setup(t, NOW - 1000);
  chmodSync(s.path, 0o640);
  await withCodexCredentials(async c => c, rejected, s.options);
  assert.equal(statSync(s.path).mode & 0o777, 0o640);
});

test("a symlinked auth.json is updated through the link, not replaced by it", async t => {
  const s = setup(t, NOW - 1000);
  const link = join(join(s.path, ".."), "linked-auth.json");
  symlinkSync(s.path, link);
  await withCodexCredentials(async c => c, rejected, { ...s.options, path: link });
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(JSON.parse(readFileSync(s.path, "utf8")).tokens.refresh_token, "new-refresh");
});

test("losing a refresh race to another process uses the winner's token instead of failing", async t => {
  const s = setup(t, NOW - 1000);
  const winner = jwt(NOW + 9 * 86_400_000);
  const racing = { ...s.options, fetch: (async () => {
    const file = s.stored();
    file.tokens.access_token = winner;
    file.tokens.refresh_token = "winner-refresh";
    writeFileSync(s.path, JSON.stringify(file));
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  }) as typeof fetch };
  const { value } = await withCodexCredentials(async c => c.token, rejected, racing);
  assert.equal(value, winner);
  assert.equal(s.stored().tokens.refresh_token, "winner-refresh", "the winner's file is left alone");
});

test("a login that changed on disk after a failed save replaces the in-memory token", async t => {
  const s = setup(t, NOW - 1000);
  chmodSync(join(s.path, ".."), 0o500);
  const first = await withCodexCredentials(async c => c.token, rejected, s.options);
  assert.match(first.warning ?? "", /could not be saved/);
  chmodSync(join(s.path, ".."), 0o700);
  const relogin = s.stored();
  const fresh = jwt(NOW + 8 * 86_400_000);
  relogin.tokens.access_token = fresh;
  relogin.tokens.refresh_token = "relogin-refresh";
  writeFileSync(s.path, JSON.stringify(relogin));
  const second = await withCodexCredentials(async c => c.token, rejected, s.options);
  assert.equal(second.value, fresh);
  assert.equal(s.requests.length, 1);
});

test("CODEX_HOME relocates the credentials file, as it does for the Codex CLI", t => {
  const saved = process.env.CODEX_HOME;
  t.after(() => { if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved; });
  process.env.CODEX_HOME = "/custom/codex-home";
  assert.equal(codexAuthPath(), "/custom/codex-home/auth.json");
  delete process.env.CODEX_HOME;
  assert.match(codexAuthPath(), /\.codex\/auth\.json$/);
});
