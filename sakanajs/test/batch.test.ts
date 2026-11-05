import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { escapeShellWord } from "../src/fish.ts";

const root = path.resolve(import.meta.dirname, "..");
const scratch = path.resolve(root, "..", ".tmp");
fs.mkdirSync(scratch, { recursive: true });
const boot = path.join(root, "lib/boot.js");
const tmp = fs.mkdtempSync(path.join(scratch, "batch-"));
const sock = path.join(tmp, "run.sock");

let daemon: ReturnType<typeof spawn> | null = null;

const waitFor = async (ok: () => boolean, ms = 3000): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return ok();
};

const isSocket = (p: string): boolean => {
  try {
    return fs.statSync(p).isSocket();
  } catch {
    return false;
  }
};

type Run = ReturnType<typeof spawnSync> & { stdout: string; stderr: string };

const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}): Run =>
  spawnSync(process.execPath, [boot, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...extraEnv } }) as Run;

const launch = (args: string[], input?: string): Run =>
  spawnSync(process.execPath, [boot, "--socket", sock, ...args], {
    cwd: root,
    encoding: "utf8",
    input,
  }) as Run;

const batch = (code: string): Run => launch(["-c", code]);

before(async () => {
  daemon = spawn(process.execPath, [path.join(root, "lib/boot.js"), "--daemon", "--socket", sock], { stdio: "ignore" });
  assert.ok(await waitFor(() => isSocket(sock)), "daemon did not come up");
});

after(async () => {
  daemon?.kill("SIGTERM");
  await waitFor(() => daemon?.exitCode !== null, 2000);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("prints the value of an expression", () => {
  const r = batch("1 + 1");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "2\n");
  assert.equal(r.stderr, "");
});

test("prints the value as well as what the command printed", () => {
  const r = batch("await $`echo hello`");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^hello\nProcessOutput \{/);
});

test("prints a captured process output when it is referenced again", () => {
  assert.match(batch("globalThis.p = await $`echo 1`").stdout, /^1\nProcessOutput \{/);
  const again = batch("p");
  assert.match(again.stdout, /^ProcessOutput \{/);
  assert.match(again.stdout, /stdout: '1\\n'/);
});

test("declarations stay quiet, expression results do not", () => {
  assert.equal(batch("const x = 1").stdout, "");
  assert.equal(batch("undefined").stdout, "undefined\n");
});

test("runs in the caller's directory, with the globals", () => {
  assert.equal(batch("process.cwd()").stdout.trim(), `'${root}'`);
  assert.equal(batch("_.chunk([1, 2, 3, 4], 2)").stdout.trim(), "[ [ 1, 2 ], [ 3, 4 ] ]");
});

test("strips types, like the repl does", () => {
  const r = batch("const n: number = 2\nn * 21");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "42\n");
});

test("shares state with the daemon", () => {
  assert.equal(batch("globalThis.shared = 41").stdout, "41\n");
  assert.equal(batch("shared + 1").stdout, "42\n");
});

test("errors go to stderr in plain text, with exit code 1", () => {
  const r = batch("throw new Error('boom')");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /boom/);
  assert.doesNotMatch(r.stderr, /\u001b/, "colours must be off when stderr is a pipe");
});

test("keeps an exit code set by the code, and only for that run", () => {
  assert.equal(batch("process.exitCode = 3").status, 3);
  assert.equal(batch("1 + 1").status, 0);
});

test("asks for a value when -c has none", () => {
  const r = launch(["-c"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /-c needs a value/);
});

test("refuses to run without a daemon to talk to", () => {
  const r = run(["-c", "1 + 1"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no session socket/);
});

test("starts the session daemon when nothing listens yet", async () => {
  const fresh = path.join(tmp, "fresh.sock");
  const r = run(["-c", "1 + 1", "--socket", fresh]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "2\n");
  assert.ok(isSocket(fresh));
  const pid = Number(fs.readFileSync(`${fresh}.pid`, "utf8"));
  process.kill(pid, "SIGTERM");
  await waitFor(() => !isSocket(fresh), 2000);
});

test("runs a file with -f, and stdin with -f -", () => {
  const file = path.join(tmp, "script.ts");
  fs.writeFileSync(file, "const m: number = 6\nm * 7\n");
  assert.equal(launch(["-f", file]).stdout, "42\n");
  assert.equal(launch(["-f", "-"], "40 + 2").stdout, "42\n");
  const missing = launch(["-f", path.join(tmp, "nope.ts")]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /ENOENT/);
});

test("escaped shell words survive $`…`", () => {
  for (const word of ["fi le.txt", "a*b", "b's", "a`b", "a${x}b"]) {
    const code = `$\`printf '%s' ${escapeShellWord(word)}\``;
    assert.ok(batch(code).stdout.startsWith(word), code);
  }
});
