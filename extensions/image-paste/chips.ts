import { basename } from "node:path";

export interface ImagePathSpan {
  start: number;
  end: number;
  path: string;
  chip: string;
  number: number;
}

const END_RE = /\.(?:png|jpe?g|gif|webp)(?![\w.-])/gi;
const unescape = (value: string) => value.replace(/\\(.)/gs, "$1");
const isStart = (text: string, index: number) => {
  const c = text[index];
  return (c === "/" || (c === "~" && text[index + 1] === "/")) &&
    (index === 0 || /[\s'"(<[=]/.test(text[index - 1]!));
};

/** Find candidate absolute and home-relative image paths without altering the editor source. */
export function findImagePathSpans(text: string): ImagePathSpan[] {
  const spans: ImagePathSpan[] = [];
  let consumed = 0;
  for (const match of text.matchAll(END_RE)) {
    const end = match.index! + match[0].length;
    if (end <= consumed) continue;
    const lower = Math.max(consumed, end - 1024);
    const starts: number[] = [];
    for (let i = lower; i < end; i++) if (isStart(text, i)) starts.push(i);
    let start = starts[0] ?? -1;
    // Paths pasted by terminals escape spaces. Unescaped prose between candidates means
    // the later candidate is the actual path, not one giant path containing the sentence.
    for (let i = 1; i < starts.length; i++) {
      if (/\s/.test(text.slice(start, starts[i]!))) start = starts[i]!;
    }
    if (start < 0) continue;
    let actualStart = start;
    let actualEnd = end;
    const quote = text[start - 1];
    const quoted = (quote === "'" || quote === '"') && text[end] === quote;
    if (quoted) { actualStart--; actualEnd++; }
    const raw = text.slice(start, end);
    const path = unescape(raw);
    const number = spans.length + 1;
    spans.push({ start: actualStart, end: actualEnd, path, chip: `[Image ${number} · ${basename(path)} ×]`, number });
    consumed = actualEnd;
  }
  return spans;
}

export interface ImageChipProjection { text: string; spans: ImagePathSpan[]; }

/** Display-only projection: callers keep and submit the original source text. */
export function projectImagePathChips(text: string): ImageChipProjection {
  const spans = findImagePathSpans(text);
  let output = "";
  let cursor = 0;
  for (const span of spans) {
    output += text.slice(cursor, span.start) + span.chip;
    cursor = span.end;
  }
  return { text: output + text.slice(cursor), spans };
}

export function removeImagePathAt(text: string, offset: number): string {
  const span = findImagePathSpans(text).find((item) => offset >= item.start && offset < item.end);
  return span ? text.slice(0, span.start) + text.slice(span.end) : text;
}

/** Map a position in the display projection to its source-string position. */
export function projectedOffsetToSource(offset: number, spans: ImagePathSpan[]): number {
  let delta = 0;
  for (const span of spans) {
    const projectedStart = span.start - delta;
    const projectedEnd = projectedStart + span.chip.length;
    if (offset < projectedStart) return offset + delta;
    if (offset < projectedEnd) return offset < projectedStart + span.chip.length / 2 ? span.start : span.end;
    if (offset === projectedEnd) return span.end;
    delta += span.end - span.start - span.chip.length;
  }
  return offset + delta;
}
