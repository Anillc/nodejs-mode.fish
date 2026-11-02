import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const hasFish = spawnSync("fish", ["--version"], { stdio: "ignore" }).status === 0;

describe("fish plugin", { skip: hasFish ? false : "fish not installed" }, () => {
  it("reuses a live daemon instead of starting another", () => {
    const dir = fs.mkdtempSync(path.join(root, ".tmp", "fish-"));
    const script = `
      set -gx NODEJS_MODE_RUNTIME_DIR ${dir}
      source ${path.join(root, "fish/conf.d/nodejs-mode.fish")}
      set -l s1 (__nodejs_mode_ensure_daemon); or exit 11
      __nodejs_mode_daemon_alive $s1; or exit 12
      set -l s2 (__nodejs_mode_ensure_daemon); or exit 13
      set -l s3 (__nodejs_mode_ensure_daemon); or exit 14
      test "$s1" = "$s2"; or exit 15
      test "$s2" = "$s3"; or exit 16
      set -l n (pgrep -f "daemon.ts --socket \$s1" | count)
      echo "ok daemons=\$n"
    `;
    try {
      const r = spawnSync("fish", ["-c", script], { encoding: "utf8", timeout: 20000 });
      assert.equal(r.status, 0, `fish exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stdout, /ok daemons=1/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
