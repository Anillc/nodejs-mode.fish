import { cursorForward, cursorTo, cursorUp, eraseDown } from "ansi-escapes";
import { charWidth, clip, stringWidth } from "./width.ts";
import type { Token, TokenType } from "./highlight.ts";

export const PROMPT_TEXT = "js \u276f ";
export const PROMPT_ANSI = "\u001b[38;5;39mjs\u001b[0m \u001b[2m\u276f\u001b[0m ";
export const PROMPT_COLS = stringWidth(PROMPT_TEXT);

export const headerLines = (header?: string): string[] => (header ? header.split("\n").slice(0, -1) : []);

export const THEME: Record<TokenType, string> = {
  kw: "38;5;210",
  num: "38;5;180",
  str: "38;5;114",
  tpl: "38;5;114",
  comment: "38;5;244",
  ident: "",
  punct: "38;5;245",
  tag: "1;38;5;39",
  "sh-cmd": "1;38;5;75",
  "sh-flag": "38;5;180",
  "sh-str": "38;5;114",
  "sh-var": "38;5;176",
  "sh-op": "38;5;210",
  "sh-path": "38;5;252",
};

export interface Row {
  start: number;
  end: number;
  col: number;
}

export interface PaintedRow {
  text: string;
  width: number;
}

export function layout(text: string, cols: number, initialCol = 0): Row[] {
  const width = Math.max(cols, 4);
  const rows: Row[] = [{ start: 0, end: 0, col: initialCol }];
  let cur = rows[0]!;
  let col = initialCol;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    if (cp === 10) {
      cur.end = i;
      i++;
      cur = { start: i, end: i, col: 0 };
      rows.push(cur);
      col = 0;
      continue;
    }
    const w = charWidth(cp);
    const size = cp > 0xffff ? 2 : 1;
    if (col + w >= width && i > cur.start) {
      cur.end = i;
      cur = { start: i, end: i, col: 0 };
      rows.push(cur);
      col = 0;
    }
    col += w;
    i += size;
  }
  cur.end = text.length;
  return rows;
}

export function locate(rows: Row[], text: string, index: number): { row: number; col: number } {
  let k = 0;
  for (let r = 0; r < rows.length; r++) if (index >= rows[r]!.start) k = r;
  const row = rows[k]!;
  const end = Math.min(index, row.end);
  return { row: k, col: row.col + stringWidth(text.slice(row.start, end)) };
}

export function paintRow(text: string, tokens: Token[], row: Row): PaintedRow {
  const width = stringWidth(text.slice(row.start, row.end));
  const len = row.end - row.start;
  let styles: string[] | null = null;
  for (const token of tokens) {
    if (token.end <= row.start || token.start >= row.end) continue;
    styles ??= new Array<string>(len).fill("");
    const from = Math.max(token.start, row.start) - row.start;
    const to = Math.min(token.end, row.end) - row.start;
    for (let i = from; i < to; i++) styles[i] = THEME[token.type];
  }
  if (!styles) return { text: text.slice(row.start, row.end), width };

  let out = "";
  let i = 0;
  while (i < len) {
    const style = styles[i]!;
    let j = i + 1;
    while (j < len && styles[j] === style) j++;
    const chunk = text.slice(row.start + i, row.start + j);
    out += style ? `\u001b[${style}m${chunk}\u001b[0m` : chunk;
    i = j;
  }
  return { text: out, width };
}

export interface MenuItem {
  text: string;
  desc?: string;
}

const MENU_ROWS = 8;

const pad = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - stringWidth(text)));

// 补全菜单：带描述时一行一个（像 fish 的 pager），否则按列铺开，选中的那格反色
export function menuLines(items: MenuItem[], selected: number, cols: number): string[] {
  if (!items.length) return [];

  if (items.some((item) => item.desc)) {
    const textCols = Math.min(Math.max(...items.map((item) => stringWidth(item.text))) + 2, cols);
    // 候选可能上百个（git 就这样），窗口跟着选中项走
    const top = Math.max(0, Math.min(selected - MENU_ROWS + 1, items.length - MENU_ROWS));
    const shown = items.slice(top, top + MENU_ROWS);
    const lines = shown.map((item, i) => {
      const text = pad(clip(item.text, textCols), textCols);
      const head = top + i === selected ? `\u001b[7m${text}\u001b[0m` : text;
      const room = cols - textCols - 1;
      const desc = item.desc && room > 2 ? clip(item.desc, room) : "";
      return desc ? `${head}\u001b[2m${desc}\u001b[0m` : head.trimEnd();
    });
    if (top > 0) lines.unshift("…");
    if (top + shown.length < items.length) lines.push("…");
    return lines;
  }

  const colWidth = Math.min(Math.max(...items.map((item) => stringWidth(item.text))) + 2, cols);
  const perRow = Math.max(1, Math.floor(cols / colWidth));
  const shown = items.slice(0, perRow * MENU_ROWS);
  const lines: string[] = [];
  for (let i = 0; i < shown.length; i += perRow) {
    const line = shown
      .slice(i, i + perRow)
      .map((item, k) => {
        const cell = pad(clip(item.text, colWidth), colWidth);
        return i + k === selected ? `\u001b[7m${cell}\u001b[0m` : cell;
      })
      .join("")
      .trimEnd();
    lines.push(line);
  }
  if (items.length > shown.length) lines.push("…");
  return lines;
}

export class Canvas {
  initialCol = 0;
  cols: number;
  private lastCurRow = 0;

  private readonly out: NodeJS.WriteStream;

  constructor(out: NodeJS.WriteStream) {
    this.out = out;
    this.cols = out.columns || 80;
  }

  private toBlockStart(): string {
    return (
      cursorTo(0) + (this.lastCurRow > 0 ? cursorUp(this.lastCurRow) : "") + (this.initialCol > 0 ? cursorForward(this.initialCol) : "")
    );
  }

  draw(rows: PaintedRow[], cursor: { row: number; col: number }, menu: string[] = []): void {
    const lines = rows.length ? rows : [{ text: "", width: 0 }];
    const up = lines.length + menu.length - 1 - cursor.row;
    let s = this.toBlockStart() + eraseDown;
    s += lines.map((r) => r.text).join("\r\n");
    if (menu.length) s += "\r\n" + menu.join("\r\n");
    s += cursorTo(0);
    if (up > 0) s += cursorUp(up);
    if (cursor.col > 0) s += cursorForward(cursor.col);
    this.out.write(s);
    this.lastCurRow = cursor.row;
  }

  finishLine(rows: PaintedRow[]): void {
    this.draw(rows, {
      row: rows.length - 1,
      col: (rows.length === 1 ? this.initialCol : 0) + (rows[rows.length - 1]?.width ?? 0),
    });
    this.out.write("\r\n");
    this.reset();
  }

  get cursorRow(): number {
    return this.lastCurRow;
  }

  reset(): void {
    this.lastCurRow = 0;
  }
}
