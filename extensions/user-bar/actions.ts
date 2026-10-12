/**
 * What clicking one of your sent messages offers: copy it, put it back in the editor at that point
 * (like /tree), or fork a new session from just before it (like /fork).
 *
 * Tree navigation and forking are only available to commands, so the menu runs a hidden
 * `/message-action` command, which Pi executes without starting a model turn.
 */

const COPY = "Copy text";
const EDIT = "Edit and resend";
const FORK = "Fork into a new session";

type Content = string | Array<{ type: string; text?: string }>;

function userText(content: Content): string {
	if (typeof content === "string") return content;
	return content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}

/** The id of the newest user message on the branch with exactly this text (what Pi drew it from). */
export function findUserEntry(branch: ReadonlyArray<any>, text: string): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "message" && entry.message?.role === "user" && userText(entry.message.content ?? "") === text) return entry.id;
	}
	return undefined;
}

export interface MenuDeps {
	findEntry(text: string): string | undefined;
	select(title: string, options: string[]): Promise<string | undefined>;
	copy(text: string): Promise<void>;
	run(command: string): void;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

export async function runMessageMenu(text: string, deps: MenuDeps): Promise<void> {
	const entryId = deps.findEntry(text);
	const choice = await deps.select("Your message", entryId ? [COPY, EDIT, FORK] : [COPY]);
	if (choice === COPY) {
		await deps.copy(text);
		deps.notify(`Copied ${text.length.toLocaleString("en-US")} characters`, "info");
	} else if (choice === EDIT && entryId) {
		deps.run(`/message-action edit ${entryId}`);
	} else if (choice === FORK && entryId) {
		deps.run(`/message-action fork ${entryId}`);
	}
}

export async function runMessageAction(
	args: string,
	ctx: {
		isIdle(): boolean;
		navigateTree(id: string): Promise<unknown>;
		fork(id: string): Promise<unknown>;
		ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
	},
): Promise<void> {
	const [action, id] = args.trim().split(/\s+/);
	if (!id || (action !== "edit" && action !== "fork")) return;
	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the agent to finish, then try again", "warning");
		return;
	}
	if (action === "edit") await ctx.navigateTree(id);
	else await ctx.fork(id);
}
