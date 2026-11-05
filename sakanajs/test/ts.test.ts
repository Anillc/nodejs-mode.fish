import test from "node:test";
import assert from "node:assert/strict";
import { prepareCode, rewriteImports } from "../src/eval.ts";

test("static imports become await import", () => {
  assert.equal(rewriteImports('import fs from "node:fs"'), 'const fs = (await import("node:fs")).default;');
  assert.equal(rewriteImports('import { a, b as c } from "m"'), 'const { a, b: c } = (await import("m"));');
  assert.equal(rewriteImports('import * as ns from "m"'), 'const ns = (await import("m"));');
  assert.equal(rewriteImports('import "m"'), 'await import("m");');
});

test("plain javascript is left alone", () => {
  assert.equal(rewriteImports("1 + 1"), "1 + 1");
});

test("type annotations are stripped, enums are transformed", () => {
  assert.match(prepareCode("const x: number = 1"), /const x = 1/);
  assert.match(prepareCode("enum E { A }"), /var E/);
  assert.doesNotMatch(prepareCode("import type { X } from \"m\""), /import type/);
});
