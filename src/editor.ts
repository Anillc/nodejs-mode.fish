import { isComplete } from "./highlight.ts";
import type { Key } from "./keys.ts";

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
