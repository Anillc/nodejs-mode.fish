import fs from "node:fs";
import process from "node:process";
import { args } from "./args.ts";

// -c <code> / -f <file> (- means stdin): no REPL, run one command and exit
function batchSource(): string | null {
  const code: unknown = args.code;
  const file: unknown = args.file;
  if (code === undefined && file === undefined) return null;
  if (code !== undefined && file !== undefined) {
    process.stderr.write("sakanajs: use either -c or -f\n");
    process.exit(2);
  }
  if (typeof file === "string") {
    try {
      return fs.readFileSync(file === "-" ? 0 : file, "utf8");
    } catch (e) {
      process.stderr.write(`sakanajs: ${(e as Error).message}\n`);
      process.exit(2);
    }
  }
  if (typeof code === "string") return code;
  process.stderr.write("sakanajs: -c needs a value\n");
  process.exit(2);
}

if (args.daemon === true) {
  // one binary, two roles: --daemon is the session daemon, everything else is the client
  await import("./daemon.ts");
} else {
  const source = batchSource();

  if (source !== null) {
    // the experimental warnings we trigger ourselves must not leak into a script's output
    process.removeAllListeners("warning");
    process.on("warning", (w: Error) => {
      if (w.name !== "ExperimentalWarning") process.stderr.write(`${w.name}: ${w.message}\n`);
    });
    const { runBatch } = await import("./batch.ts");
    const socket: unknown = args.socket;
    if (typeof socket !== "string") {
      process.stderr.write("sakanajs: -c/-f need --socket (the fish function passes the session daemon's)\n");
      process.exit(2);
    }
    const status = await runBatch(source, socket);
    if (!process.exitCode) process.exitCode = status;
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write("sakanajs: needs an interactive terminal (or -c <code>)\n");
      process.exit(1);
    }

    const { headerLines, PROMPT_ANSI } = await import("./render.ts");
    const lines = headerLines(args.header);
    if (lines.length) process.stdout.write(`${lines.join("\r\n")}\r\n`);
    process.stdout.write(PROMPT_ANSI);
    process.stdin.setRawMode(true);

    await import("./cli.ts");
  }
}
