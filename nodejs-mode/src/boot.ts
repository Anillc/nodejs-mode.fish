import fs from "node:fs";
import process from "node:process";
import { args } from "./args.ts";

// -c <code> / -f <file>（- 表示 stdin）：不进 REPL，跑一条就退
function batchSource(): string | null {
  const code: unknown = args.code;
  const file: unknown = args.file;
  if (code === undefined && file === undefined) return null;
  if (code !== undefined && file !== undefined) {
    process.stderr.write("nodejs-mode: use either -c or -f\n");
    process.exit(2);
  }
  if (typeof file === "string") {
    try {
      return fs.readFileSync(file === "-" ? 0 : file, "utf8");
    } catch (e) {
      process.stderr.write(`nodejs-mode: ${(e as Error).message}\n`);
      process.exit(2);
    }
  }
  if (typeof code === "string") return code;
  process.stderr.write("nodejs-mode: -c needs a value\n");
  process.exit(2);
}

const source = batchSource();

if (source !== null) {
  // 我们自己触发的 experimental warning 不该混进脚本的输出
  process.removeAllListeners("warning");
  process.on("warning", (w: Error) => {
    if (w.name !== "ExperimentalWarning") process.stderr.write(`${w.name}: ${w.message}\n`);
  });
  const { runBatch } = await import("./batch.ts");
  const socket: unknown = args.socket;
  if (typeof socket !== "string") {
    process.stderr.write("nodejs-mode: -c/-f need --socket (the fish function passes the session daemon's)\n");
    process.exit(2);
  }
  const status = await runBatch(source, socket);
  if (!process.exitCode) process.exitCode = status;
} else {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("nodejs-mode: needs an interactive terminal (or -c <code>)\n");
    process.exit(1);
  }

  const { headerLines, PROMPT_ANSI } = await import("./render.ts");
  const lines = headerLines(args.header);
  if (lines.length) process.stdout.write(`${lines.join("\r\n")}\r\n`);
  process.stdout.write(PROMPT_ANSI);
  process.stdin.setRawMode(true);

  await import("./cli.ts");
}
