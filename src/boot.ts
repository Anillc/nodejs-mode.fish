import { args } from "./args.ts";
import { headerLines, PROMPT_ANSI } from "./render.ts";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write("nodejs-mode: needs an interactive terminal\n");
  process.exit(1);
}

const lines = headerLines(args.header);
if (lines.length) process.stdout.write(`${lines.join("\r\n")}\r\n`);
process.stdout.write(PROMPT_ANSI);
process.stdin.setRawMode(true);

await import("./cli.ts");
