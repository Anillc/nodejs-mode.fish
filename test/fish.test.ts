import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { escapeShellWord, openQuote, parseCompletions, shellCompletions } from "../src/fish.ts";

const hasFish = spawnSync("fish", ["-c", "true"]).status === 0;

test("parseCompletions splits candidates from descriptions", () => {
  const items = parseCompletions("checkout\tSwitch branches\ncherry\n\n");
  assert.deepEqual(items, [{ text: "checkout", desc: "Switch branches" }, { text: "cherry" }]);
});

test("parseCompletions keeps spaces inside a candidate", () => {
  assert.deepEqual(parseCompletions("fi le.txt\n"), [{ text: "fi le.txt" }]);
});

test("escapeShellWord quotes what the shell would treat specially", () => {
  assert.equal(escapeShellWord("plain"), "plain");
  assert.equal(escapeShellWord("src/"), "src/");
  assert.equal(escapeShellWord("fi le.txt"), "'fi le.txt'");
  assert.equal(escapeShellWord("a*b"), "'a*b'");
  assert.equal(escapeShellWord("b's"), "$'b\\\\'s'");
  assert.equal(escapeShellWord("a`b"), "'a\\`b'");
  assert.equal(escapeShellWord("a${x}b"), "'a\\${x}b'");
});

test("openQuote sees an unclosed quote but not a closed one", () => {
  assert.equal(openQuote("ls "), null);
  assert.equal(openQuote("ls 'fi"), "'");
  assert.equal(openQuote('ls "fi'), '"');
  assert.equal(openQuote("ls 'a b' fi"), null);
  assert.equal(openQuote("ls 'a' 'b"), "'");
});

test("fish completes commands with descriptions", { skip: !hasFish }, async () => {
  const items = await shellCompletions("git ch");
  const checkout = items.find((item) => item.text === "checkout");
  assert.ok(checkout, JSON.stringify(items));
  assert.ok(checkout.desc, "git completion should carry a description");
});

test("fish completion runs in the caller's cwd", { skip: !hasFish }, async () => {
  const items = await shellCompletions("cd ");
  assert.ok(items.length > 0, "expected the directories of the repo");
  assert.ok(items.every((item) => item.text.endsWith("/")), JSON.stringify(items));
  assert.ok(items.some((item) => item.text === "src/"), JSON.stringify(items));
});
