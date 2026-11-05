import process from "node:process";
import { parseArgs } from "node:util";

export interface Args {
  daemon?: boolean;
  code?: string;
  file?: string;
  socket?: string;
  state?: string;
  seed?: string;
  header?: string;
  prepainted?: boolean;
  parent?: string;
}

const { values, positionals } = parseArgs({
  strict: false,
  allowPositionals: true,
  options: {
    daemon: { type: "boolean" },
    code: { type: "string", short: "c" },
    file: { type: "string", short: "f" },
    socket: { type: "string" },
    state: { type: "string" },
    seed: { type: "string" },
    header: { type: "string" },
    prepainted: { type: "boolean" },
    parent: { type: "string" },
  },
});

if (values.socket === undefined && process.env.SAKANAJS_SOCKET) {
  values.socket = process.env.SAKANAJS_SOCKET;
}

export const args = values as Args;
export { positionals };
