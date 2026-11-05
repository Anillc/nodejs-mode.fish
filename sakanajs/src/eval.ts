import vm from "node:vm";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import * as zx from "zx";
import shell from "shelljs";
import lodash from "lodash";
import { stripTypeScriptTypes } from "node:module";
import { parser } from "@lezer/javascript";
import type { SyntaxNode } from "@lezer/common";
import { declaredNames, hasTopLevelAwait, referencedNames, wrapForAwait } from "./highlight.ts";
import { isRunning } from "./output.ts";

// commands print their own output once; the daemon renders return values
shell.config.silent = true;

export type Shell = typeof zx.$;

export interface ShellHooks {
  spawn: typeof spawn;
  spawnSync: typeof spawnSync;
}

const streamLog = (entry: { kind: string; data?: Buffer }): void => {
  if (entry.kind === "stdout") process.stdout.write(entry.data!);
  else if (entry.kind === "stderr") process.stderr.write(entry.data!);
};

function createShell(hooks: ShellHooks): Shell {
  return zx.$({
    spawn: hooks.spawn,
    spawnSync: hooks.spawnSync,
    verbose: false,
    quiet: false,
    preferLocal: true,
    log: streamLog,
  }) as Shell;
}

// warm up the vm ExperimentalWarning so it does not show up in the client
try {
  const warmup = new vm.Script("import('node:fs')", { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  void (warmup.runInThisContext() as Promise<unknown>).catch(() => {});
} catch {
  /* ignore */
}

// the REPL globals: every zx export, every shelljs command, and lodash as _ only.
// later wins over earlier; install() finally restores our own cd / require
function exposeGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  for (const [name, value] of Object.entries(zx)) {
    if (name !== "$") g[name] = value;
  }
  for (const [name, value] of Object.entries(shell)) g[name] = value;
  g._ = lodash;
}

function propertiesOf(base: string): string[] {
  const parts = base.split(".");
  let value: unknown = (globalThis as Record<string, unknown>)[parts[0]!];
  for (const part of parts.slice(1)) {
    if (value === null || value === undefined) return [];
    try {
      value = (value as Record<string, unknown>)[part];
    } catch {
      return [];
    }
  }
  if (value === null || value === undefined || (typeof value !== "object" && typeof value !== "function")) return [];
  const names = new Set<string>();
  let proto: object | null = value as object;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
    proto = Object.getPrototypeOf(proto);
  }
  return [...names];
}

// keywords are not on globalThis, but they are the first thing you type
const KEYWORDS = [
  "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete",
  "do", "else", "enum", "export", "extends", "false", "finally", "for", "function", "get", "if", "implements",
  "import", "in", "instanceof", "interface", "let", "new", "null", "of", "return", "set", "static", "super",
  "switch", "this", "throw", "true", "try", "type", "typeof", "var", "void", "while", "yield",
];

export class Evaluator {
  private shell?: Shell;
  private seq = 0;
  // processes started by the code of the current round: those are awaited, older ones are just values
  private fresh = new Set<object>();
  private tracked?: Shell;
  // top-level const/let/function live in the global lexical scope, invisible to Object.keys(globalThis), so track them
  private readonly declared = new Set<string>();
  private req = createRequire(path.join(process.cwd(), "__sakanajs__.cjs"));

  private readonly hooks: ShellHooks;

  constructor(hooks: ShellHooks) {
    this.hooks = hooks;
    exposeGlobals();
  }

  private ensureShell(): Shell {
    const shell = (this.shell ??= createShell(this.hooks));
    const tracked = (this.tracked ??= this.track(shell));
    (globalThis as unknown as Record<string, unknown>).$ = tracked;
    return tracked;
  }

  // remember what this round starts, so a promise from an earlier round is not awaited
  private track(shell: Shell): Shell {
    return new Proxy(shell, {
      apply: (target, thisArg, argArray) => {
        const result: unknown = Reflect.apply(target, thisArg, argArray);
        if (result && typeof result === "object") this.fresh.add(result);
        return result;
      },
    }) as Shell;
  }

  install(): void {
    const g = globalThis as unknown as Record<string, unknown>;
    g.require = this.req;
    g.cd = (dir: unknown) => this.cd(String(dir));
  }

  cd(dir: string): void {
    const target = path.resolve(process.cwd(), dir);
    process.chdir(target);
    this.req = createRequire(path.join(target, "__sakanajs__.cjs"));
    (globalThis as unknown as Record<string, unknown>).require = this.req;
  }

  // a name that is not global is tried as require: no import needed for fs.readFileSync(...)
  private autoRequire(code: string): void {
    const g = globalThis as Record<string, unknown>;
    for (const name of referencedNames(code)) {
      if (name in g) continue;
      try {
        g[name] = this.req(name);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw e;
      }
    }
  }

  complete(word: string, base?: string): string[] {
    // getOwnPropertyNames, not keys: console, process and friends are not enumerable
    const names = base
      ? propertiesOf(base)
      : [...Object.getOwnPropertyNames(globalThis), ...KEYWORDS, ...this.declared];
    return [...new Set(names)].filter((name) => name.startsWith(word)).sort((a, b) => a.localeCompare(b));
  }

  private compile(code: string): vm.Script {
    const src = hasTopLevelAwait(code) ? wrapForAwait(code) : code;
    return new vm.Script(src, {
      filename: `sakanajs-${++this.seq}`,
      // import() uses the main context's default loader: relative paths resolve from the cwd (as with require)
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
  }

  async run(code: string, ac: AbortController): Promise<{ value: unknown }> {
    const shell = this.ensureShell();
    this.autoRequire(code);
    for (const name of declaredNames(code)) this.declared.add(name);
    const cfg = shell as unknown as Record<string, unknown>;
    cfg.cwd = process.cwd();
    cfg.signal = ac.signal;
    cfg.verbose = false;
    cfg.quiet = false;
    let script: vm.Script;
    try {
      script = this.compile(code);
    } catch (e) {
      // plain JS takes the fast path; if it does not compile, treat it as TS (strip types + rewrite imports)
      if (!(e instanceof SyntaxError)) throw e;
      const prepared = prepareCode(code);
      if (prepared === code) throw e;
      script = this.compile(prepared);
    }
    this.fresh = new Set();
    const result: unknown = script.runInThisContext();
    if (result && typeof (result as { then?: unknown }).then === "function") {
      // a process started earlier keeps running in the background: hand it over as a value, do not await it
      const background = !this.fresh.has(result as object) && isRunning(result);
      return { value: background ? result : await (result as Promise<unknown>) };
    }
    return { value: result };
  }
}

// warm up once: the ExperimentalWarning fires only once, so let it land at daemon startup (log, not screen)
try {
  stripTypeScriptTypes("let __warmup: number = 0");
} catch {
  /* ignore */
}

function child(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) return c;
  return null;
}

function importBinding(node: SyntaxNode, code: string): string | null {
  const source = child(node, "String");
  if (!source) return null;
  const from = code.slice(source.from, source.to);
  // keep the parentheses: await import(x).default would take default off the promise first
  const load = `(await import(${from}))`;

  const group = child(node, "ImportGroup");
  if (group) {
    const names: string[] = [];
    let original: string | null = null;
    for (let c = group.firstChild; c; c = c.nextSibling) {
      const text = code.slice(c.from, c.to);
      if (c.name === "VariableName") original = text;
      else if (c.name === "VariableDefinition") {
        names.push(original ? `${original}: ${text}` : text);
        original = null;
      }
    }
    const parts: string[] = [];
    const def = child(node, "VariableDefinition");
    if (def) parts.push(`const ${code.slice(def.from, def.to)} = ${load}.default`);
    if (names.length) parts.push(`const { ${names.join(", ")} } = ${load}`);
    return parts.length ? `${parts.join("; ")};` : `await import(${from});`;
  }

  const name = child(node, "VariableDefinition");
  if (!name) return `await import(${from});`;
  const binding = code.slice(name.from, name.to);
  return child(node, "Star") ? `const ${binding} = ${load};` : `const ${binding} = ${load}.default;`;
}

// vm.Script cannot hold a static import, so rewrite them to await import() and let the top-level-await wrapper handle it
export function rewriteImports(code: string): string {
  const edits: Array<{ from: number; to: number; text: string }> = [];
  for (let node = parser.parse(code).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== "ImportDeclaration") continue;
    const text = importBinding(node, code);
    if (text) edits.push({ from: node.from, to: node.to, text });
  }
  let out = code;
  for (const edit of edits.reverse()) out = out.slice(0, edit.from) + edit.text + out.slice(edit.to);
  return out;
}

// strip types first, then rewrite imports; if stripping fails it is not TS (or it is broken), hand it back for vm to report
export function prepareCode(code: string): string {
  try {
    return rewriteImports(stripTypeScriptTypes(code, { mode: "transform" }));
  } catch {
    return code;
  }
}
