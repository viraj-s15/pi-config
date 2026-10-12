import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Diagnostic } from "./report.ts";

export function parseRuffOutput(out: string): Diagnostic[] {
	if (!out.trim()) return [];
	try {
		return (JSON.parse(out) as any[]).map((item) => ({
			line: item.location?.row ?? 1,
			column: item.location?.column ?? 1,
			code: String(item.code ?? "ruff"),
			message: String(item.message ?? ""),
		}));
	} catch {
		return [];
	}
}

/** The project's ruff (a .venv next to it or above), else one on PATH. */
export function findRuff(file: string): string | undefined {
	for (let dir = dirname(file); ; dir = dirname(dir)) {
		for (const venv of [".venv", "venv"]) {
			const bin = join(dir, venv, "bin", "ruff");
			if (existsSync(bin)) return bin;
		}
		if (dirname(dir) === dir) break;
	}
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (dir && existsSync(join(dir, "ruff"))) return join(dir, "ruff");
	}
	return undefined;
}

/** Lint `content` as if it were `file` (fed through stdin, so it can be an older version). */
export function runRuff(ruff: string, file: string, content: string, timeoutMs = 15_000): Promise<Diagnostic[]> {
	return new Promise((resolve) => {
		const child = execFile(ruff, ["check", "--output-format", "json", "--no-fix", "--stdin-filename", file, "-"], { cwd: dirname(file), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (_error, stdout) => resolve(parseRuffOutput(stdout)));
		child.stdin?.end(content);
	});
}
