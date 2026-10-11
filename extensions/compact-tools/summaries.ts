const clean = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").trim();
const preview = (value: unknown) => {
	const lines = String(value ?? "").trim().split("\n");
	const first = (lines[0] ?? "").replace(/\s+/g, " ").trim();
	return lines.length > 1 ? `${first} …` : first;
};

function parseTests(output: string): string | undefined {
	const plain = clean(output);
	const nodeTests = plain.match(/^\s*ℹ\s*tests\s+(\d+)\s*$/im)?.[1];
	const nodePass = plain.match(/^\s*ℹ\s*pass\s+(\d+)\s*$/im)?.[1];
	const nodeFail = plain.match(/^\s*ℹ\s*fail\s+(\d+)\s*$/im)?.[1];
	if (nodeTests !== undefined && nodePass !== undefined && nodeFail !== undefined
		&& Number(nodeTests) === Number(nodePass) + Number(nodeFail)) {
		return `Tests ${nodePass} passed ${nodeFail} failed`;
	}

	const summaries = [
		// Jest: Tests: 2 failed, 176 passed, 178 total (either counter order).
		/Tests:\s*(?:(\d+)\s+failed\s*,\s*(\d+)\s+passed|(\d+)\s+passed\s*,\s*(\d+)\s+failed)\s*,\s*\d+\s+total/i,
		// Vitest/Jest complete summary with a reported total, including failures first.
		/Tests\s+(?:(\d+)\s+failed\s*[,|·]\s*(\d+)\s+passed|(\d+)\s+passed\s*[,|·]\s*(\d+)\s+failed)\s*\((\d+)\)/i,
		// Pytest: 2 failed, 176 passed in 1.23s (or inverse order).
		/(?:(\d+)\s+failed\s*,\s*(\d+)\s+passed|(\d+)\s+passed\s*,\s*(\d+)\s+failed)\s+in\s+\d+(?:\.\d+)?s/i,
	];
	for (const pattern of summaries) {
		const match = plain.match(pattern);
		if (!match) continue;
		const failed = match[1] ?? match[4] ?? "0";
		const passed = match[2] ?? match[3] ?? "0";
		const total = match[5];
		if (total !== undefined && Number(total) !== Number(passed) + Number(failed)) continue;
		return `Tests ${passed} passed ${failed} failed`;
	}

	// Complete pass-only summaries may report passes, but never infer an unobserved zero failures.
	const passedWithTotal = plain.match(/Tests(?:\s*:)?\s+(\d+)\s+passed\s*,\s*\1\s+total/i)
		?? plain.match(/Tests\s+(\d+)\s+passed\s*\((\d+)\)/i);
	if (passedWithTotal) return `Tests ${passedWithTotal[1]} passed`;
	const passedOnly = plain.match(/^\s*(?:(?:Tests?\s+))?(\d+)\s+passed(?:\s+in\s+\d+(?:\.\d+)?s)?\s*$/im);
	if (passedOnly && !/\bfailed\b/i.test(plain)) return `Tests ${passedOnly[1]} passed`;
	return undefined;
}

/**
 * Split a shell line into the commands it runs, ignoring anything inside quotes.
 * Redirections stay on their command, pipes and `&`/`;`/`&&`/`||` separate commands, and
 * `$(...)` or backticks make the whole line "too complex to read" (undefined).
 */
function executableSegments(command: string): string[] | undefined {
	const segments: string[] = [];
	let current = "";
	let quote = "";
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (quote) {
			current += char;
			if (char === "\\" && quote !== "'") current += command[++i] ?? "";
			else if (char === quote) quote = "";
			continue;
		}
		if (char === "'" || char === '"') { quote = char; current += char; continue; }
		if (char === "`") return undefined;
		if (char === "$" && command[i + 1] === "(") return undefined;
		const next = command[i + 1];
		const redirectAmpersand = char === "&" && (command[i - 1] === ">" || command[i - 1] === "<" || next === ">");
		if (char === ";" || char === "\n" || char === "|" || (char === "&" && !redirectAmpersand)) {
			segments.push(current.trim()); current = "";
			if ((char === "&" || char === "|") && next === char) i++;
			continue;
		}
		current += char;
	}
	if (quote) return undefined;
	segments.push(current.trim());
	return segments.filter(Boolean);
}

const LEADING_KEYWORDS = new Set(["time", "then", "do", "else", "elif", "if", "!", "exec", "command"]);
const REDIRECT_WITH_TARGET = /^(?:\d*|&)(?:>>?|<)$/; // `>` `2>` `>>` `&>`: the next word is the file
const REDIRECT_COMPLETE = /^(?:\d*|&)(?:>>?|<)(?:&\d+|\S+)$/; // `2>&1` `>/tmp/x`

/** The words of one command: quotes removed, redirections dropped, `VAR=1`/`time`/`then` prefixes skipped. */
function commandWords(segment: string): string[] | undefined {
	const raw: string[] = [];
	let word = "";
	let quote = "";
	let quoted = false;
	const flush = () => { if (word || quoted) raw.push(quoted ? `\u0000${word}` : word); word = ""; quoted = false; };
	for (let i = 0; i < segment.length; i++) {
		const char = segment[i]!;
		if (quote) {
			if (char === "\\" && quote !== "'") word += segment[++i] ?? "";
			else if (char === quote) quote = "";
			else word += char;
		} else if (char === "'" || char === '"') { quote = char; quoted = true; }
		else if (/\s/.test(char)) flush();
		else word += char;
	}
	if (quote) return undefined;
	flush();
	// A leading NUL marks a word that was quoted, so a quoted ">" is text and not a redirection.
	const words: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i]!;
		if (item.startsWith("\u0000")) { words.push(item.slice(1)); continue; }
		if (REDIRECT_WITH_TARGET.test(item)) { i++; continue; }
		if (REDIRECT_COMPLETE.test(item)) continue;
		words.push(item);
	}
	while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || LEADING_KEYWORDS.has(words[0]!))) words.shift();
	return words;
}

function isTestCommand(command: string): boolean {
	const segments = executableSegments(command);
	if (!segments) return false;
	return segments.some((segment) => {
		const words = commandWords(segment);
		if (!words?.length) return false;
		const s = words.join(" ");
		return /^(?:(?:npm|pnpm|yarn|bun) (?:run )?test\b|(?:npx|bunx) (?:--\S+ )*?(?:vitest|jest)\b|(?:vitest|jest|pytest)\b|python(?:\d+(?:\.\d+)*)? -m pytest\b|node (?:--\S+ )*(?:tests\/run\.mjs|--test\b.*))/i.test(s);
	});
}

function gitAction(command: string): "commit" | "push" | undefined {
	const segments = executableSegments(command);
	if (!segments) return undefined;
	for (const segment of segments) {
		const words = commandWords(segment);
		if (words?.[0] === "git" && (words[1] === "commit" || words[1] === "push")) return words[1];
	}
	return undefined;
}

export function operationLabel(tool: string, args: Record<string, any>): string {
	if (tool !== "bash") return preview(Object.values(args ?? {}).find((v) => typeof v === "string") ?? tool);
	const command = String(args.command ?? "");
	if (isTestCommand(command)) return "Tests";
	const action = gitAction(command);
	if (action === "commit") return "Git commit";
	if (action === "push") return "Git push";
	return preview(command);
}

export function summarizeOperation(tool: string, args: Record<string, any>, resultText: string, isError: boolean): string {
	const command = String(args.command ?? "");
	const output = clean(resultText);
	if (tool === "bash") {
		const exitCode = output.match(/(?:Command\s+)?exited\s+with\s+code\s+(\d+)/i)?.[1]
			?? output.match(/(?:^|\n)\s*exit(?:ed)?\s+code\s*[:=]?\s*([1-9]\d*)/i)?.[1];
		if (isTestCommand(command) && (isError || (exitCode !== undefined && Number(exitCode) !== 0))) {
			return `Tests failed${exitCode ? ` (exit code ${exitCode})` : ""}`;
		}
		if (!isError && isTestCommand(command) && exitCode === undefined) {
			const tests = parseTests(output);
			if (tests) return tests;
		}
		if (!isError && gitAction(command) === "commit") {
			const commit = output.match(/\[[^\]]+\s+([0-9a-f]{7,40})\]/i);
			const files = output.match(/(\d+)\s+files? changed/i);
			if (commit) return `Git commit ${commit[1]}${files ? ` · ${files[1]} files` : ""}`;
		}
		if (!isError && gitAction(command) === "push") {
			const destination = output.match(/^To\s+(.+)$/m)?.[1];
			const ref = output.match(/^\s*[0-9a-f]+\.\.[0-9a-f]+\s+(.+)$/im)?.[1]?.trim();
			const pushSegment = executableSegments(command)?.map(commandWords).find((words) => words?.[0] === "git" && words[1] === "push");
			const remote = pushSegment?.slice(2).find((word) => !word.startsWith("-"));
			if (destination || remote) return `Git push ${destination ?? remote}${ref ? ` · ${ref}` : ""}`;
		}
		return isTestCommand(command) ? "Tests" : preview(command);
	}
	if (isError) return "";
	if (tool === "read") {
		if (!output) return "";
		const lines = output.split("\n").length;
		return `Read ${String(args.path ?? args.file_path ?? "")} · ${lines} ${lines === 1 ? "line" : "lines"}`;
	}
	if (tool === "edit") {
		const count = output.match(/Successfully replaced\s+(\d+)\s+block\(s\)/i)?.[1]
			?? output.match(/(?:Applied|Updated|Replaced)\s+(\d+)\s+(?:edits?|changes?|blocks?)/i)?.[1];
		return count ? `Updated ${String(args.path ?? args.file_path ?? "")} · ${count} ${Number(count) === 1 ? "edit" : "edits"}` : "";
	}
	if (tool === "write") {
		if (!/^Successfully wrote to\s+/i.test(output) || typeof args.content !== "string") return "";
		const bytes = new TextEncoder().encode(args.content).length;
		return `Wrote ${String(args.path ?? args.file_path ?? "")} · ${bytes} bytes`;
	}
	if (tool === "grep") {
		const pattern = String(args.pattern ?? "");
		if (!output || /^(?:no matches found|no matches)$/i.test(output)) return `Search ${pattern} · no matches`;
		const matches = output.split("\n").filter((line) => /^.+:\d+: /.test(line)).length;
		return matches ? `Search ${pattern} · ${matches} ${matches === 1 ? "match" : "matches"}` : "";
	}
	if (tool === "find") {
		const label = `Find ${String(args.pattern ?? "*")}`;
		if (!output || /^(?:no matches found|no matches|no files found matching pattern)$/i.test(output)) return `${label} · no matches`;
		// Pi appends a blank line and a bracketed result/byte-limit notice. That is not a file.
		const notice = /\n\n\[\d+(?:\.\d+)?(?:\s*[KMGT]?B)?\s+(?:results\s+)?limit reached[^\]]*\]$/i;
		const limited = notice.test(output);
		const paths = output.replace(notice, "").split("\n").filter(line => line.trim()).length;
		return `${label} · ${paths} ${paths === 1 ? "path" : "paths"} shown${limited ? " · limited" : ""}`;
	}
	if (tool === "ls") return `List ${String(args.path ?? ".")}`;
	return preview(Object.values(args ?? {}).find((v) => typeof v === "string") ?? tool);
}
