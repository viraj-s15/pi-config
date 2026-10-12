import { basename, sep } from "node:path";
import type { Diagnostic } from "./report.ts";

/** Config files that are JSON with comments; a strict parse would flag them wrongly. */
const COMMENTED = /^(tsconfig|jsconfig)(\..*)?\.json$|^(devcontainer|\.?eslintrc|launch|tasks|settings|keybindings|extensions)\.json$/;

/** Parse errors for a .json file, or undefined when the file should not be strictly parsed. */
export function checkJson(path: string, content: string): Diagnostic[] | undefined {
	if (!path.endsWith(".json") || COMMENTED.test(basename(path)) || path.includes(`${sep}.vscode${sep}`)) return undefined;
	try {
		JSON.parse(content);
		return [];
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		const line = Number(/line (\d+)/.exec(text)?.[1] ?? 1);
		const column = Number(/column (\d+)/.exec(text)?.[1] ?? 1);
		return [{ line, column, code: "JSON", message: "The file is not valid JSON." }];
	}
}
