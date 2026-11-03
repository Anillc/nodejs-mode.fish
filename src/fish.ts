import { spawn, type ChildProcess } from "node:child_process";

export interface Completion {
  text: string;
  desc?: string;
}

// fish 的补全列表：一行一个候选，描述跟在 tab 后面
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

// 让 fish 自己算补全：命令、选项、文件它都知道，还带描述。
// 命令行经由 argv 传，不拼进脚本里
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

// 反引号和 ${ 会拆坏外面那对模板引号，先按 JS 的规矩转义
const forTemplate = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

// zx 的 $`…` 不认反斜杠转义，候选只能用引号包起来（真 shell 也吃这一套）
export function escapeShellWord(word: string): string {
  if (SAFE.test(word)) return word;
  const shell = word.includes("'") ? `$'${word.replace(/[\\']/g, (c) => `\\${c}`)}'` : `'${word}'`;
  return forTemplate(shell);
}

// 命令行停在哪个没闭合的引号里；在引号里补全时不能再套一层引号
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
