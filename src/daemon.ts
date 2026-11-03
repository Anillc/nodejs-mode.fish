import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { isExpressionResult } from "./highlight.ts";
import { Evaluator } from "./eval.ts";
import { args } from "./args.ts";
import { applyEnv } from "./state.ts";
import { formatError, formatResult, isProcessOutput } from "./output.ts";
import { createRpcSpawn, encode, type ClientMessage, type DaemonMessage } from "./protocol.ts";

function requireSocket(): string {
  const v = args.socket;
  if (!v) {
    process.stderr.write("nodejs-mode: daemon needs --socket <path>\n");
    process.exit(2);
  }
  return v;
}

const sockPath = requireSocket();

// socket 旁边放 pid，客户端那边用它判断 socket 是不是残留的
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

const evaluator = new Evaluator({
  spawn: rpcSpawn as unknown as typeof import("node:child_process").spawn,
  spawnSync: (() => {
    throw new Error("spawnSync is not available in nodejs-mode");
  }) as unknown as typeof import("node:child_process").spawnSync,
});
evaluator.install();

let activeAbort: AbortController | null = null;
// 连上来的那一侧是不是终端：-c 走管道的时候不要吐颜色
let colors = true;

async function handleEval(code: string, send: Send): Promise<void> {
  const ac = new AbortController();
  activeAbort = ac;
  // abort 只到得了 daemon：这条命令起过的子进程要自己动手杀
  const onAbort = (): void => {
    for (const proc of procs.values()) proc.kill("SIGTERM");
  };
  ac.signal.addEventListener("abort", onAbort, { once: true });
  sink = (stream, data) => send({ t: "out", stream, data });
  try {
    const value = await evaluator.run(code, ac);
    if (!isProcessOutput(value)) {
      const text = formatResult(value, colors, isExpressionResult(code));
      if (text) sink("stdout", text);
    }
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
    // 让晚到的输出（spawn 数据冲刷）还有地方可去
    setImmediate(() => {
      sink = null;
    });
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
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => process.exit(0));
}
process.on("uncaughtException", (e: Error) => {
  process.stderr.write(`nodejs-mode: daemon crashed: ${e?.stack ?? String(e)}\n`);
  process.exit(1);
});

// fish 会话结束时（哪怕被 kill -9）自己退掉，不然会一直挂着
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
    if (active === send) active = null;
  });
  conn.on("error", () => {
    /* client went away */
  });
});

server.on("error", (e: NodeJS.ErrnoException) => {
  process.stderr.write(`nodejs-mode: cannot listen on ${sockPath}: ${e.code ?? e.message}\n`);
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
