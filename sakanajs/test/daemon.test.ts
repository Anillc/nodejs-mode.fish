import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Remote } from "../src/remote.ts";

const root = path.resolve(import.meta.dirname, "..");
const scratch = path.resolve(root, "..", ".tmp");
fs.mkdirSync(scratch, { recursive: true });
const tmp = fs.mkdtempSync(path.join(scratch, "daemon-test-"));

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

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

const exists = (p: string): boolean => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

const mode = (p: string): number => {
  try {
    return fs.statSync(p).mode & 0o777;
  } catch {
    return -1;
  }
};

function start(sock: string, extra: string[] = []): { cp: ChildProcess; output: () => string } {
  const cp = spawn(process.execPath, [path.join(root, "lib/boot.js"), "--daemon", "--socket", sock, ...extra], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  cp.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  cp.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  return { cp, output: () => out };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("daemon", () => {
  it("creates socket + pidfile and cleans both up on SIGTERM", async () => {
    let n = 0;
    const sock = path.join(tmp, `s${n++}.sock`);
    const { cp } = start(sock);
    try {
      assert.ok(await waitFor(() => isSocket(sock)), "socket did not appear");
      const pidPath = `${sock}.pid`;
      assert.ok(await waitFor(() => exists(pidPath)), "pidfile missing");
      assert.equal(Number(fs.readFileSync(pidPath, "utf8").trim()), cp.pid);
      assert.ok(await waitFor(() => mode(sock) === 0o600), "socket is not 0600");

      cp.kill("SIGTERM");
      await waitFor(() => cp.exitCode !== null);
      assert.ok(await waitFor(() => !exists(sock) && !exists(pidPath)), "socket/pidfile left behind");
    } finally {
      cp.kill("SIGKILL");
    }
  });

  it("keeps state across connections", async () => {
    const sock = path.join(tmp, "state.sock");
    const { cp } = start(sock);
    try {
      assert.ok(await waitFor(() => isSocket(sock)), "socket did not appear");
      const run = async (code: string): Promise<string> => {
        const r = await Remote.connect(sock);
        let out = "";
        await r.eval(code, root, process.env, (_s, d) => (out += d));
        r.close();
        return out;
      };
      assert.equal(await run("const x = 42"), "", "declaration should print nothing");
      assert.match(await run("x + 1"), /43/);
      assert.equal(await run("function double(a){ return a * 2 }"), "", "declaration should print nothing");
      assert.match(await run("double(21)"), /42/);
      assert.equal(await run("undefined"), "undefined\n", "expression result should print");
      assert.match(await run("null"), /null/);
      assert.match(await run("zlib.gunzipSync(zlib.gzipSync('hi')).toString()"), /'hi'/, "auto-require failed");
      assert.match(await run("no_such_name_xyz"), /ReferenceError/, "unknown names must still throw");
    } finally {
      cp.kill("SIGTERM");
    }
  });

  it("completes globals, declared names and properties", async () => {
    const sock = path.join(tmp, "complete.sock");
    const { cp } = start(sock);
    try {
      assert.ok(await waitFor(() => isSocket(sock)), "socket did not appear");
      const r = await Remote.connect(sock);
      await r.eval("const fooBar = 1", root, process.env, () => {});
      assert.deepEqual(await r.complete("fooB"), ["fooBar"]);
      assert.deepEqual(await r.complete("up", "os"), ["uptime"]);
      assert.ok((await r.complete("pw")).includes("pwd"));
      const con = await r.complete("con");
      assert.ok(con.includes("const"), "keywords complete");
      assert.ok(con.includes("console"), "non-enumerable globals complete");
      assert.ok((await r.complete("")).length > 50, "an empty word lists everything");
      r.close();
    } finally {
      cp.kill("SIGTERM");
    }
  });

  it("aborts a running command on request", async () => {
    const sock = path.join(tmp, "abort.sock");
    const { cp } = start(sock);
    try {
      assert.ok(await waitFor(() => isSocket(sock)), "socket did not appear");
      const r = await Remote.connect(sock);
      const started = Date.now();
      const p = r.eval("await $`sleep 5`", root, process.env, () => {});
      await sleep(400);
      r.sendAbort();
      await p;
      assert.ok(Date.now() - started < 3000, "abort did not cut the command short");
      let out = "";
      await r.eval("1 + 1", root, process.env, (_s, d) => (out += d));
      assert.match(out, /2/, "daemon unusable after an abort");
      r.close();
    } finally {
      cp.kill("SIGTERM");
    }
  });

  it("stops a pending await on request", async () => {
    const sock = path.join(tmp, "abort-await.sock");
    const { cp } = start(sock);
    try {
      assert.ok(await waitFor(() => isSocket(sock)), "socket did not appear");
      const r = await Remote.connect(sock);
      const started = Date.now();
      let err = "";
      const p = r.eval("await new Promise(() => {})", root, process.env, (_s, d) => (err += d));
      await sleep(300);
      r.sendAbort();
      await p;
      assert.ok(Date.now() - started < 3000, "abort did not cut the await short");
      assert.match(err, /interrupted by/);
      let out = "";
      await r.eval("1 + 1", root, process.env, (_s, d) => (out += d));
      assert.match(out, /2/, "daemon unusable after an abort");
      r.close();
    } finally {
      cp.kill("SIGTERM");
    }
  });

  it("stops a synchronous loop on request", async () => {
    const sock = path.join(tmp, "abort-loop.sock");
    const { cp } = start(sock);
    try {
      assert.ok(await waitFor(() => isSocket(sock)), "socket did not appear");
      const r = await Remote.connect(sock);
      const started = Date.now();
      let err = "";
      const p = r.eval("while (true) {}", root, process.env, (_s, d) => (err += d));
      await sleep(300);
      r.sendAbort();
      await p;
      assert.ok(Date.now() - started < 3000, "abort did not cut the loop short");
      assert.match(err, /interrupted by/);
      let out = "";
      await r.eval("1 + 1", root, process.env, (_s, d) => (out += d));
      assert.match(out, /2/, "daemon unusable after an abort");
      r.close();
    } finally {
      cp.kill("SIGTERM");
    }
  });

  it("refuses to run without --socket", async () => {
    const cp = spawn(process.execPath, [path.join(root, "lib/boot.js"), "--daemon"], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    cp.stderr.on("data", (d: Buffer) => (err += d.toString()));
    await new Promise((r) => cp.on("exit", r));
    assert.equal(cp.exitCode, 2);
    assert.match(err, /needs --socket/);
  });

  it("reports a listen failure without a stack trace", async () => {
    const sock = path.join(tmp, "nope", "s.sock");
    const { cp, output } = start(sock);
    await new Promise((r) => cp.on("exit", r));
    assert.equal(cp.exitCode, 1);
    assert.match(output(), /cannot listen on .*s\.sock: E[A-Z]+/);
    assert.doesNotMatch(output(), /Unhandled 'error' event/);
  });

  it("exits when its parent goes away", async () => {
    const sock = path.join(tmp, "parent.sock");
    const fake = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
    const { cp } = start(sock, ["--parent", String(fake.pid)]);
    try {
      assert.ok(await waitFor(() => isSocket(sock)), "socket did not appear");
      fake.kill("SIGKILL");
      assert.ok(await waitFor(() => cp.exitCode !== null, 4000), "daemon outlived its parent");
      assert.ok(await waitFor(() => !exists(sock)), "socket left behind");
    } finally {
      cp.kill("SIGKILL");
      fake.kill("SIGKILL");
      await sleep(50);
    }
  });
});
