import { spawn, type ChildProcess } from "node:child_process";

export interface Completion {
  text: string;
  desc?: string;
}

// fish's completion list: one candidate per line, the description after a tab
export function parseCompletions(stdout: string, limit = 200): Completion[] {
  const items: Completion[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    const text = (tab === -1 ? line : line.slice(0, tab)).trimEnd();
    if (!text) continue;
    items.push(tab === -1 ? { text } : { text, desc: line.slice(tab + 1).trim() });
    if (items.length >= limit) break;
  }
  return items;
}

// let fish compute the completions: it knows commands, flags and files, with descriptions.
// The command line goes through argv, never spliced into a script
export function shellCompletions(line: string, timeout = 2000): Promise<Completion[]> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("fish", ["-c", 'complete -C "$argv[1]"', "--", line], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve([]);
      return;
    }
    let buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (buf += chunk));
    const timer = setTimeout(() => child.kill(), timeout);
    child.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseCompletions(buf));
    });
  });
}

const SAFE = /^[\w/.\-@:=]+$/;

// backticks and ${ would break the surrounding template quotes, so escape them the JS way first
const forTemplate = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

// zx's $`…` does not accept backslash escapes, so candidates are wrapped in quotes (real shells eat that too)
export function escapeShellWord(word: string): string {
  if (SAFE.test(word)) return word;
  const shell = word.includes("'") ? `$'${word.replace(/[\\']/g, (c) => `\\${c}`)}'` : `'${word}'`;
  return forTemplate(shell);
}

// which quote the command line is still inside; completing inside a quote must not add another layer
export function openQuote(line: string): "'" | '"' | null {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    }
  }
  return quote;
}
