import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { ActionPalette, type PaletteAction } from "./palette.js";

const SHORTCUT = "ctrl+shift+k";
const COMMAND_HINT = "Insert slash command; press Enter to run";
const ACTION_DRAFT_KEY = Symbol.for("pi-config.extensions.actions.draft-backup");
const INSERTED_COMMAND_KEY = Symbol.for("pi-config.extensions.actions.inserted-command");
const actionDraftState = globalThis as unknown as Record<symbol, unknown>;

function getSavedDraft(): string | undefined {
  const draft = actionDraftState[ACTION_DRAFT_KEY];
  return typeof draft === "string" ? draft : undefined;
}

async function restoreDraft(ctx: Pick<ExtensionCommandContext, "ui"> | Pick<ExtensionContext, "ui">): Promise<void> {
  const draft = getSavedDraft();
  if (draft === undefined) {
    ctx.ui.notify("No saved action draft to restore.", "info");
    return;
  }
  const current = ctx.ui.getEditorText();
  const preserveCurrent = current.length > 0 && current !== actionDraftState[INSERTED_COMMAND_KEY];
  if (preserveCurrent && !await ctx.ui.confirm(
    "Replace current draft?",
    "The current draft will become your saved backup. /actions restore can recover it.",
  )) return;
  ctx.ui.setEditorText(draft);
  if (preserveCurrent) actionDraftState[ACTION_DRAFT_KEY] = current;
  else delete actionDraftState[ACTION_DRAFT_KEY];
  delete actionDraftState[INSERTED_COMMAND_KEY];
  ctx.ui.notify("Previous draft restored.", "info");
}

// These are native commands exposed by Pi 1.1.0's built-in slash-command table.
const BUILTIN_ACTIONS = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Open model selector or choose a provider/model" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "thinking", description: "Open thinking-level selector or set a level" },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
  { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
] as const;

export function buildActionItems(commands: SlashCommandInfo[], canRestore = false): PaletteAction[] {
  const byName = new Map<string, PaletteAction>();
  for (const command of commands) {
    byName.set(command.name, {
      name: command.name,
      label: `/${command.name}`,
      description: command.description ?? "Slash command or prompt template",
      source: command.source,
      shortcut: command.name === "actions" ? "Ctrl+Shift+K" : undefined,
      command: `/${command.name}`,
      hint: COMMAND_HINT,
    });
  }
  for (const builtin of BUILTIN_ACTIONS) {
    if (byName.has(builtin.name)) continue;
    const argumentHint = "argumentHint" in builtin ? builtin.argumentHint : undefined;
    byName.set(builtin.name, {
      name: builtin.name,
      label: `/${builtin.name}${argumentHint ? ` ${argumentHint}` : ""}`,
      description: builtin.description,
      source: "builtin",
      command: `/${builtin.name}${argumentHint ? " " : ""}`,
      hint: argumentHint ? `Optional argument: ${argumentHint}; press Enter to run` : COMMAND_HINT,
    });
  }
  if (canRestore && !byName.has("restore-draft")) {
    byName.set("restore-draft", {
      name: "restore-draft",
      label: "Restore previous draft",
      description: "Restore the draft saved when replacing editor text",
      source: "actions",
      hint: "Restore saved draft",
      action: "restore",
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function selectAction(action: PaletteAction, ctx: Pick<ExtensionCommandContext, "ui"> | Pick<ExtensionContext, "ui">): Promise<void> {
  if (action.action === "restore") {
    await restoreDraft(ctx);
    return;
  }
  if (!action.command) return;
  const draft = ctx.ui.getEditorText();
  if (draft.length > 0) {
    const confirmed = await ctx.ui.confirm(
      "Replace editor draft?",
      "Your current draft will be saved and can be restored with /actions restore.",
    );
    if (!confirmed) return;
    // Picking a second action before running the first must not replace the original backup
    // with the slash command we ourselves inserted.
    if (draft !== actionDraftState[INSERTED_COMMAND_KEY] || getSavedDraft() === undefined) {
      actionDraftState[ACTION_DRAFT_KEY] = draft;
    }
  }
  ctx.ui.setEditorText(action.command);
  actionDraftState[INSERTED_COMMAND_KEY] = action.command;
}

async function openPalette(ctx: ExtensionCommandContext | ExtensionContext, commands: SlashCommandInfo[]): Promise<void> {
  if (ctx.mode !== "tui") return;
  const actions = buildActionItems(commands, getSavedDraft() !== undefined);
  let selection: PaletteAction | null = null;
  await ctx.ui.custom((tui, theme, keybindings, done) => ActionPalette.create({
    tui,
    theme,
    keybindings,
    done: (value: PaletteAction | null) => done(value),
    actions,
    onSelect: (value: PaletteAction) => { selection = value; },
  }), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "80%", minWidth: 32, maxHeight: "70%", margin: 1 },
  });
  if (selection) await selectAction(selection, ctx);
}

export default function actionsExtension(pi: ExtensionAPI) {
  pi.registerCommand("actions", {
    description: "Search commands, prompt templates, and useful actions",
    handler: async (args, ctx) => {
      if (args.trim() === "restore") {
        await restoreDraft(ctx);
        return;
      }
      await openPalette(ctx, pi.getCommands());
    },
  });
  pi.registerShortcut(SHORTCUT, {
    description: "Open the searchable action palette",
    handler: async (ctx) => {
      if (ctx.mode === "tui") await openPalette(ctx, pi.getCommands());
    },
  });
}

export { ActionPalette };
