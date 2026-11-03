import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import xterm from "@xterm/headless";

const { Terminal } = xterm;

const COLS = 80;
const ROWS = 30;
const root = path.resolve(import.meta.dirname, "../..");
const tmp = path.join(root, ".tmp", "pty");
fs.rmSync(tmp, { recursive: true, force: true });
for (const d of ["config", "data", "state", "tmp", "home", "run"]) fs.mkdirSync(path.join(tmp, d), { recursive: true });

const initFile = path.join(tmp, "init.fish");
fs.writeFileSync(
  initFile,
  [
    "function fish_prompt",
    "    set_color blue",
    "    printf '%s' (prompt_pwd)",
    "    set_color normal",
    process.argv[3] === "nl" ? "    printf ' \\n\u276f \\n'" : process.argv[3] === "wide" ? "    printf '%s \u276f ' (string repeat -n 90 x)" : process.argv[3] === "three" ? "    printf ' \\nsecond\\n\u276f '" : process.argv[3] === "two" ? "    printf ' \\n\u276f '" : "    printf ' \u276f '",
    "end",
    `source ${process.env.PTY_PLUGIN ?? path.join(root, "conf.d/nodejs-mode.fish")}`,
    process.argv[4] === "vi" ? "fish_vi_key_bindings" : "",
    "",
  ].join("\n"),
);

const scenario = JSON.parse(process.argv[2] ?? "[]");
const env = {
  ...process.env,
  HOME: path.join(tmp, "home"),
  XDG_CONFIG_HOME: path.join(tmp, "config"),
  XDG_DATA_HOME: path.join(tmp, "data"),
  XDG_STATE_HOME: path.join(tmp, "state"),
  TMPDIR: path.join(tmp, "tmp"),
  NODEJS_MODE_RUNTIME_DIR: path.join(tmp, "run"),
};
const cp = spawn("script", ["-qec", `fish --no-config -i -C 'source ${initFile}'`, "/dev/null"], {
  stdio: ["pipe", "pipe", "inherit"],
  env,
  cwd: root,
});

const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
let pending = Promise.resolve();
cp.stdout.on("data", (chunk) => {
  if (process.env.PTY_RAW) fs.appendFileSync(process.env.PTY_RAW, chunk);
  pending = pending.then(() => new Promise((resolve) => term.write(chunk, resolve)));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function screen() {
  await pending;
  const buf = term.buffer.active;
  const rows = [];
  for (let i = 0; i < ROWS; i++) rows.push(buf.getLine(buf.baseY + i)?.translateToString(true).trimEnd() ?? "");
  const last = Math.max(buf.cursorY, rows.findLastIndex((r) => r !== ""));
  return rows
    .slice(0, Math.max(last + 1, 1))
    .map((r, i) => `${String(i + 1).padStart(2, " ")}|${r}`)
    .join("\n");
}

await sleep(700);
for (const step of scenario) {
  await sleep(step.d ?? 250);
  if (step.run) execSync(step.run, { stdio: "inherit" });
  if (step.s) cp.stdin.write(step.s);
  if (step.mark) console.log(`\n--- ${step.mark} ---\n${await screen()}`);
}
await sleep(600);
cp.kill();
console.log("\n=== final ===");
console.log(await screen());
process.exit(0);
