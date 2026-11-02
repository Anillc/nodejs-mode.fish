import { parser } from "@lezer/javascript";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import type { SyntaxNode } from "@lezer/common";

export type TokenType =
  | "kw"
  | "num"
  | "str"
  | "tpl"
  | "comment"
  | "ident"
  | "punct"
  | "tag"
  | "sh-cmd"
  | "sh-flag"
  | "sh-str"
  | "sh-var"
  | "sh-op"
  | "sh-path";

export interface Token {
  type: TokenType;
  start: number;
  end: number;
}

const HIGHLIGHTER = tagHighlighter([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], class: "kw" },
  { tag: [t.self, t.bool, t.null, t.special(t.variableName)], class: "kw" },
  { tag: [t.string, t.special(t.string), t.escape], class: "str" },
  { tag: [t.number, t.integer, t.float], class: "num" },
  { tag: [t.lineComment, t.blockComment, t.comment], class: "comment" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "ident" },
  { tag: [t.propertyName, t.variableName, t.definition(t.variableName), t.typeName, t.labelName], class: "ident" },
  { tag: [t.operator, t.punctuation, t.bracket, t.derefOperator], class: "punct" },
]);

const SHELL_OPERATORS = "|&;<>()";

function shellTokens(src: string, from: number, to: number, out: Token[]): void {
  let i = from;
  let wordStart = true;
  while (i < to) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (SHELL_OPERATORS.includes(c)) {
      out.push({ type: "sh-op", start: i, end: i + 1 });
      i++;
      wordStart = true;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < to && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      j = Math.min(j + 1, to);
      out.push({ type: "sh-str", start: i, end: j });
      wordStart = false;
      i = j;
      continue;
    }
    if (c === "$" && /[A-Za-z_{@*#?$!0-9]/.test(src[i + 1] ?? "")) {
      let j = i + 1;
      if (src[j] === "{") {
        j++;
        while (j < to && src[j] !== "}") j++;
        j = Math.min(j + 1, to);
      } else {
        while (j < to && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      }
      out.push({ type: "sh-var", start: i, end: j });
      wordStart = false;
      i = j;
      continue;
    }
    let j = i;
    while (j < to && !/[\s]/.test(src[j]!) && !SHELL_OPERATORS.includes(src[j]!)) j++;
    const word = src.slice(i, j);
    out.push({ type: wordStart ? "sh-cmd" : word.startsWith("-") ? "sh-flag" : "sh-path", start: i, end: j });
    wordStart = false;
    i = j;
  }
}

function walk(node: SyntaxNode, fn: (n: SyntaxNode) => boolean | void): void {
  if (fn(node) === false) return;
  for (let c = node.firstChild; c; c = c.nextSibling) walk(c, fn);
}

export function highlight(code: string): Token[] {
  const tree = parser.parse(code);
  const tokens: Token[] = [];
  highlightTree(tree, HIGHLIGHTER, (from, to, classes) => {
    const name = classes.split(" ")[0];
    if (name) tokens.push({ type: name as TokenType, start: from, end: to });
  });

  walk(tree.topNode, (node) => {
    if (node.name !== "TaggedTemplateExpression") return;
    const tag = node.firstChild;
    const tpl = tag?.nextSibling;
    if (!tag || tag.name !== "VariableName" || code.slice(tag.from, tag.to) !== "$") return;
    if (!tpl || tpl.name !== "TemplateString") return;
    tokens.push({ type: "tag", start: tag.from, end: tag.to });
    const open = tpl.from;
    const close = tpl.to - 1;
    tokens.push({ type: "tpl", start: open, end: open + 1 });
    if (close > open) tokens.push({ type: "tpl", start: close, end: close + 1 });
    let pos = open + 1;
    for (let c = tpl.firstChild; c; c = c.nextSibling) {
      if (c.name !== "Interpolation") continue;
      if (c.from > pos) shellTokens(code, pos, c.from, tokens);
      pos = c.to;
    }
    if (pos < close) shellTokens(code, pos, close, tokens);
  });

  return tokens.sort((a, b) => a.start - b.start || a.end - b.end);
}

// 最后一条语句是不是表达式（是的话连 undefined 也当结果打印）
export function isExpressionResult(code: string): boolean {
  let last: { name: string } | null = null;
  for (let c = parser.parse(code).topNode.firstChild; c; c = c.nextSibling) last = c;
  return last?.name === "ExpressionStatement";
}

// 代码里引用到的名字（不含属性名、声明名），给自动 require 用
// 顶层声明的名字（const/let/var/function/class/解构），给补全用
export function declaredNames(code: string): string[] {
  const out: string[] = [];
  for (let c = parser.parse(code).topNode.firstChild; c; c = c.nextSibling) out.push(...declarationNames(c, code));
  return out;
}

export function referencedNames(code: string): string[] {
  const names = new Set<string>();
  walk(parser.parse(code).topNode, (node) => {
    if (node.name === "VariableName") names.add(code.slice(node.from, node.to));
  });
  return [...names];
}

export function isComplete(code: string): boolean {
  if (!code.trim()) return true;
  let incomplete = false;
  parser.parse(code).iterate({
    enter(node) {
      if (node.type.isError && node.to >= code.length - 1 && node.from >= code.length - 1) incomplete = true;
    },
  });
  return !incomplete;
}

const NOT_TOP_LEVEL = /Function|ArrowFunction|MethodDeclaration|ClassDeclaration/;

export function hasTopLevelAwait(code: string): boolean {
  let found = false;
  walk(parser.parse(code).topNode, (node) => {
    if (found) return false;
    if (node.name !== "Script" && NOT_TOP_LEVEL.test(node.name)) return false;
    if (node.name === "AwaitExpression") {
      found = true;
      return false;
    }
    return undefined;
  });
  return found;
}

function patternNames(node: SyntaxNode, code: string, out: string[]): void {
  walk(node, (n) => {
    if (n.name === "VariableDefinition") out.push(code.slice(n.from, n.to));
  });
}

function declarationNames(node: SyntaxNode, code: string): string[] {
  const names: string[] = [];
  if (node.name === "VariableDeclaration") {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.name === "VariableDefinition") names.push(code.slice(c.from, c.to));
      else if (c.name === "ObjectPattern" || c.name === "ArrayPattern") patternNames(c, code, names);
    }
    return names;
  }
  if (node.name === "FunctionDeclaration" || node.name === "ClassDeclaration") {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.name === "VariableDefinition") {
        names.push(code.slice(c.from, c.to));
        break;
      }
    }
  }
  return names;
}

export function rewriteForAsync(code: string, returnLast = false): string {
  const inserts: Array<{ at: number; text: string }> = [];
  let last: SyntaxNode | null = null;
  for (let c = parser.parse(code).topNode.firstChild; c; c = c.nextSibling) {
    last = c;
    const names = declarationNames(c, code);
    if (!names.length) continue;
    inserts.push({ at: c.to, text: `;${names.map((n) => `globalThis.${n} = ${n};`).join("")}` });
  }
  if (returnLast && last && last.name === "ExpressionStatement") {
    inserts.push({ at: last.from, text: "return " });
  }
  if (!inserts.length) return code;
  inserts.sort((a, b) => b.at - a.at);
  let out = code;
  for (const ins of inserts) out = out.slice(0, ins.at) + ins.text + out.slice(ins.at);
  return out;
}

export function wrapForAwait(code: string): string {
  return `(async () => {\n${rewriteForAsync(code, true)}\n})()`;
}

export function isBareShellCommand(code: string): boolean {
  const tree = parser.parse(code);
  const stmt = tree.topNode.firstChild;
  if (!stmt || stmt.name !== "ExpressionStatement" || stmt.nextSibling) return false;
  let expr: SyntaxNode | null = stmt.firstChild;
  if (expr?.name === "AwaitExpression") {
    expr = expr.lastChild;
  }
  if (!expr || expr.name !== "TaggedTemplateExpression") return false;
  const tag = expr.firstChild;
  if (!tag || tag.name !== "VariableName" || code.slice(tag.from, tag.to) !== "$") return false;
  return expr.nextSibling === null;
}
