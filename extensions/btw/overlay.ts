import { copyToClipboard, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, ScrollView, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { BtwThread, type BtwExchange } from "./thread.ts";

/** A temporary view, never a transcript component or persisted custom message. */
export class BtwOverlay implements Component {
  private readonly markdown = new Markdown("", 0, 0, getMarkdownTheme());
  private readonly scroll = new ScrollView(this.markdown, { scrollbar: "hidden", overscroll: "contain" });
  private selected: number | undefined;
  private notice = "";
  private renderedText: string | undefined;
  private disposed = false;

  constructor(
    private readonly thread: BtwThread,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly copy: (text: string) => Promise<void> = copyToClipboard,
  ) {}

  private answers(): BtwExchange[] {
    const answers = [...this.thread.exchanges];
    if (this.thread.current && !answers.includes(this.thread.current)) answers.push(this.thread.current);
    return answers;
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.thread.cancel();
    this.done();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") ||
        matchesKey(data, "return") || matchesKey(data, "space")) {
      this.close();
      return;
    }
    const answers = this.answers();
    const index = Math.min(this.selected ?? answers.length - 1, answers.length - 1);
    if (data === "x") {
      this.thread.clear();
      this.close();
      return;
    }
    if (data === "[" || matchesKey(data, "shift+left") || matchesKey(data, "shift+tab")) {
      this.selected = Math.max(0, index - 1);
      this.scroll.scrollToStart();
    } else if (data === "]" || matchesKey(data, "shift+right") || matchesKey(data, "tab")) {
      const next = Math.min(answers.length - 1, index + 1);
      this.selected = next === answers.length - 1 ? undefined : next;
      this.scroll.scrollToStart();
    } else if (matchesKey(data, "up")) {
      this.scroll.scrollBy(-1);
    } else if (matchesKey(data, "down")) {
      this.scroll.scrollBy(1);
    } else if (matchesKey(data, "pageUp")) {
      this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1));
    } else if (matchesKey(data, "pageDown")) {
      this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
    } else if (data === "c" && answers[index]?.answer) {
      void this.copy(answers[index].answer).then(() => {
        this.notice = "Copied Markdown";
        if (!this.disposed) this.tui.requestRender();
      }).catch(error => {
        this.notice = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
        if (!this.disposed) this.tui.requestRender();
      });
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const maxHeight = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85));
    const answers = this.answers();
    const index = Math.max(0, Math.min(this.selected ?? answers.length - 1, answers.length - 1));
    const exchange = answers[index];
    let text = exchange?.answer || "Waiting for the model…";
    if (exchange?.error) text += `\n\nError: ${exchange.error}`;
    if (exchange?.status === "cancelled") text += "\n\n[Side question cancelled.]";
    if (text !== this.renderedText) {
      this.renderedText = text;
      this.markdown.setText(text);
    }

    // Very small terminals still get a readable, width-safe view without chrome.
    if (width < 5 || maxHeight < 8) {
      const bodyHeight = Math.max(0, maxHeight - 1);
      const bodyLines = this.scroll.render(Math.max(1, width));
      this.scroll.updateLayout(bodyLines.length, bodyHeight, () => this.tui.requestRender());
      return [this.theme.fg("accent", `/btw ${exchange?.question || ""}`),
        ...bodyLines.slice(this.scroll.scrollTop, this.scroll.scrollTop + bodyHeight)]
        .map(line => truncateToWidth(line.replace(/[\r\n\t]/g, " "), width));
    }
    const inner = width - 2;
    const contentWidth = Math.max(1, inner - 2);
    const row = (text: string) => {
      const clipped = truncateToWidth(text.replace(/[\r\n\t]/g, " "), inner);
      return this.theme.fg("border", "│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + this.theme.fg("border", "│");
    };
    const earlier = answers.slice(0, index);
    const previous = earlier.slice(-Math.min(5, Math.max(0, maxHeight - 12)));
    const header = [
      this.theme.fg("border", `╭${"─".repeat(inner)}╮`),
      row(` ${this.theme.fg("accent", this.theme.bold("/btw"))} · ${index + 1}/${answers.length} · ${exchange?.status || "empty"}`),
      row(` ${this.theme.fg("accent", exchange?.question || "No side questions yet")}`),
      ...previous.map((answer, i) => row(this.theme.fg("muted", ` ${earlier.length - previous.length + i + 1}. ${answer.question}`))),
      row(""),
    ];
    const bodyHeight = Math.max(1, maxHeight - header.length - 2);
    const bodyLines = this.scroll.render(contentWidth);
    this.scroll.updateLayout(bodyLines.length, bodyHeight, () => this.tui.requestRender());
    const body = bodyLines.slice(this.scroll.scrollTop, this.scroll.scrollTop + bodyHeight);
    while (body.length < bodyHeight) body.push("");
    const hint = this.notice || (earlier.length > previous.length ? `${earlier.length - previous.length} older · ` : "") +
      "Esc close · ↑↓ scroll · Tab/[ ] history · c copy · x clear";
    return [...header, ...body.map(line => row(` ${line}`)), row(` ${this.theme.fg("muted", hint)}`),
      this.theme.fg("border", `╰${"─".repeat(inner)}╯`)];
  }

  invalidate(): void { this.markdown.invalidate(); }

  dispose(): void {
    this.disposed = true;
    this.thread.cancel();
  }
}
