import { chmodSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The Codex CLI's public OAuth client, the same one Pi uses for its Codex login.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const EXPIRY_SKEW_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 15_000;

export interface CodexCredentials {
	token: string;
	account?: string;
}

export interface CodexAuthOptions {
	path?: string;
	fetch?: typeof fetch;
	now?: () => number;
}

export class CodexAuthError extends Error {}

export const codexAuthPath = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");

const NOT_SIGNED_IN = "not signed in to Codex (run `codex login`)";

// Refresh tokens are single-use. If a refreshed token cannot be written back, keep it
// here so the same process never spends the old one twice. `spent` is the refresh token
// that was consumed: once the file on disk holds a different one, the disk is newer.
const unsaved = new Map<string, { file: any; spent: string }>();
const inflight = new Map<string, Promise<{ credentials: CodexCredentials; warning?: string }>>();

function readDisk(path: string): any {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function load(path: string): any {
	const pending = unsaved.get(path);
	const disk = readDisk(path);
	if (pending && (!disk?.tokens?.refresh_token || disk.tokens.refresh_token === pending.spent)) return pending.file;
	unsaved.delete(path); // the file moved on (new login, or the Codex CLI refreshed)
	if (!disk?.tokens?.access_token) throw new CodexAuthError(NOT_SIGNED_IN);
	return disk;
}

const credentialsOf = (file: any): CodexCredentials => ({ token: file.tokens.access_token, account: file.tokens.account_id });

function expiresSoon(token: string, now: number): boolean {
	try {
		const exp = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).exp;
		return typeof exp === "number" && exp * 1000 - now < EXPIRY_SKEW_MS;
	} catch {
		return false; // not a readable JWT: rely on the server rejecting it
	}
}

/** Write via a temp file and rename, so Codex never reads a half-written auth.json. */
function saveAtomically(path: string, data: unknown): void {
	// Write through a symlink to its target instead of replacing the link.
	try {
		path = realpathSync(path);
	} catch {}
	let mode = 0o600;
	try {
		mode = statSync(path).mode & 0o777;
	} catch {}
	const temp = `${path}.${process.pid}.tmp`;
	try {
		// Private while the tokens are written; the original mode is restored before the rename.
		writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		chmodSync(temp, mode);
		renameSync(temp, path);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {}
		throw error;
	}
}

async function performRefresh(path: string, staleToken: string, options: CodexAuthOptions) {
	const now = options.now ?? Date.now;
	const file = load(path);
	// The Codex CLI may have refreshed it since we read the file.
	if (file.tokens.access_token !== staleToken && !expiresSoon(file.tokens.access_token, now())) {
		return { credentials: credentialsOf(file) };
	}
	if (!file.tokens.refresh_token) throw new CodexAuthError("Codex login has no refresh token (run `codex login`)");

	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: file.tokens.refresh_token, client_id: CLIENT_ID }),
			signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
		});
	} catch (error) {
		throw new CodexAuthError(`could not reach OpenAI to refresh the Codex login: ${error instanceof Error ? error.message : error}`);
	}
	if (response.status === 400 || response.status === 401) {
		// Another process may have spent this refresh token first; if so, use its result.
		const latest = readDisk(path);
		if (latest?.tokens?.access_token && latest.tokens.access_token !== staleToken && !expiresSoon(latest.tokens.access_token, now())) {
			unsaved.delete(path);
			return { credentials: credentialsOf(latest) };
		}
		throw new CodexAuthError("Codex login expired or was revoked (run `codex login`)");
	}
	if (!response.ok) throw new CodexAuthError(`Codex login refresh failed (HTTP ${response.status})`);
	const issued = await response.json().catch(() => undefined);
	if (typeof issued?.access_token !== "string") throw new CodexAuthError("Codex login refresh returned no access token");

	const next = {
		...file,
		tokens: {
			...file.tokens,
			access_token: issued.access_token,
			...(issued.refresh_token ? { refresh_token: issued.refresh_token } : {}),
			...(issued.id_token ? { id_token: issued.id_token } : {}),
		},
		last_refresh: new Date(now()).toISOString(),
	};
	try {
		saveAtomically(path, next);
		unsaved.delete(path);
		return { credentials: credentialsOf(next) };
	} catch {
		unsaved.set(path, { file: next, spent: file.tokens.refresh_token });
		return {
			credentials: credentialsOf(next),
			warning: "refreshed Codex token could not be saved to auth.json (run `codex login` if Codex stops working)",
		};
	}
}

function refresh(path: string, staleToken: string, options: CodexAuthOptions) {
	let pending = inflight.get(path);
	if (!pending) {
		pending = performRefresh(path, staleToken, options).finally(() => inflight.delete(path));
		inflight.set(path, pending);
	}
	return pending;
}

/**
 * Run `use` with a usable Codex token, refreshing the login first when it is about to
 * expire, or once more if the server rejects it. A rejection right after a refresh is final.
 */
export async function withCodexCredentials<T>(
	use: (credentials: CodexCredentials) => Promise<T>,
	isRejected: (error: unknown) => boolean,
	options: CodexAuthOptions = {},
): Promise<{ value: T; warning?: string }> {
	const path = options.path ?? codexAuthPath();
	let credentials = credentialsOf(load(path));
	let warning: string | undefined;
	let refreshed = false;
	if (expiresSoon(credentials.token, (options.now ?? Date.now)())) {
		({ credentials, warning } = await refresh(path, credentials.token, options));
		refreshed = true;
	}
	try {
		return { value: await use(credentials), warning };
	} catch (error) {
		if (refreshed || !isRejected(error)) throw error;
		const retry = await refresh(path, credentials.token, options);
		return { value: await use(retry.credentials), warning: retry.warning ?? warning };
	}
}
