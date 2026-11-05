import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const scratch = path.resolve(root, "..", ".tmp");
fs.mkdirSync(scratch, { recursive: true });
const hasFish = spawnSync("fish", ["--version"], { stdio: "ignore" }).status === 0;

const runFish = (dir: string, body: string): ReturnType<typeof spawnSync> & { stdout: string; stderr: string } => {
  const home = fs.mkdtempSync(path.join(dir, "xdg-"));
  fs.mkdirSync(path.join(home, "data-dirs"), { recursive: true });
  fs.mkdirSync(path.join(home, "fish", "conf.d"), { recursive: true });
  fs.cpSync(path.join(root, "..", "conf.d"), path.join(home, "fish", "conf.d"), { recursive: true });
  const script = [
    `set -gx SAKANAJS_RUNTIME_DIR ${dir}`,
    `source ${path.join(home, "fish/conf.d/sakanajs.fish")}`,
    body,
  ].join("\n");
  return spawnSync("fish", ["--no-config", "-c", script], {
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_DATA_DIRS: path.join(home, "data-dirs"),
      PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
    },
  }) as ReturnType<typeof spawnSync> & { stdout: string; stderr: string };
};

describe("fish plugin", { skip: hasFish ? false : "fish not installed" }, () => {
  it("keeps one daemon and shares state across calls", () => {
    const dir = fs.mkdtempSync(path.join(scratch, "fish-"));
    const script = `
      sakanajs -c 'globalThis.n = 20'; or exit 11
      sakanajs -c 'n + 22'; or exit 12
      set -l n (pgrep -f -- "--daemon --socket \$SAKANAJS_SOCKET" | count)
      test $n -eq 1; or exit 13
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

  it("runs code, stdin and files through the session daemon", () => {
    const dir = fs.mkdtempSync(path.join(scratch, "fish-run-"));
    const file = path.join(dir, "s.ts");
    fs.writeFileSync(file, 'const who: string = "file"\nwho + " ok"\n');
    const body = `
      sakanajs -c 'globalThis.n = 20'; or exit 21
      sakanajs -c 'n + 22'; or exit 22
      sakanajs '6 * 7'; or exit 23
      echo '40 + 2' | sakanajs; or exit 24
      sakanajs ${file}; or exit 25
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
