import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Key,
  SelectList,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type KeyId,
  type Keybindings,
  type KeybindingsManager,
  type SelectItem,
  type TUI,
} from "@earendil-works/pi-tui";

const ROSE = "\x1b[38;2;255;126;182m"; // the /usage border colour
const RESET = "\x1b[0m";

export interface PaletteAction {
  name: string;
  label: string;
  description: string;
  source: string;
  shortcut?: string;
  hint?: string;
  command?: string;
  action?: "restore";
}

export class ActionPalette {
  static create({ tui, theme, keybindings, done, actions, onSelect }: {
    tui: Pick<TUI, "requestRender">;
    theme: Pick<Theme, "fg" | "bold">;
    keybindings: Pick<KeybindingsManager, "matches">;
    done: (value: PaletteAction | null) => void;
    actions: PaletteAction[];
    onSelect: (value: PaletteAction) => void;
  }) {
    const container = new Container();
    const input = new Input({
      prompt: `${theme.fg("accent", "Search: ")}`,
      placeholder: "commands, prompts, actions…",
      placeholderStyle: (text) => theme.fg("dim", text),
    });
    const limit = 7;
    let list: SelectList;
    let finished = false;

    const finish = (value: PaletteAction | null) => {
      if (finished) return;
      finished = true;
      if (value) onSelect(value);
      done(value);
    };

    const buildList = () => {
      const query = input.getValue().trim().toLowerCase();
      const filtered = actions.filter((action: PaletteAction) =>
        `${action.name} ${action.label} ${action.description} ${action.source}`.toLowerCase().includes(query),
      );
      const options: SelectItem[] = filtered.map((action: PaletteAction) => ({
        value: action.name,
        label: action.label,
        description: [action.description, action.source, action.shortcut, action.hint].filter(Boolean).join(" · "),
      }));
      const byName = new Map(filtered.map((action: PaletteAction) => [action.name, action]));
      list = new SelectList(options, Math.min(limit, Math.max(1, options.length)), {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.fg("accent", text),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("dim", text),
        noMatch: () => theme.fg("warning", "  No matching actions"),
      });
      list.onSelect = (item: SelectItem) => finish(byName.get(item.value) ?? null);
      list.onCancel = () => finish(null);
      container.clear();
      container.addChild(input);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "↑↓ select · enter insert/replace · esc close"), 1, 0));
    };

    input.onEscape = () => finish(null);
    buildList();
    input.focused = true;

    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      // Same frame as /usage: a rose rounded box whose rows are padded to the full width, so the
      // chat underneath cannot show through the gaps the list leaves.
      render: (width: number) => {
        const inner = Math.max(10, width - 2);
        const edge = (text: string) => `${ROSE}${text}${RESET}`;
        const title = " Actions ";
        const row = (content: string) => {
          const text = truncateToWidth(content, inner);
          return `${edge("│")}${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))}${edge("│")}`;
        };
        return [
          `${edge("╭─")}${ROSE}\x1b[1m${title}${RESET}${edge("─".repeat(Math.max(0, inner - 1 - title.length)) + "╮")}`,
          ...container.render(Math.max(1, inner - 2)).map((line) => row(` ${line}`)),
          edge(`╰${"─".repeat(inner)}╯`),
        ];
      },
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        const matches = (key: KeyId, binding: keyof Keybindings) => matchesKey(data, key) || keybindings.matches(data, binding);
        if (matches(Key.escape, "tui.select.cancel")) {
          finish(null);
          return;
        }
        if (matches(Key.up, "tui.select.up") || matches(Key.down, "tui.select.down") || matches(Key.pageUp, "tui.select.pageUp") || matches(Key.pageDown, "tui.select.pageDown") || matches(Key.enter, "tui.select.confirm")) {
          list.handleInput(data);
          tui.requestRender();
          return;
        }
        input.handleInput(data);
        buildList();
        tui.requestRender();
      },
    };
  }
}
