import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export type ClientMessage =
  | { t: "hello"; cwd: string; env: Record<string, string | undefined> }
  | { t: "eval"; code: string }
  | { t: "abort" }
  | { t: "complete"; id: number; word: string; base?: string }
  | { t: "spawn-data"; id: number; stream: "stdout" | "stderr"; data: string }
  | { t: "spawn-stdin"; id: number; data: string }
  | { t: "spawn-exit"; id: number; code: number | null; signal: string | null }
  | { t: "shutdown" };

export type DaemonMessage =
  | { t: "out"; stream: "stdout" | "stderr"; data: string }
  | { t: "spawn"; id: number; cmd: string; args: string[]; opts: SpawnOpts }
  | { t: "spawn-kill"; id: number; signal?: string }
  | { t: "spawn-stdin"; id: number; data: string }
  | { t: "done"; ok: boolean; cwd: string; env: Record<string, string | undefined> }
  | { t: "completions"; id: number; items: string[] };

export interface SpawnOpts {
  stdio?: unknown;
  shell?: string | true;
  cwd?: string;
  env?: Record<string, string | undefined>;
  detached?: boolean;
}

export function encode(msg: ClientMessage | DaemonMessage): string {
  return `${JSON.stringify(msg)}\n`;
}

export class RemoteProcess extends EventEmitter {
  pid = 0;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  readonly id: number;

  constructor(id: number, send: (msg: unknown) => void) {
    super();
    this.id = id;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin.on("data", (d: Buffer) => send({ t: "spawn-stdin", id, data: d.toString() }));
  }

  kill(signal?: string): boolean {
    this.killed = true;
    (this as unknown as { sendKill?: (signal?: string) => void }).sendKill?.(signal);
    return true;
  }

  finish(code: number | null, signal: string | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    // 等 stdout/stderr 里的数据先冲刷完，再发 close（zx 以 close 作为完成信号）
    let pending = 2;
    const done = (): void => {
      if (--pending === 0) this.emit("close", code, signal);
    };
    this.stdout.end(done);
    this.stderr.end(done);
  }
}

export type SpawnFn = (cmd: string, args?: string[], opts?: SpawnOpts) => RemoteProcess;

export function createRpcSpawn(send: (msg: unknown) => void): { spawn: SpawnFn; procs: Map<number, RemoteProcess> } {
  let nextId = 1;
  const procs = new Map<number, RemoteProcess>();
  const spawn: SpawnFn = (cmd, args = [], opts = {}) => {
    const id = nextId++;
    const proc = new RemoteProcess(id, send);
    (proc as unknown as { sendKill: (signal?: string) => void }).sendKill = (signal?: string) =>
      send({ t: "spawn-kill", id, signal });
    procs.set(id, proc);
    send({ t: "spawn", id, cmd, args, opts });
    return proc;
  };
  return { spawn, procs };
}
