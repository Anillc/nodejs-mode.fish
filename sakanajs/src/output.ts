import util from "node:util";

export function isProcessOutput(e: unknown): boolean {
  return typeof e === "object" && e !== null && "exitCode" in e && "stdout" in e && "stderr" in e;
}

export function formatError(e: unknown, colors = true): string {
  const paint = (s: string): string => (colors ? red(s) : s);
  if (isProcessOutput(e)) {
    const { exitCode, signal } = e as { exitCode: number | null; signal?: string | null };
    const how = exitCode === null || exitCode === undefined ? (signal ? `killed by ${signal}` : "exit unknown") : `exit ${exitCode}`;
    return `${paint(how)}\n`;
  }
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

// zx returns a "disarmed" promise from .text() / .lines(): touching its helpers throws
export function isRunning(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  try {
    const probe = value as { isSettled?: () => boolean };
    return typeof probe.isSettled === "function" && !probe.isSettled();
  } catch {
    return false;
  }
}

// shelljs return values: a String subclass or an array with props when it works, code/stderr when it fails.
// showUndefined: expression statements print even undefined; declarations print nothing
export function formatResult(value: unknown, colors = true, showUndefined = false): string | null {
  if (value === undefined) return showUndefined ? "undefined\n" : null;
  if (typeof value === "object" && value !== null) {
    // a process still running in the background: a full dump of it is noise, and awaiting it would block
    if (isRunning(value)) {
      return `ProcessPromise { ${colors ? yellow("<running>") : "<running>"} }\n`;
    }
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
