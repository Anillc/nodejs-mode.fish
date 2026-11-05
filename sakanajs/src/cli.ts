import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { cursorDown, cursorTo, cursorUp, eraseDown } from "ansi-escapes";
import { args } from "./args.ts";
import { Remote } from "./remote.ts";
import { Editor, KeyDecoder } from "./editor.ts";
import { highlight, shellAt } from "./highlight.ts";
import { escapeShellWord, openQuote, shellCompletions } from "./fish.ts";
import {
  Canvas,
  headerLines,
  layout,
  locate,
  menuLines,
  paintRow,
  PROMPT_ANSI,
  PROMPT_COLS,
  stringWidth,
  type MenuItem,
} from "./render.ts";
import { applyEnv, stateCode } from "./state.ts";
import { formatError, yellow } from "./output.ts";

const out = process.stdout;
const inp = process.stdin;

const CONTINUE = 42;
// cannot reach the daemon: fish sees this, cleans up, restarts it and retries the round
const CONNECT_FAILED = 43;

function requireSocket(): string {
  const v = args.socket;
  if (!v) {
    process.stderr.write("sakanajs: this repl needs --socket (daemon mode only)\n");
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

const histDir = path.join(process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? ".", ".local/state"), "sakanajs");
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

function wordStartAt(text: string, cursor: number): number {
  let start = cursor;
  while (start > 0 && !/[\s'"`|;&<>()]/.test(text[start - 1]!)) start--;
  return start;
}

function pathCompletion(text: string, cursor: number): string | null {
  const start = wordStartAt(text, cursor);
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
  // erase the header + prompt already painted, do not leave half a block behind
  const up = headerLines(args.header).length;
  out.write(`${cursorTo(0)}${up > 0 ? cursorUp(up) : ""}${eraseDown}`);
  out.write(`${yellow("sakanajs: cannot reach the daemon")}\r\n`);
  out.write(`${yellow(`  socket: ${socketPath}`)}\r\n`);
  out.write(`${yellow(`  ${e instanceof Error ? e.message : String(e)}`)}\r\n`);
  out.write(`${yellow("  restarting it...")}\r\n`);
  inp.setRawMode?.(false);
  process.exit(CONNECT_FAILED);
}

let activeRemote: Remote | null = null;

async function runCode(code: string): Promise<void> {
  if (remote.isClosed) {
    out.write(`${yellow("sakanajs: lost the daemon, restarting it...")}\n`);
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
    // the daemon's cwd/env are the real ones: copy them back so the state written on exit is right
    const s = remote.lastState;
    if (s) {
      try {
        process.chdir(s.cwd);
      } catch {
        /* keep the old cwd if the directory is gone */
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

// Tab: one candidate completes directly; many complete to the common prefix, otherwise list them
// under the input line and cycle through them with Tab
let menu: { items: MenuItem[]; selected: number; start: number; length: number; text: string; cursor: number } | null = null;

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
    applyCompletion(menu.start, menu.length, item.text);
    menu.length = item.text.length;
    menu.text = editor.text;
    menu.cursor = editor.cursor;
    redraw();
    return;
  }
  menu = null;

  // inside $`…` hand over to fish: commands, flags and files are its business
  const shell = shellAt(text, cursor);
  if (shell) {
    const line = text.slice(shell.start, cursor);
    if (line.trim()) {
      await completeInShell(line, wordStartAt(text, cursor));
      return;
    }
  }

  const word = /[\w$]*$/.exec(text.slice(0, cursor))![0];
  const start = cursor - word.length;
  const member = start > 0 && text[start - 1] === ".";

  if (member) {
    const base = /[\w$.]+$/.exec(text.slice(0, start - 1))?.[0];
    if (!base) return;
    openMenu(start, word, (await remote.complete(word, base)).map((name) => ({ text: name })));
    return;
  }

  // the whole token (with quotes/slashes) tells us whether this is path completion
  const tokenStart = wordStartAt(text, cursor);
  const token = text.slice(tokenStart);
  if (token.includes("/") || token.startsWith(".") || token.startsWith("~")) {
    completePath(text, tokenStart, token);
    return;
  }

  // an empty word lists nothing, else one Tab dumps every global
  if (!word) return;
  const items = (await remote.complete(word)).map((name) => ({ text: name }));
  if (items.length) openMenu(start, word, items);
  else completePath(text, tokenStart, token);
}

async function completeInShell(line: string, start: number): Promise<void> {
  const items = await shellCompletions(line);
  if (!items.length) return;
  const word = editor.text.slice(start, editor.cursor);
  // inside an unclosed quote: fish gives the raw text, insert it without another layer of quoting
  const quoted = openQuote(line) !== null;
  const fill = (text: string): string => (quoted ? text : escapeShellWord(text));
  if (items.length === 1) {
    const raw = items[0]!.text;
    const suffix = quoted || raw.endsWith("/") ? "" : " ";
    applyCompletion(start, word.length, fill(raw) + suffix);
    redraw();
    return;
  }
  openMenu(start, word, items.map((item) => ({ text: fill(item.text), desc: item.desc })));
}

function openMenu(start: number, word: string, items: MenuItem[]): void {
  if (!items.length) return;
  let fill = items[0]!.text;
  for (const item of items) {
    while (!item.text.startsWith(fill)) fill = fill.slice(0, -1);
  }
  // a common prefix ending inside quotes would cut the word, so open the menu instead
  if (fill.length > word.length && !/['"]/.test(fill)) {
    applyCompletion(start, word.length, fill);
    redraw();
    return;
  }
  // like fish: opening the menu selects the first item and puts it on the input line
  applyCompletion(start, word.length, items[0]!.text);
  menu = { items, selected: 0, start, length: items[0]!.text.length, text: editor.text, cursor: editor.cursor };
  redraw();
}

function completePath(text: string, start: number, token: string): void {
  const filled = pathCompletion(text, editor.cursor);
  if (!filled) return;
  applyCompletion(start, token.length, filled);
  redraw();
}

function leave(code: number): never {
  // go back to the first header line, erase the header + input block, let fish repaint
  const headerCount = headerLines(args.header).length;
  const up = canvas.cursorRow + headerCount;
  out.write(`${cursorTo(0)}${up > 0 ? cursorUp(up) : ""}${eraseDown}`);
  // repaint redraws (prompt lines - 1) rows above the cursor, so leave the cursor on the last line
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
    // with the menu open Enter only accepts the selection (like fish); press it again to run
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
        // Enter on an empty line: move down so the line stays in scrollback, then draw a new block
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
      // like fish: keep what was typed, move to the end of the line, add ^C and move on
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
