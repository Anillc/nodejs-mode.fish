import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bootPath = fileURLToPath(new URL("./boot.js", import.meta.url));

export function sessionSocket(): string | undefined {
  const sock = process.env.SAKANAJS_SOCKET;
  return sock && sock.length > 0 ? sock : undefined;
}

function reachable(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.connect(sock);
    const done = (ok: boolean): void => {
      conn.destroy();
      resolve(ok);
    };
    conn.setTimeout(500, () => done(false));
    conn.once("connect", () => done(true));
    conn.once("error", () => done(false));
  });
}

// the fish session owns the socket path; the client only has to make sure something listens on it
export async function ensureDaemon(sock: string): Promise<void> {
  if (await reachable(sock)) return;

  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });

  const log = `${sock}.log`;
  const fd = fs.openSync(log, "w");
  try {
    const parent = process.env.SAKANAJS_PARENT ?? String(process.ppid);
    const child = spawn(process.execPath, [bootPath, "--daemon", "--socket", sock, "--parent", parent], {
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();

    for (let i = 0; i < 300; i++) {
      if (await reachable(sock)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    fs.closeSync(fd);
  }

  let tail = "";
  try {
    tail = fs.readFileSync(log, "utf8").trim();
  } catch {
    /* no log */
  }
  throw new Error(`the daemon did not start\n  socket: ${sock}\n  log:    ${log}${tail ? `\n  ---\n${tail}` : ""}`);
}
