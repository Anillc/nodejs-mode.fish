import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { cursorDown, cursorTo, cursorUp, eraseDown } from "ansi-escapes";
import { args } from "./args.ts";
import { Editor } from "./editor.ts";
import { Remote } from "./remote.ts";
import { KeyDecoder } from "./keys.ts";
import { highlight } from "./highlight.ts";
import { Canvas, headerLines, layout, locate, menuLines, paintRow, PROMPT_ANSI, PROMPT_COLS } from "./render.ts";
import { applyEnv, stateCode } from "./state.ts";
import { formatError, yellow } from "./output.ts";
import { stringWidth } from "./width.ts";

const out = process.stdout;
const inp = process.stdin;

const CONTINUE = 42;
// 连不上 daemon：fish 收到它会清掉残留、重启 daemon，再重跑这一轮
const CONNECT_FAILED = 43;

function requireSocket(): string {
  const v = args.socket;
  if (!v) {
    process.stderr.write("nodejs-mode: this repl needs --socket (daemon mode only)\n");
    process.exit(2);
  }
  return v;
}

const socketPath = requireSocket();
const initialCwd = process.cwd();
const initialEnv = { ...process.env };

function writeState(): void {
  if (!args.state) return;
  try {
    const code = stateCode(initialCwd, initialEnv);
    if (code.trim()) fs.writeFileSync(args.state, `${code}\n`);
  } catch {
    /* state is best effort */
  }
}

let lastByte = 10;
const rawWrite = out.write.bind(out) as (...args: unknown[]) => boolean;
(out as unknown as { write: (...args: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
  const ok = rawWrite(chunk, ...rest);
  const s = typeof chunk === "string" ? chunk : String(chunk);
  if (s.length) lastByte = s.charCodeAt(s.length - 1);
  return ok;
};

function ensureNewline(): void {
  if (lastByte !== 10) out.write("\r\n");
}

const histDir = path.join(process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? ".", ".local/state"), "nodejs-mode");
const histFile = path.join(histDir, "history.json");

function loadHistory(): string[] {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(histFile, "utf8"));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-500) : [];
  } catch {
    return [];
  }
}

function saveHistory(h: string[]): void {
  try {
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(histFile, JSON.stringify(h.slice(-500)));
  } catch {
    /* history is best effort */
  }
}

function seedCode(s: string): string {
  if (!s) return "";
  const body = s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return `$\u0060${body}\u0060`;
}

function pathCompletion(text: string, cursor: number): string | null {
  let start = cursor;
  while (start > 0 && !/[\s'"`|;&<>()]/.test(text[start - 1]!)) start--;
  const word = text.slice(start, cursor);
  if (!word) return null;
  const cut = word.lastIndexOf("/");
  const dir = cut === -1 ? "" : word.slice(0, cut + 1);
  const base = word.slice(dir.length);
  let entries: string[];
  try {
    entries = fs.readdirSync(path.resolve(process.cwd(), dir || "."));
  } catch {
    return null;
  }
  const matches = entries.filter((e) => e.startsWith(base)).sort();
  if (!matches.length) return null;
  let common = matches[0]!;
  for (const m of matches) {
    while (!m.startsWith(common)) common = common.slice(0, -1);
  }
  if (matches.length === 1) {
    let isDir = false;
    try {
      isDir = fs.statSync(path.resolve(process.cwd(), dir + common)).isDirectory();
    } catch {
      /* ignore */
    }
    common += isDir ? "/" : "";
  }
  if (common === base) return null;
  return dir + common;
}

let remote: Remote;
try {
  remote = await Remote.connect(socketPath);
} catch (e) {
  // 把这次已经画上去的头部 + prompt 一起擦掉，别在屏幕上留半截
  const up = headerLines(args.header).length;
  out.write(`${cursorTo(0)}${up > 0 ? cursorUp(up) : ""}${eraseDown}`);
  out.write(`${yellow("nodejs-mode: cannot reach the daemon")}\r\n`);
  out.write(`${yellow(`  socket: ${socketPath}`)}\r\n`);
  out.write(`${yellow(`  ${e instanceof Error ? e.message : String(e)}`)}\r\n`);
  out.write(`${yellow("  restarting it...")}\r\n`);
  inp.setRawMode?.(false);
  process.exit(CONNECT_FAILED);
}

let activeRemote: Remote | null = null;

async function runCode(code: string): Promise<void> {
  if (remote.isClosed) {
    out.write(`${yellow("nodejs-mode: lost the daemon, restarting it...")}\n`);
    inp.setRawMode?.(false);
    process.exit(CONNECT_FAILED);
  }
  inp.setRawMode?.(false);
  activeRemote = remote;
  try {
    await remote.eval(code, process.cwd(), { ...process.env }, (_stream, data) => {
      ensureNewline();
      out.write(data);
    });
    // daemon 里的 cwd/env 才是真的：抄回本地，退出时的 state 才写得对
    const s = remote.lastState;
    if (s) {
      try {
        process.chdir(s.cwd);
      } catch {
        /* 目录没了就留在原地 */
      }
      applyEnv(s.env);
    }
  } catch (e) {
    ensureNewline();
    out.write(formatError(e));
  } finally {
    activeRemote = null;
    inp.setRawMode?.(true);
  }
}

process.on("SIGINT", () => {
  activeRemote?.sendAbort();
});
process.on("SIGTSTP", () => {
  /* no job control in js mode */
});

if (!inp.isRaw) inp.setRawMode(true);

const canvas = new Canvas(out);
canvas.initialCol = PROMPT_COLS;
const editor = new Editor(seedCode(args.seed ?? ""), loadHistory());
const history = editor.history;

function redraw(): void {
  const text = editor.text;
  const tokens = highlight(text);
  const rows = layout(text, canvas.cols, canvas.initialCol);
  canvas.draw(
    rows.map((r) => paintRow(text, tokens, r)),
    locate(rows, text, editor.cursor),
    menu ? menuLines(menu.items, menu.selected, canvas.cols) : [],
  );
}

let prepainted = args.prepainted === true;

function startLine(): void {
  ensureNewline();
  if (prepainted) {
    prepainted = false;
  } else {
    const lines = headerLines(args.header);
    if (lines.length) out.write(`${lines.join("\r\n")}\r\n`);
    out.write(PROMPT_ANSI);
  }
  canvas.initialCol = PROMPT_COLS;
  canvas.reset();
  redraw();
}

// Tab：单个候选直接补；多个补到公共前缀，补不动就把候选列在输入行下面，再按 Tab 循环选中
let menu: { items: string[]; selected: number; start: number; length: number; text: string; cursor: number } | null = null;

function applyCompletion(start: number, length: number, fill: string): void {
  const text = editor.text;
  editor.text = text.slice(0, start) + fill + text.slice(start + length);
  editor.cursor = start + fill.length;
}

async function complete(): Promise<void> {
  const text = editor.text;
  const cursor = editor.cursor;

  if (menu && menu.text === text && menu.cursor === cursor) {
    menu.selected = (menu.selected + 1) % menu.items.length;
    const item = menu.items[menu.selected]!;
    applyCompletion(menu.start, menu.length, item);
    menu.length = item.length;
    menu.text = editor.text;
    menu.cursor = editor.cursor;
    redraw();
    return;
  }
  menu = null;

  const word = /[\w$]*$/.exec(text.slice(0, cursor))![0];
  const start = cursor - word.length;
  const member = start > 0 && text[start - 1] === ".";

  if (member) {
    const base = /[\w$.]+$/.exec(text.slice(0, start - 1))?.[0];
    if (!base) return;
    completeNames(start, word, await remote.complete(word, base));
    return;
  }

  // 整段 token（带引号/斜杠的那截）用来判断是不是在补路径
  let tokenStart = start;
  while (tokenStart > 0 && !/[\s'"`|;&<>()]/.test(text[tokenStart - 1]!)) tokenStart--;
  const token = text.slice(tokenStart);
  if (token.includes("/") || token.startsWith(".") || token.startsWith("~")) {
    completePath(text, tokenStart, token);
    return;
  }

  // 空词不列，否则一次 Tab 就把所有全局名刷出来
  if (!word) return;
  const items = await remote.complete(word);
  if (items.length) completeNames(start, word, items);
  else completePath(text, tokenStart, token);
}

function completeNames(start: number, word: string, items: string[]): void {
  if (!items.length) return;
  let fill = items[0]!;
  for (const item of items) {
    while (!item.startsWith(fill)) fill = fill.slice(0, -1);
  }
  if (fill.length > word.length) {
    applyCompletion(start, word.length, fill);
    redraw();
    return;
  }
  // 和 fish 一样：菜单一打开就选中第一个，并落进输入行
  applyCompletion(start, word.length, items[0]!);
  menu = { items, selected: 0, start, length: items[0]!.length, text: editor.text, cursor: editor.cursor };
  redraw();
}

function completePath(text: string, start: number, token: string): void {
  const filled = pathCompletion(text, editor.cursor);
  if (!filled) return;
  applyCompletion(start, token.length, filled);
  redraw();
}

function leave(code: number): never {
  // 回到本轮头部第一行，把头部 + 输入行整块擦掉，交给 fish 重画
  const headerCount = headerLines(args.header).length;
  const up = canvas.cursorRow + headerCount;
  out.write(`${cursorTo(0)}${up > 0 ? cursorUp(up) : ""}${eraseDown}`);
  // repaint 会从光标往上数 (prompt 行数-1) 行重画，所以把光标放在最后一行
  out.write(`${cursorTo(0)}${headerCount > 0 ? cursorDown(headerCount) : ""}`);
  inp.setRawMode?.(false);
  writeState();
  process.exit(code);
}

out.on("resize", () => {
  canvas.cols = out.columns || 80;
  redraw();
});

startLine();

const decoder = new KeyDecoder();
for await (const chunk of inp) {
  for (const key of decoder.feed(chunk as Buffer)) {
    // 菜单开着时回车只确认选择（和 fish 一样），要再按一次才执行
    if (menu && key.t === "enter") {
      menu = null;
      redraw();
      continue;
    }
    const action = editor.handle(key);
    if (action === "complete") {
      await complete();
      continue;
    }
    menu = null;
    if (action === "submit") {
      const code = editor.text;
      if (!code.trim()) {
        // 空行回车：换一行，让当前这一行留在 scrollback，再画一个新块
        out.write("\r\n");
        inp.setRawMode?.(false);
        writeState();
        process.exit(CONTINUE);
      }
      const tokens = highlight(code);
      canvas.finishLine(layout(code, canvas.cols, canvas.initialCol).map((r) => paintRow(code, tokens, r)));
      history.push(code);
      saveHistory(history);
      await runCode(code);
      ensureNewline();
      inp.setRawMode?.(false);
      writeState();
      process.exit(CONTINUE);
    } else if (action === "exit") {
      leave(0);
    } else if (action === "interrupt") {
      // 像 fish 那样：保留已输入的内容，光标移到行尾，补一个 ^C，再换行
      const text = editor.text;
      const rows = layout(text, canvas.cols, canvas.initialCol);
      const tokens = highlight(text);
      const last = rows[rows.length - 1]!;
      canvas.draw(
        rows.map((r) => paintRow(text, tokens, r)),
        {
          row: rows.length - 1,
          col: (rows.length === 1 ? canvas.initialCol : 0) + stringWidth(text.slice(last.start, last.end)),
        },
      );
      out.write("^C\r\n");
      canvas.reset();
      inp.setRawMode?.(false);
      writeState();
      process.exit(CONTINUE);
    } else {
      redraw();
    }
  }
}

leave(0);
