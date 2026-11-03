import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const scratch = path.resolve(root, "..", ".tmp");
fs.mkdirSync(scratch, { recursive: true });
const hasFish = spawnSync("fish", ["--version"], { stdio: "ignore" }).status === 0;

const runFish = (dir: string, body: string): ReturnType<typeof spawnSync> & { stdout: string; stderr: string } =>
  spawnSync("fish", ["-c", `set -gx NODEJS_MODE_RUNTIME_DIR ${dir}\nsource ${path.join(root, "../conf.d/nodejs-mode.fish")}\n${body}`], {
    encoding: "utf8",
    timeout: 20000,
  }) as ReturnType<typeof spawnSync> & { stdout: string; stderr: string };

describe("fish plugin", { skip: hasFish ? false : "fish not installed" }, () => {
  it("reuses a live daemon instead of starting another", () => {
    const dir = fs.mkdtempSync(path.join(scratch, "fish-"));
    const script = `
      set -l s1 (__nodejs_mode_ensure_daemon); or exit 11
      __nodejs_mode_daemon_alive $s1; or exit 12
      set -l s2 (__nodejs_mode_ensure_daemon); or exit 13
      set -l s3 (__nodejs_mode_ensure_daemon); or exit 14
      test "$s1" = "$s2"; or exit 15
      test "$s2" = "$s3"; or exit 16
      set -l n (pgrep -f "nodejs-mode-daemon --socket \$s1" | count)
      echo "ok daemons=\$n"
    `;
    try {
      const r = runFish(dir, script);
      assert.equal(r.status, 0, `fish exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stdout, /ok daemons=1/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs code and files through the session daemon", () => {
    const dir = fs.mkdtempSync(path.join(scratch, "fish-run-"));
    const file = path.join(dir, "s.ts");
    fs.writeFileSync(file, 'const who: string = "file"\nwho + " ok"\n');
    const body = `
      nodejs-mode -c 'globalThis.n = 20'; or exit 21
      nodejs-mode -c 'n + 22'; or exit 22
      nodejs-mode '6 * 7'; or exit 23
      echo '40 + 2' | nodejs-mode; or exit 24
      nodejs-mode ${file}; or exit 25
      set -l sock (__nodejs_mode_socket)
      set -l n (pgrep -f "nodejs-mode-daemon --socket \$sock" | count)
      test $n -eq 1; or exit 26
    `;
    try {
      const r = runFish(dir, body);
      assert.equal(r.status, 0, `fish exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.equal(r.stdout.trim().split("\n").join(","), "20,42,42,42,'file ok'");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
