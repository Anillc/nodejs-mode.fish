import vm from "node:vm";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync, type StdioOptions } from "node:child_process";
import * as zx from "zx";
import shell from "shelljs";
import lodash from "lodash";
import { declaredNames, hasTopLevelAwait, isBareShellCommand, referencedNames, wrapForAwait } from "./highlight.ts";
import { prepareCode } from "./ts.ts";

// 命令自己打印一次就够了，返回值由 daemon 统一显示
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

function createShell(hooks: ShellHooks, stdio?: StdioOptions): Shell {
  return zx.$({
    spawn: hooks.spawn,
    spawnSync: hooks.spawnSync,
    verbose: false,
    quiet: false,
    preferLocal: true,
    log: streamLog,
    ...(stdio ? { stdio } : {}),
  }) as Shell;
}

// 预热 vm 的 ExperimentalWarning，别让它出现在客户端
try {
  const warmup = new vm.Script("import('node:fs')", { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  void (warmup.runInThisContext() as Promise<unknown>).catch(() => {});
} catch {
  /* 忽略 */
}

// REPL 的全局名字：zx 的全部导出、shelljs 的全部命令、lodash 只挂 _。
// 后写的覆盖先写的，最后由 install() 把 cd / require 换回我们自己的版本
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

export class Evaluator {
  private shell?: Shell;
  private ttyShell?: Shell;
  private seq = 0;
  // 顶层 const/let/function 在全局词法环境里，Object.keys(globalThis) 看不到，得自己记
  private readonly declared = new Set<string>();
  private req = createRequire(path.join(process.cwd(), "__nodejs_mode__.cjs"));

  private readonly hooks: ShellHooks;

  constructor(hooks: ShellHooks) {
    this.hooks = hooks;
    exposeGlobals();
  }

  private ensureShell(tty: boolean): Shell {
    const shell = tty ? (this.ttyShell ??= createShell(this.hooks, "inherit")) : (this.shell ??= createShell(this.hooks));
    (globalThis as unknown as Record<string, unknown>).$ = shell;
    return shell;
  }

  install(): void {
    const g = globalThis as unknown as Record<string, unknown>;
    g.require = this.req;
    g.cd = (dir: unknown) => this.cd(String(dir));
  }

  cd(dir: string): void {
    const target = path.resolve(process.cwd(), dir);
    process.chdir(target);
    this.req = createRequire(path.join(target, "__nodejs_mode__.cjs"));
    (globalThis as unknown as Record<string, unknown>).require = this.req;
  }

  // 全局里没有的名字先试 require：fs.readFileSync(...) 这种就不用自己 import
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
    const names = base ? propertiesOf(base) : [...Object.keys(globalThis), ...this.declared];
    return [...new Set(names)].filter((name) => name.startsWith(word)).sort((a, b) => a.localeCompare(b));
  }

  private compile(code: string): vm.Script {
    const src = hasTopLevelAwait(code) ? wrapForAwait(code) : code;
    return new vm.Script(src, {
      filename: `nodejs-mode-${++this.seq}`,
      // import() 用主上下文默认的 loader：相对路径按 cwd 解析（和 require 一致）
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
  }

  async run(code: string, ac: AbortController): Promise<unknown> {
    const shell = this.ensureShell(isBareShellCommand(code));
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
      // 普通 JS 走快路径；编译不过再当 TS 处理（剥类型 + 改写 import）
      if (!(e instanceof SyntaxError)) throw e;
      const prepared = prepareCode(code);
      if (prepared === code) throw e;
      script = this.compile(prepared);
    }
    const result: unknown = script.runInThisContext();
    if (result && typeof (result as { then?: unknown }).then === "function") {
      return await (result as Promise<unknown>);
    }
    return result;
  }
}
