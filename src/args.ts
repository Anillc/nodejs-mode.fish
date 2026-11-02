import { parseArgs } from "node:util";

export interface Args {
  socket?: string;
  state?: string;
  seed?: string;
  header?: string;
  prepainted?: boolean;
  parent?: string;
}

const { values } = parseArgs({
  strict: false,
  allowPositionals: true,
  options: {
    socket: { type: "string" },
    state: { type: "string" },
    seed: { type: "string" },
    header: { type: "string" },
    prepainted: { type: "boolean" },
    parent: { type: "string" },
  },
});

export const args = values as Args;
