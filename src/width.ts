import stringWidth from "string-width";

export { stringWidth };

export function charWidth(cp: number): number {
  if (cp >= 0x20 && cp < 0x7f) return 1;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  return stringWidth(String.fromCodePoint(cp));
}

export function clip(s: string, max: number): string {
  let width = 0;
  let i = 0;
  for (const ch of s) {
    const w = charWidth(ch.codePointAt(0)!);
    if (width + w > max) break;
    width += w;
    i += ch.length;
  }
  return i === s.length ? s : s.slice(0, i);
}
