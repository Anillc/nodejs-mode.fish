import fs from "node:fs";
import process from "node:process";
import { args, positionals } from "./args.ts";

// -c <code> / -f <file> (- means stdin) / a bare file / a bare expression: no REPL, run once
function batchSource(): string | null {
  let code: unknown = args.code;
  let file: unknown = args.file;

  // piped stdin is the script, like "-f -"
  if (code === undefined && file === undefined && positionals.length === 0 && !process.stdin.isTTY) {
    return fs.readFileSync(0, "utf8");
  }

  if (code === undefined && file === undefined && positionals.length > 0) {
    const first = positionals[0];
    if (fs.existsSync(first) && fs.statSync(first).isFile()) file = first;
    else if (/\.(?:ts|js|mjs|cjs)$/.test(first)) {
      process.stderr.write(`sakanajs: no such file: ${first}\n`);
      process.exit(2);
    } else code = positionals.join(" ");
  }

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
  const socket: unknown = args.socket;
  if (typeof socket !== "string") {
    process.stderr.write(
      "sakanajs: no session socket; start it from fish with the plugin loaded, or set SAKANAJS_SOCKET\n",
    );
    process.exit(2);
  }

  const source = batchSource();

  if (source !== null) {
    // the experimental warnings we trigger ourselves must not leak into a script's output
    process.removeAllListeners("warning");
    process.on("warning", (w: Error) => {
      if (w.name !== "ExperimentalWarning") process.stderr.write(`${w.name}: ${w.message}\n`);
    });
    const { ensureDaemon } = await import("./session.ts");
    try {
      await ensureDaemon(socket);
    } catch (e) {
      process.stderr.write(`sakanajs: ${(e as Error).message}\n`);
      process.exit(2);
    }
    const { runBatch } = await import("./batch.ts");
    const status = await runBatch(source, socket);
    if (!process.exitCode) process.exitCode = status;
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write("sakanajs: needs an interactive terminal (or -c <code>)\n");
      process.exit(1);
    }

    const { ensureDaemon } = await import("./session.ts");
    try {
      await ensureDaemon(socket);
    } catch (e) {
      process.stderr.write(`sakanajs: ${(e as Error).message}\n`);
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
