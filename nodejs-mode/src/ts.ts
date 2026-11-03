import { stripTypeScriptTypes } from "node:module";
import { parser } from "@lezer/javascript";
import type { SyntaxNode } from "@lezer/common";

// 预热一次：ExperimentalWarning 只出一次，让它落在 daemon 启动阶段（进 log，不刷屏）
try {
  stripTypeScriptTypes("let __warmup: number = 0");
} catch {
  /* 忽略 */
}

function child(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) return c;
  return null;
}

function importBinding(node: SyntaxNode, code: string): string | null {
  const source = child(node, "String");
  if (!source) return null;
  const from = code.slice(source.from, source.to);
  // 括号别省：await import(x).default 会先取 promise 的 default
  const load = `(await import(${from}))`;

  const group = child(node, "ImportGroup");
  if (group) {
    const names: string[] = [];
    let original: string | null = null;
    for (let c = group.firstChild; c; c = c.nextSibling) {
      const text = code.slice(c.from, c.to);
      if (c.name === "VariableName") original = text;
      else if (c.name === "VariableDefinition") {
        names.push(original ? `${original}: ${text}` : text);
        original = null;
      }
    }
    const parts: string[] = [];
    const def = child(node, "VariableDefinition");
    if (def) parts.push(`const ${code.slice(def.from, def.to)} = ${load}.default`);
    if (names.length) parts.push(`const { ${names.join(", ")} } = ${load}`);
    return parts.length ? `${parts.join("; ")};` : `await import(${from});`;
  }

  const name = child(node, "VariableDefinition");
  if (!name) return `await import(${from});`;
  const binding = code.slice(name.from, name.to);
  return child(node, "Star") ? `const ${binding} = ${load};` : `const ${binding} = ${load}.default;`;
}

// vm.Script 里不能有静态 import，改写成 await import()，再交给顶层 await 那套包装
export function rewriteImports(code: string): string {
  const edits: Array<{ from: number; to: number; text: string }> = [];
  for (let node = parser.parse(code).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== "ImportDeclaration") continue;
    const text = importBinding(node, code);
    if (text) edits.push({ from: node.from, to: node.to, text });
  }
  let out = code;
  for (const edit of edits.reverse()) out = out.slice(0, edit.from) + edit.text + out.slice(edit.to);
  return out;
}

// 先剥类型再改写 import；剥不动就说明不是 TS（或有语法错），原样交回去让 vm 报错
export function prepareCode(code: string): string {
  try {
    return rewriteImports(stripTypeScriptTypes(code, { mode: "transform" }));
  } catch {
    return code;
  }
}
