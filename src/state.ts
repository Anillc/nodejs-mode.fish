export function fishQuote(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function stateCode(initialCwd: string, initialEnv: NodeJS.ProcessEnv): string {
  const lines: string[] = [];
  const cwd = process.cwd();
  if (cwd !== initialCwd) lines.push(`cd -- ${fishQuote(cwd)}`);
  for (const [k, v] of Object.entries(process.env)) {
    if (initialEnv[k] === v) continue;
    if (v === undefined) lines.push(`set -e ${k}`);
    else lines.push(`set -gx ${k} ${fishQuote(v)}`);
  }
  for (const k of Object.keys(initialEnv)) {
    if (!(k in process.env)) lines.push(`set -e ${k}`);
  }
  return lines.join("\n");
}

export function applyEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in env)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
