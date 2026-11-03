import util from "node:util";

export function isProcessOutput(e: unknown): boolean {
  return typeof e === "object" && e !== null && "exitCode" in e && "stdout" in e && "stderr" in e;
}

export function formatError(e: unknown, colors = true): string {
  const paint = (s: string): string => (colors ? red(s) : s);
  if (isProcessOutput(e)) return `${paint(`exit ${(e as { exitCode: number | null }).exitCode}`)}\n`;
  if (e instanceof Error) {
    if ((e as NodeJS.ErrnoException).code) return `${paint(`${e.name}: ${e.message}`)}\n`;
    const lines = (e.stack ?? `${e.name}: ${e.message}`)
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("at "));
    return `${paint(lines.slice(0, 8).join("\n").trimEnd())}\n`;
  }
  return `${paint(String(e))}\n`;
}

const withNewline = (s: string): string => (s.endsWith("\n") ? s : `${s}\n`);

// shelljs 的返回值：成功时是 String 子类或带 props 的数组，失败时带 code/stderr。
// showUndefined：表达式语句的结果哪怕 undefined 也打印；声明语句不打印
export function formatResult(value: unknown, colors = true, showUndefined = false): string | null {
  if (value === undefined) return showUndefined ? "undefined\n" : null;
  if (typeof value === "object" && value !== null) {
    const shellish = value as { code?: unknown; stderr?: unknown };
    if (typeof shellish.code === "number" && shellish.code !== 0 && typeof shellish.stderr === "string") {
      return withNewline(shellish.stderr);
    }
    if (value instanceof String) {
      const text = String(value);
      return text ? withNewline(text) : null;
    }
  }
  return `${util.inspect(value, { colors, depth: 4 })}\n`;
}

const red = (s: string): string => `\u001b[31m${s}\u001b[0m`;

export const yellow = (s: string): string => `\u001b[33m${s}\u001b[0m`;
