import net from "node:net";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";
import { encode, type ClientMessage, type DaemonMessage, type SpawnOpts } from "./protocol.ts";

export type OutputFn = (stream: "stdout" | "stderr", data: string) => void;

export class Remote {
  private sock: net.Socket;
  private buf = "";
  private children = new Map<number, ChildProcess>();
  private onOut: OutputFn = () => {};
  private waiter: (() => void) | null = null;
  private failer: ((e: Error) => void) | null = null;
  private last: { cwd: string; env: Record<string, string | undefined> } | null = null;
  private reqId = 0;
  private readonly completing = new Map<number, (items: string[]) => void>();
  private closed = false;

  constructor(sock: net.Socket) {
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.receive(chunk));
    sock.on("close", () => this.abort("daemon connection closed"));
    sock.on("error", () => this.abort("daemon connection error"));
  }

  private abort(reason: string): void {
    this.closed = true;
    for (const resolve of this.completing.values()) resolve([]);
    this.completing.clear();
    const fail = this.failer;
    this.waiter = null;
    this.failer = null;
    fail?.(new Error(reason));
  }

  static connect(path: string): Promise<Remote> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(path);
      sock.once("connect", () => resolve(new Remote(sock)));
      sock.once("error", reject);
    });
  }

  private send(msg: ClientMessage): void {
    if (!this.closed) this.sock.write(encode(msg));
  }

  private receive(chunk: string): void {
    this.buf += chunk;
    for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        this.handle(JSON.parse(line) as DaemonMessage);
      } catch {
        /* ignore malformed */
      }
    }
  }

  private handle(msg: DaemonMessage): void {
    switch (msg.t) {
      case "out":
        this.onOut(msg.stream, msg.data);
        break;
      case "spawn":
        this.spawnChild(msg.id, msg.cmd, msg.args, msg.opts);
        break;
      case "spawn-stdin":
        this.children.get(msg.id)?.stdin?.write(msg.data);
        break;
      case "spawn-kill":
        this.children.get(msg.id)?.kill((msg.signal ?? "SIGTERM") as NodeJS.Signals);
        break;
      case "completions": {
        this.completing.get(msg.id)?.(msg.items);
        this.completing.delete(msg.id);
        break;
      }
      case "done":
        this.last = { cwd: msg.cwd, env: msg.env };
        this.waiter?.();
        this.waiter = null;
        this.failer = null;
        break;
    }
  }

  private spawnChild(id: number, cmd: string, args: string[], opts: SpawnOpts): void {
    const stdio = opts.stdio === "inherit" ? "inherit" : "pipe";
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: opts.shell === true ? true : typeof opts.shell === "string" ? opts.shell : false,
      stdio: stdio as "pipe" | "inherit",
    });
    this.children.set(id, child);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => this.send({ t: "spawn-data", id, stream: "stdout", data }));
    child.stderr?.on("data", (data: string) => this.send({ t: "spawn-data", id, stream: "stderr", data }));
    child.on("close", (code, signal) => {
      this.children.delete(id);
      this.send({ t: "spawn-exit", id, code, signal });
    });
    child.on("error", () => {
      this.children.delete(id);
      this.send({ t: "spawn-exit", id, code: 1, signal: null });
    });
  }

  get lastState(): { cwd: string; env: Record<string, string | undefined> } | null {
    return this.last;
  }

  complete(word: string, base?: string): Promise<string[]> {
    if (this.closed) return Promise.resolve([]);
    const id = ++this.reqId;
    return new Promise((resolve) => {
      this.completing.set(id, resolve);
      this.send({ t: "complete", id, word, base });
    });
  }

  sendAbort(): void {
    this.send({ t: "abort" });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async eval(code: string, cwd: string, env: NodeJS.ProcessEnv, onOut: OutputFn): Promise<void> {
    if (this.closed) throw new Error("daemon is not connected");
    this.onOut = onOut;
    this.send({ t: "hello", cwd, env: { ...env } });
    this.send({ t: "eval", code });
    await new Promise<void>((resolve, reject) => {
      this.waiter = resolve;
      this.failer = reject;
    });
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.sock.end();
    }
  }
}
