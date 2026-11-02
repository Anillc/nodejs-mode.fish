import stringWidth from "string-width";

export { stringWidth };

export function charWidth(cp: number): number {
  if (cp >= 0x20 && cp < 0x7f) return 1;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  return stringWidth(String.fromCodePoint(cp));
}
