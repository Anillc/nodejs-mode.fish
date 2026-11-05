import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { isExpressionResult } from "./highlight.ts";
import { Evaluator, type ShellHooks } from "./eval.ts";
import { args } from "./args.ts";
import { applyEnv } from "./state.ts";
import { formatError, formatResult } from "./output.ts";
import { spawn as spawnChild, spawnSync as spawnSyncChild, type ChildProcess } from "node:child_process";
import { createRpcSpawn, encode, type ClientMessage, type DaemonMessage } from "./protocol.ts";

function requireSocket(): string {
  const v = args.socket;
  if (!v) {
    process.stderr.write("sakanajs: daemon needs --socket <path>\n");
    process.exit(2);
  }
  return v;
}

const sockPath = requireSocket();

// keep the pid next to the socket so the client can tell a stale socket from a live one
const pidPath = `${sockPath}.pid`;

type Send = (msg: DaemonMessage) => void;
let active: Send | null = null;
let sink: ((stream: "stdout" | "stderr", data: string) => void) | null = null;

type RealWrite = (chunk: string, ...rest: unknown[]) => boolean;
const realOut = process.stdout.write.bind(process.stdout) as unknown as RealWrite;
const realErr = process.stderr.write.bind(process.stderr) as unknown as RealWrite;
const patch = (stream: "stdout" | "stderr", real: RealWrite): RealWrite =>
  (chunk: string, ...rest: unknown[]): boolean => {
    if (sink) sink(stream, String(chunk));
    else real(String(chunk), ...rest);
    return true;
  };
(process.stdout as unknown as { write: RealWrite }).write = patch("stdout", realOut);
(process.stderr as unknown as { write: RealWrite }).write = patch("stderr", realErr);

const { spawn: rpcSpawn, procs } = createRpcSpawn((msg) => active?.(msg as DaemonMessage));

// the daemon owns the piped children: they outlive the short-lived client, so a background job keeps
// running across rounds. Only commands that need the terminal go through the client, which has the tty.
const local = new Set<ChildProcess>();
const spawnLocal = ((cmd: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
  const child = spawnChild(cmd, args, {
    stdio: (opts.stdio as "pipe" | "inherit" | undefined) ?? "pipe",
    shell: (opts.shell as string | boolean | undefined) ?? false,
    cwd: (opts.cwd as string | undefined) ?? process.cwd(),
    env: (opts.env as NodeJS.ProcessEnv | undefined) ?? process.env,
    detached: (opts.detached as boolean | undefined) ?? false,
  });
  local.add(child);
  child.on("close", () => local.delete(child));
  return child;
}) as unknown as ShellHooks["spawn"];
// .stdio("inherit") turns the option into an array, so both shapes have to go through the client
const wantsTty = (stdio: unknown): boolean =>
  stdio === "inherit" || (Array.isArray(stdio) && stdio.includes("inherit"));
const spawnAny = ((cmd: string, args?: string[], opts: Record<string, unknown> = {}) =>
  wantsTty(opts.stdio) ? rpcSpawn(cmd, args, opts) : spawnLocal(cmd, args, opts)) as unknown as ShellHooks["spawn"];

const evaluator = new Evaluator({ spawn: spawnAny, spawnSync: spawnSyncChild });
evaluator.install();

let activeAbort: AbortController | null = null;
// is the other side a terminal: no colours when -c goes through a pipe
let colors = true;

// Ctrl-C has to stop the await too, not only the child processes (node's repl reports the same thing)
function interrupted(): Error {
  const err = new Error("Script execution was interrupted by `SIGINT`");
  (err as NodeJS.ErrnoException).code = "ERR_SCRIPT_EXECUTION_INTERRUPTED";
  return err;
}

async function handleEval(code: string, send: Send): Promise<void> {
  const ac = new AbortController();
  activeAbort = ac;
  // abort only reaches the daemon: child processes of this command have to be killed here
  const onAbort = (): void => {
    for (const proc of procs.values()) proc.kill("SIGTERM");
    for (const child of local) child.kill("SIGTERM");
  };
  ac.signal.addEventListener("abort", onAbort, { once: true });
  // keep the sink between rounds: a process started late still has output to deliver
  sink = (stream, data) => send({ t: "out", stream, data });
  const stopped = new Promise<never>((_, reject) => {
    ac.signal.addEventListener("abort", () => reject(interrupted()), { once: true });
  });
  try {
    const { value } = await Promise.race([evaluator.run(code, ac), stopped]);
    const text = formatResult(value, colors, isExpressionResult(code));
    if (text) sink("stdout", text);
    await new Promise((resolve) => setImmediate(resolve));
    const status = typeof process.exitCode === "number" ? process.exitCode : 0;
    process.exitCode = 0;
    send({ t: "done", ok: true, code: status, cwd: process.cwd(), env: { ...process.env } });
  } catch (e) {
    sink("stderr", formatError(e, colors));
    process.exitCode = 0;
    send({ t: "done", ok: false, code: 1, cwd: process.cwd(), env: { ...process.env } });
  } finally {
    ac.signal.removeEventListener("abort", onAbort);
    if (activeAbort === ac) activeAbort = null;
  }
}

function handle(msg: ClientMessage, send: Send): void {
  switch (msg.t) {
    case "hello":
      try {
        process.chdir(msg.cwd);
      } catch {
        /* keep the old cwd */
      }
      applyEnv(msg.env);
      colors = msg.colors !== false;
      break;
    case "eval":
      void handleEval(msg.code, send);
      break;
    case "abort":
      activeAbort?.abort();
      break;
    case "complete":
      send({ t: "completions", id: msg.id, items: evaluator.complete(msg.word, msg.base) });
      break;
    case "spawn-data": {
      const proc = procs.get(msg.id);
      proc?.[msg.stream].write(msg.data);
      break;
    }
    case "spawn-stdin": {
      const proc = procs.get(msg.id);
      proc?.stdin.write(msg.data);
      break;
    }
    case "spawn-exit": {
      const proc = procs.get(msg.id);
      procs.delete(msg.id);
      proc?.finish(msg.code, msg.signal);
      break;
    }
    case "shutdown":
      process.exit(0);
  }
}

function cleanup(): void {
  for (const p of [sockPath, pidPath]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
}

process.on("exit", cleanup);
for (const sig of ["SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => process.exit(0));
}
// SIGINT interrupts a running script (breakOnSigint) or is a no-op, it must never kill the daemon
process.on("SIGINT", () => {});
// internal notes belong in the log, not on the screen
process.on("warning", (w: Error) => {
  if (w.name === "ExperimentalWarning" || w.name === "PromiseRejectionHandledWarning") return;
  realErr(`${w.name}: ${w.message}\n`);
});
process.on("unhandledRejection", (e: unknown) => {
  realErr(`sakanajs: unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
});
process.on("uncaughtException", (e: Error) => {
  process.stderr.write(`sakanajs: daemon crashed: ${e?.stack ?? String(e)}\n`);
  process.exit(1);
});

// exit when the fish session ends, even on kill -9, instead of hanging around
const parent = Number(args.parent ?? "");
if (Number.isInteger(parent) && parent > 0) {
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") process.exit(0);
    }
  }, 1000).unref();
}

try {
  fs.unlinkSync(sockPath);
} catch {
  /* stale socket */
}

const server = net.createServer((conn) => {
  conn.setEncoding("utf8");
  const send: Send = (msg) => conn.write(encode(msg));
  active = send;
  let buf = "";
  conn.on("data", (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line) as ClientMessage, send);
      } catch {
        /* ignore malformed */
      }
    }
  });
  conn.on("close", () => {
    if (active === send) {
      active = null;
      // nothing can be delivered any more; late output goes back to the log
      sink = null;
    }
    for (const proc of procs.values()) {
      if (proc.exitCode === null && proc.signalCode === null) proc.finish(null, "SIGHUP");
    }
  });
  conn.on("error", () => {
    /* client went away */
  });
});

server.on("error", (e: NodeJS.ErrnoException) => {
  process.stderr.write(`sakanajs: cannot listen on ${sockPath}: ${e.code ?? e.message}\n`);
  process.exit(1);
});

server.listen(sockPath, () => {
  try {
    fs.chmodSync(sockPath, 0o600);
    fs.writeFileSync(pidPath, `${process.pid}\n`);
  } catch {
    /* best effort */
  }
});
