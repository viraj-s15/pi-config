import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Question, Answer } from "../types.js";

export interface QuestionResult {
  answers: Answer[];
}

/**
 * Show questions to user in interactive TUI mode
 */
export async function showQuestions(
  questions: Question[],
  ctx: ExtensionContext,
): Promise<QuestionResult | null> {
  // Single question - simpler UI
  if (questions.length === 1) {
    return showSingleQuestion(questions[0], ctx);
  }

  // Multiple questions - tabbed UI
  return showMultipleQuestions(questions, ctx);
}

/**
 * Show a single question
 */
async function showSingleQuestion(
  question: Question,
  ctx: ExtensionContext,
): Promise<QuestionResult | null> {
  // If no options, it's a text input question
  if (!question.options || question.options.length === 0) {
    const answer = await showTextInput(question, ctx);
    if (!answer) return null;
    return {
      answers: [
        {
          question: question.question,
          answer,
          wasCustom: true,
        },
      ],
    };
  }

  // Has options - show selection UI
  const result = await showOptionsSelect(question, ctx);
  if (!result) return null;

  return {
    answers: [
      {
        question: question.question,
        answer: result.value,
        selectedOption: result.selectedOption,
        wasCustom: result.wasCustom,
      },
    ],
  };
}

/**
 * Show text input for a question
 */
async function showTextInput(question: Question, ctx: ExtensionContext): Promise<string | null> {
  const title = question.header || "Question";
  const answer = await ctx.ui.input(title, question.question);
  return answer || null;
}

/**
 * Show options selection for a question
 */
async function showOptionsSelect(
  question: Question,
  ctx: ExtensionContext,
): Promise<{ value: string | string[]; selectedOption?: string; wasCustom: boolean } | null> {
  const otherLabel = "Other (type your answer)";
  const options = [...(question.options || [])].map((opt) => ({
    label: opt.label,
    description: opt.description,
    isOther: false,
  }));
  options.push({ label: otherLabel, description: undefined, isOther: true });

  return ctx.ui.custom<{ value: string | string[]; selectedOption?: string; wasCustom: boolean } | null>(
    (tui, theme, _kb, done) => {
      let optionIndex = 0;
      let editMode = false;
      let cachedLines: string[] | undefined;
      // Multi-select: ticked options, and the typed "Other" answer that ticking Other asks for.
      const multi = question.multiSelect === true;
      const otherIndex = options.length - 1;
      const checked = new Set<number>();
      let customText: string | undefined;

      const submitChecked = () => {
        const values = [...checked].sort((a, b) => a - b)
          .map((i) => (i === otherIndex ? customText : options[i].label))
          .filter((value): value is string => !!value);
        done({ value: values, selectedOption: values.join(", "), wasCustom: checked.has(otherIndex) && !!customText });
      };

      const toggle = (index: number) => {
        optionIndex = index;
        if (index !== otherIndex) {
          if (checked.has(index)) checked.delete(index);
          else checked.add(index);
        } else if (checked.has(otherIndex)) {
          checked.delete(otherIndex);
          customText = undefined;
        } else {
          editMode = true; // ticking Other means typing it
        }
        refresh();
      };

      const editorTheme: EditorTheme = {
        borderColor: (s) => theme.fg("accent", s),
        selectList: {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        },
      };

      const editor = new Editor(tui, editorTheme);
      editor.onSubmit = (value) => {
        const trimmed = value.trim();
        if (multi) {
          editMode = false;
          editor.setText("");
          if (trimmed) {
            customText = trimmed;
            checked.add(otherIndex);
          }
          refresh();
        } else if (trimmed) {
          done({ value: trimmed, wasCustom: true });
        } else {
          editMode = false;
          editor.setText("");
          refresh();
        }
      };

      function refresh() {
        cachedLines = undefined;
        tui.requestRender();
      }

      function handleInput(data: string) {
        if (editMode) {
          if (matchesKey(data, Key.escape)) {
            editMode = false;
            editor.setText("");
            refresh();
            return;
          }
          editor.handleInput(data);
          refresh();
          return;
        }

        if (matchesKey(data, Key.up)) {
          optionIndex = Math.max(0, optionIndex - 1);
          refresh();
          return;
        }

        if (matchesKey(data, Key.down)) {
          optionIndex = Math.min(options.length - 1, optionIndex + 1);
          refresh();
          return;
        }

        if (multi && matchesKey(data, Key.space)) {
          toggle(optionIndex);
          return;
        }

        if (multi && matchesKey(data, Key.enter) && checked.size > 0) {
          submitChecked();
          return;
        }

        if (matchesKey(data, Key.enter)) {
          const selected = options[optionIndex];
          if (selected.isOther) {
            editMode = true;
            refresh();
            return;
          }
          done({
            value: multi ? [selected.label] : selected.label,
            selectedOption: selected.label,
            wasCustom: false,
          });
          return;
        }

        if (matchesKey(data, Key.escape)) {
          done(null);
          return;
        }

        // Quick select with number keys (1-9, 0 for Other)
        if (data.length === 1 && data >= "0" && data <= "9") {
          const index = data === "0" ? options.length - 1 : Number(data) - 1;
          if (index >= 0 && index < options.length) {
            if (multi) {
              toggle(index);
              return;
            }
            optionIndex = index;
            const selected = options[optionIndex];
            if (selected.isOther) {
              editMode = true;
              refresh();
              return;
            }
            done({
              value: selected.label,
              selectedOption: selected.label,
              wasCustom: false,
            });
            return;
          }
        }
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines;

        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateToWidth(s, width));

        add(theme.fg("accent", "─".repeat(width)));

        if (question.header) {
          add(theme.fg("accent", ` ${question.header}`));
        }
        add(theme.fg("text", ` ${question.question}`));
        lines.push("");

        for (let i = 0; i < options.length; i++) {
          const opt = options[i];
          const selected = i === optionIndex;
          const prefix = selected ? theme.fg("accent", "> ") : "  ";
          const color = selected ? "accent" : "text";
          const box = multi ? (checked.has(i) ? theme.fg("accent", "[x] ") : "[ ] ") : "";
          const label = multi && opt.isOther && customText ? `Other: ${customText}` : opt.label;
          add(prefix + box + theme.fg(color, `${i + 1}. ${label}`));
          if (opt.description) {
            add(`     ${theme.fg("muted", opt.description)}`);
          }
        }

        if (editMode) {
          lines.push("");
          add(theme.fg("muted", " Your answer:"));
          for (const line of editor.render(width - 2)) {
            add(` ${line}`);
          }
        }

        lines.push("");
        if (editMode) {
          add(theme.fg("dim", " Enter to submit • Esc to go back"));
        } else {
          add(theme.fg("dim", multi
            ? ` ↑↓ navigate • Space or 1-9 toggle • Enter confirm${checked.size ? ` (${checked.size} selected)` : ""} • Esc cancel`
            : " ↑↓ navigate • 1-9 select • Enter confirm • Esc cancel"));
        }
        add(theme.fg("accent", "─".repeat(width)));

        cachedLines = lines;
        return lines;
      }

      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
        },
        handleInput,
      };
    },
  );
}

/**
 * Show multiple questions in tabbed interface
 */
async function showMultipleQuestions(
  questions: Question[],
  ctx: ExtensionContext,
): Promise<QuestionResult | null> {
  // For now, use simple sequential approach
  // TODO: Implement tabbed UI component
  const answers: Answer[] = [];

  for (const question of questions) {
    const result = await showSingleQuestion(question, ctx);
    if (!result) return null; // User cancelled

    answers.push(result.answers[0]);
  }

  return { answers };
}
