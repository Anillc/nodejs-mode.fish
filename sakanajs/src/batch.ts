import process from "node:process";
import { Remote } from "./remote.ts";

// -c / -f: run one command through the daemon, sharing state with the REPL — no local mode
export async function runBatch(code: string, socket: string): Promise<number> {
  let remote: Remote;
  try {
    remote = await Remote.connect(socket);
  } catch (e) {
    process.stderr.write(`sakanajs: cannot reach the daemon (${socket}): ${(e as Error).message}\n`);
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
    process.stderr.write(`sakanajs: ${(e as Error).message}\n`);
    return 1;
  } finally {
    remote.close();
  }
}
