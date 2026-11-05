import { isComplete } from "./highlight.ts";

export type Key =
  | { t: "text"; text: string }
  | { t: "paste"; text: string }
  | { t: "enter" }
  | { t: "tab" }
  | { t: "backspace" }
  | { t: "delete" }
  | { t: "left" }
  | { t: "right" }
  | { t: "up" }
  | { t: "down" }
  | { t: "home" }
  | { t: "end" }
  | { t: "ctrl"; ch: string }
  | { t: "alt"; ch: string };

const CSI_KEYS: Record<string, Key> = {
  A: { t: "up" },
  B: { t: "down" },
  C: { t: "right" },
  D: { t: "left" },
  H: { t: "home" },
  F: { t: "end" },
  "1~": { t: "home" },
  "7~": { t: "home" },
  "4~": { t: "end" },
  "8~": { t: "end" },
  "3~": { t: "delete" },
};

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

export interface Decoder {
  decode(input: Buffer, options?: { stream?: boolean }): string;
}

export class KeyDecoder {
  private buf = "";
  private pasting = false;

  private readonly decoder: Decoder;

  constructor(decoder: Decoder = new TextDecoder()) {
    this.decoder = decoder;
  }

  feed(chunk: Buffer): Key[] {
    this.buf += this.decoder.decode(chunk, { stream: true });
    const keys: Key[] = [];
    for (;;) {
      const key = this.next();
      if (!key) break;
      keys.push(key);
    }
    return keys;
  }

  private next(): Key | null {
    if (this.pasting) {
      const end = this.buf.indexOf(PASTE_END);
      if (end === -1) {
        if (this.buf.length > 1 << 20) this.buf = this.buf.slice(-8);
        return null;
      }
      const text = this.buf.slice(0, end);
      this.buf = this.buf.slice(end + PASTE_END.length);
      this.pasting = false;
      return { t: "paste", text };
    }
    if (!this.buf.length) return null;

    const c = this.buf[0];

    if (c === "\u001b") {
      if (this.buf.startsWith(PASTE_START)) {
        this.buf = this.buf.slice(PASTE_START.length);
        this.pasting = true;
        return this.next();
      }
      if (this.buf.length < 2) return null;
      if (this.buf[1] === "[") {
        let i = 2;
        while (i < this.buf.length && !/[@-~]/.test(this.buf[i]!)) i++;
        if (i >= this.buf.length) return null;
        const seq = this.buf.slice(2, i + 1);
        this.buf = this.buf.slice(i + 1);
        if (seq === "200~") {
          this.pasting = true;
          return this.next();
        }
        return CSI_KEYS[seq] ?? null;
      }
      if (this.buf[1] === "O") {
        if (this.buf.length < 3) return null;
        const seq = this.buf.slice(2, 3);
        this.buf = this.buf.slice(3);
        return CSI_KEYS[seq] ?? null;
      }
      const ch = this.buf[1]!;
      this.buf = this.buf.slice(2);
      return { t: "alt", ch };
    }

    if (c === "\r") {
      this.buf = this.buf.slice(1);
      return { t: "enter" };
    }
    if (c === "\n") {
      this.buf = this.buf.slice(1);
      return { t: "enter" };
    }
    if (c === "\t") {
      this.buf = this.buf.slice(1);
      return { t: "tab" };
    }
    if (c === "\u007f" || c === "\b") {
      this.buf = this.buf.slice(1);
      return { t: "backspace" };
    }

    const code = c.charCodeAt(0);
    if (code < 0x20) {
      this.buf = this.buf.slice(1);
      return { t: "ctrl", ch: String.fromCharCode(code + 96) };
    }

    const cp = this.buf.codePointAt(0)!;
    const size = cp > 0xffff ? 2 : 1;
    const text = this.buf.slice(0, size);
    this.buf = this.buf.slice(size);
    return { t: "text", text };
  }
}

export type EditorAction = "none" | "submit" | "exit" | "interrupt" | "complete";

export class Editor {
  text: string;
  cursor: number;
  history: string[];
  private histIdx = -1;
  private stash = "";

  constructor(initial: string, history: string[]) {
    this.text = initial;
    this.cursor = initial.length;
    this.history = history;
  }

  wordStartBefore(pos: number): number {
    let i = pos;
    while (i > 0 && /\s/.test(this.text[i - 1]!)) i--;
    while (i > 0 && !/[\s|;&<>()]/.test(this.text[i - 1]!)) i--;
    return i;
  }

  handle(key: Key): EditorAction {
    switch (key.t) {
      case "text":
        this.insert(key.text);
        return "none";
      case "paste":
        this.insert(key.text.replace(/\r\n?/g, "\n"));
        return "none";
      case "backspace":
        if (this.cursor > 0) {
          this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
          this.cursor--;
        }
        return "none";
      case "delete":
        this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
        return "none";
      case "left":
        if (this.cursor > 0) this.cursor--;
        return "none";
      case "right":
        if (this.cursor < this.text.length) this.cursor++;
        return "none";
      case "home":
        this.cursor = 0;
        return "none";
      case "end":
        this.cursor = this.text.length;
        return "none";
      case "up":
        this.historyMove(-1);
        return "none";
      case "down":
        this.historyMove(1);
        return "none";
      case "tab":
        return "complete";
      case "enter":
        if (this.text.trim() === "") return "submit";
        if (!isComplete(this.text)) {
          this.insert("\n");
          return "none";
        }
        return "submit";
      case "ctrl":
        return this.ctrl(key.ch);
      case "alt":
        return "none";
    }
  }

  private insert(s: string): void {
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
    this.cursor += s.length;
    this.histIdx = -1;
  }

  private ctrl(ch: string): EditorAction {
    switch (ch) {
      case "c":
        return "interrupt";
      case "x":
        return "exit";
      case "d":
        if (this.text.length === 0) return "exit";
        this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
        return "none";
      case "a":
        this.cursor = 0;
        return "none";
      case "e":
        this.cursor = this.text.length;
        return "none";
      case "b":
        if (this.cursor > 0) this.cursor--;
        return "none";
      case "f":
        if (this.cursor < this.text.length) this.cursor++;
        return "none";
      case "k":
        this.text = this.text.slice(0, this.cursor);
        return "none";
      case "u":
        this.text = this.text.slice(this.cursor);
        this.cursor = 0;
        return "none";
      case "w": {
        const start = this.wordStartBefore(this.cursor);
        this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
        this.cursor = start;
        return "none";
      }
      default:
        return "none";
    }
  }

  private historyMove(delta: number): void {
    if (!this.history.length) return;
    if (this.histIdx === -1) {
      if (delta > 0) return;
      this.stash = this.text;
      this.histIdx = this.history.length - 1;
    } else {
      const next = this.histIdx + delta;
      if (next < 0) {
        this.histIdx = 0;
      } else if (next >= this.history.length) {
        this.histIdx = -1;
        this.text = this.stash;
        this.cursor = this.text.length;
        return;
      } else {
        this.histIdx = next;
      }
    }
    this.text = this.history[this.histIdx] ?? "";
    this.cursor = this.text.length;
  }
}
