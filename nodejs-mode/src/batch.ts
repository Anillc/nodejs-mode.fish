import process from "node:process";
import { Remote } from "./remote.ts";

// -c / -f：跑一条命令，走 daemon —— 和 REPL 是同一份状态，没有本地模式
export async function runBatch(code: string, socket: string): Promise<number> {
  let remote: Remote;
  try {
    remote = await Remote.connect(socket);
  } catch (e) {
    process.stderr.write(`nodejs-mode: cannot reach the daemon (${socket}): ${(e as Error).message}\n`);
    return 2;
  }
  try {
    await remote.eval(
      code,
      process.cwd(),
      { ...process.env },
      (stream, data) => {
        (stream === "stderr" ? process.stderr : process.stdout).write(data);
      },
      process.stdout.isTTY === true,
    );
    return remote.lastStatus.code;
  } catch (e) {
    process.stderr.write(`nodejs-mode: ${(e as Error).message}\n`);
    return 1;
  } finally {
    remote.close();
  }
}
