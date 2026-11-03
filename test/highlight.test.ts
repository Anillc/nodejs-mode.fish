import test from "node:test";
import assert from "node:assert/strict";
import { highlight, hasTopLevelAwait, isComplete, referencedNames, shellAt, wrapForAwait } from "../src/highlight.ts";
import { layout, locate, menuLines, paintRow, THEME } from "../src/render.ts";
import { stringWidth } from "../src/width.ts";
import { PROMPT_TEXT, PROMPT_COLS } from "../src/render.ts";
import { KeyDecoder } from "../src/keys.ts";

function kinds(code: string): string[] {
  return highlight(code).map((t) => `${t.type}:${code.slice(t.start, t.end)}`);
}

test("shell island is recognized inside a $ template", () => {
  const code = "await $`ls -la /tmp`";
  const k = kinds(code);
  assert.ok(k.includes("tag:$"), k.join(" "));
  assert.ok(k.includes("sh-cmd:ls"), k.join(" "));
  assert.ok(k.includes("sh-flag:-la"), k.join(" "));
  assert.ok(k.includes("sh-path:/tmp"), k.join(" "));
});

test("interpolation stays javascript", () => {
  const code = "$`echo ${name}`";
  const k = kinds(code);
  assert.ok(k.includes("sh-cmd:echo"), k.join(" "));
  assert.ok(k.includes("ident:name"), k.join(" "));
});

test("javascript outside the island is highlighted", () => {
  const k = kinds("const x = 1 // hi");
  assert.ok(k.includes("kw:const"), k.join(" "));
  assert.ok(k.includes("num:1"), k.join(" "));
  assert.ok(k.includes("comment:// hi"), k.join(" "));
});

test("plain template is not shell", () => {
  const k = kinds("x = `ls -la`");
  assert.ok(!k.some((t) => t.startsWith("sh-")), k.join(" "));
});

test("shellAt finds the shell segment under the cursor", () => {
  const open = "await $`git ch";
  assert.deepEqual(shellAt(open, open.length), { start: 8, end: 14 });
  const closed = "const x = $`git ch`";
  assert.deepEqual(shellAt(closed, closed.indexOf("h`") + 1), { start: 12, end: 18 });
  assert.equal(shellAt(closed, closed.length), null, "just after the closing backtick is javascript");
  assert.equal(shellAt("x = `ls`", 6), null, "a plain template is not shell");
  const interp = "$`echo ${name} x`";
  assert.equal(shellAt(interp, interp.indexOf("name") + 1), null, "interpolation is javascript");
});

test("incomplete input detection", () => {
  assert.equal(isComplete("1 + 1"), true);
  assert.equal(isComplete("const x = 1"), true);
  assert.equal(isComplete("if (x) {"), false);
  assert.equal(isComplete("foo(1,"), false);
  assert.equal(isComplete("$`ls -la"), false);
});

test("top level await detection", () => {
  assert.equal(hasTopLevelAwait("await foo()"), true);
  assert.equal(hasTopLevelAwait("async function f() { await foo() }"), false);
  assert.equal(hasTopLevelAwait("const f = async () => await g()"), false);
  assert.equal(hasTopLevelAwait("$`ls`"), false);
});

test("await wrapper rebinds top level declarations", () => {
  const wrapped = wrapForAwait("const a = await p(); function f() {}");
  assert.match(wrapped, /globalThis\.a = a/);
  assert.match(wrapped, /globalThis\.f = f/);
});

test("referenced names skip property access and declarations", () => {
  assert.deepEqual(referencedNames("os.uptime() + path.basename('/a')").sort(), ["os", "path"]);
  assert.deepEqual(referencedNames("const x = fs.readFileSync('a')"), ["fs"]);
});

test("layout wraps on display width", () => {
  const rows = layout("abcdefgh", 4, 0);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => [r.start, r.end]),
    [
      [0, 3],
      [3, 6],
      [6, 8],
    ],
  );
  assert.equal(locate(rows, "abcdefgh", 4).row, 1);
});

test("wide characters count as two columns", () => {
  assert.equal(stringWidth("中文"), 4);
  const rows = layout("中文中", 4, 0);
  assert.equal(rows.length, 3);
});

test("each token is painted with its theme", () => {
  const code = "$`ls -la`";
  const painted = paintRow(code, highlight(code), { start: 0, end: code.length, col: 0 });
  assert.ok(painted.text.includes(`\u001b[${THEME["sh-cmd"]}mls\u001b[0m`), painted.text);
  assert.equal(painted.width, stringWidth(code));
});

test("completion menu lays out columns and marks the selection", () => {
  assert.deepEqual(menuLines([], 0, 40), []);
  const one = menuLines([{ text: "chain" }, { text: "chunk" }], 1, 40);
  assert.equal(one.length, 1);
  assert.match(one[0]!, /^chain\s+\u001b\[7mchunk\s*\u001b\[0m$/);
  assert.equal(menuLines([{ text: "a" }, { text: "b" }, { text: "c" }], 0, 6).length, 2);
});

test("descriptions put the menu on one item per line", () => {
  const items = [
    { text: "checkout", desc: "Switch branches" },
    { text: "cherry-pick", desc: "Apply a commit" },
  ];
  const lines = menuLines(items, 0, 60);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^\u001b\[7mcheckout\s+\u001b\[0m\u001b\[2mSwitch branches/);
  assert.match(lines[1]!, /^cherry-pick\s+\u001b\[2mApply a commit/);
});

test("key decoder handles escape sequences and paste", () => {
  const d = new KeyDecoder();
  const keys = d.feed(Buffer.from("\u001b[A\u001b[Dx"));
  assert.deepEqual(
    keys.map((k) => k.t),
    ["up", "left", "text"],
  );
  const paste = new KeyDecoder().feed(Buffer.from("\u001b[200~a\nb\u001b[201~"));
  assert.deepEqual(paste, [{ t: "paste", text: "a\nb" }]);
});

test("utf8 split across chunks is decoded once", () => {
  const d = new KeyDecoder();
  const buf = Buffer.from("中");
  const first = d.feed(buf.subarray(0, 1));
  const second = d.feed(buf.subarray(1));
  assert.deepEqual([...first, ...second], [{ t: "text", text: "中" }]);
});

test("prompt width matches its plain text", () => {
  assert.equal(stringWidth(PROMPT_TEXT), PROMPT_COLS);
});
