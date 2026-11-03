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
