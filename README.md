<div align="center">

# sakanajs

**Press `Ctrl-X` and your fish prompt becomes a Node.js REPL.**

zx's `` $`...` ``, shelljs commands, lodash's `_`, TypeScript, auto-require, tab completion —
and when you go back to fish, the working directory and environment are still there.

[![node](https://img.shields.io/badge/node-%E2%89%A5%2022.18-3c873a?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![fish](https://img.shields.io/badge/fish-%E2%89%A5%204.0-4b8f7f?logo=fish&logoColor=white)](https://fishshell.com)
[![demo](https://img.shields.io/badge/%E2%96%B6%20asciinema-recording-6f42c1)](https://asciinema.org/a/1270822)

[![demo](docs/demo.gif)](https://asciinema.org/a/1270822)

*A real session: zx, the completion menu, a typed const, `cd` — and back in fish.*

</div>

```console
sakanajs  via node v24.21.0
❯                       # press Ctrl-X here
js ❯ const t = await $`uname -s`
Linux
js ❯ t.stdout.trim()
'Linux'
js ❯ const n: number = 42
js ❯ n + 1
43
js ❯ _.chunk([1, 2, 3, 4], 2)
[ [ 1, 2 ], [ 3, 4 ] ]
js ❯ (Ctrl-D)
sakanajs  via node v24.21.0
❯
```

## Install

```fish
npm i -g sakanajs
fisher install Anillc/sakanajs   # or: omf install Anillc/sakanajs
exec fish
```

The fish side looks for the `sakanajs` command on `PATH`.

Working on the plugin itself:

```fish
npm --prefix sakanajs ci
npm --prefix sakanajs run build
set -gx PATH (realpath sakanajs/bin) $PATH
fisher install (realpath .)
```

- requires `node >= 22.18` (the npm package ships the built `lib/`, so users don't need tsc)
- requires `fish >= 4.0` (developed on 4.9.3)
- dependencies are managed with npm; there's a `flake.nix`, so `direnv allow` or `nix develop` works too

## What's in there

| | |
|---|---|
| **`$` is zx** | `` $`...` ``, `.pipe()`, `.nothrow()`, `.text()`, top-level `await`; stdio is zx's default (`pipe`), so output is captured — ask for the terminal with `$({ stdio: "inherit" })` for `vim` / `ssh` / `less` |
| **Globals** | every zx export, every shelljs command, and `_` (lodash) — no imports needed |
| **Auto-require** | a name that isn't defined anywhere in the global scope is tried as `require(name)` (resolved from the cwd), so `fs.readFileSync(...)` and `os.uptime()` just work |
| **TypeScript** | type annotations, `enum`, `import type` — powered by Node's own `stripTypeScriptTypes`; no tsx or esbuild needed |
| **import** | a static `import x from "y"` is rewritten to `await import()`; dynamic `import()` resolves from the cwd; `require("./x.ts")` works too |
| **cwd / env** | changes made by `cd()` and `process.env` are written back to fish; a `cd` you do in fish is picked up when you re-enter |
| **Completion** | Tab: keywords, declared names, globals, properties after `obj.`, and paths; an empty line (or an empty `` $`...` ``) lists what is available without touching the line; multiple candidates are listed under the input line and Tab cycles through them (the current one is inverted). Inside `` $`...` `` it hands over to fish, so commands, flags and files come with their descriptions |
| **State** | one daemon per fish session keeps variables and functions across commands, and is cleaned up on `fish_exit` |

## Keys

| Key | Action |
|---|---|
| `Ctrl-X` | enter from fish (the current command line becomes the `` $`...` `` seed); exits when already in the mode |
| `Ctrl-D` | leave, back to fish |
| `Enter` (completion menu open) | accept the highlighted candidate and close the menu, **without running it** — press again to run (same as fish) |
| `Enter` on an empty line | open a fresh `js ❯` line, stay in the mode |
| `Ctrl-C` | keep what you typed, add `^C`, start a new line; while evaluating, it interrupts the code (a stuck `await`, a synchronous loop) and kills its child processes |
| `Tab` | completion (see above) — inside `` $`...` `` fish completes it |
| `Up` / `Down` | history (stored separately from fish's) |
| `Ctrl-A/E/B/F/K/U/W` | line editing |

## Batch mode

`sakanajs` is the command npm installs; run it with no arguments and it enters the repl the same way `Ctrl-X`
does.

```console
$ sakanajs                     # enter the repl (same as Ctrl-X)
$ sakanajs -c '1 + 1'          # one command
2
$ sakanajs build.ts            # one file — "$", "_", shelljs and TypeScript included
$ echo '40 + 2' | sakanajs     # code on stdin
42
```

It always goes through the session daemon — the same one `Ctrl-X` uses. The plugin exports `SAKANAJS_SOCKET`
(`$XDG_RUNTIME_DIR/sakanajs-<uid>/sakanajs-<fish pid>.sock`) and `SAKANAJS_PARENT` when the shell starts; if
nothing listens there yet, the client starts the daemon itself, and `Ctrl-X` later picks it up with the state
the script left behind. `-c <code>`, `-f <file>` (or `-f -` for stdin), a bare file path and a bare expression
are the ways to say what to run. There is no in-process mode: a command without a session socket is an error,
not a second way to run code.

## Why every command goes back to fish

Each command is a short-lived node process: connect to the daemon, evaluate, exit — then fish redraws
its prompt from real state and the mode re-enters itself. That's why cwd, git branch and the clock are
fresh for every command, and the prompt can never disagree with the shell.

The cost is one process spawn per command: ~100ms for the client, ~2ms for the round trip inside the
daemon (measured). What you get back is a prompt that is always authoritative.

## Architecture

```
Ctrl-X ─▶ __sakanajs_enter ─▶ boot.ts (paints the prompt first) ─▶ cli.ts
              ▲                                                    │
              │                                                    ├─ eval  ─▶ daemon (variables / cwd / env live here)
              │                                                    └─ spawn ─▶ child process (in the daemon; $({ stdio: "inherit" }) goes through the client)
              └──── fish repaint ◀── exit 42 ◀─────────────────────┘
```

`cli.ts` is one process per command; `daemon.ts` is one process per fish session and they talk over a
unix socket.

## Known limitations

- `Ctrl-C` interrupts the evaluation, not a promise somebody else is already awaiting: a background process started by an earlier command keeps running (until the next `Ctrl-C`).
- If the daemon dies, the command in flight is lost. The repl starts a new one and says so (earlier variables are gone) — retype it.
- Interactive children need `$({ stdio: "inherit" })` to get the terminal; without it they see a pipe and `vim` / `less` degrade to a dumb terminal.
- Anything that reads stdin, like `question()`, doesn't work: the daemon's stdin is `/dev/null`.
- A script run through the daemon that calls `process.exit()` takes the daemon down with it; the next command starts a new one.
- The daemon runs the code it was started with, so restart fish after editing the repo.
- TypeScript is handled lazily (compile as JS first, strip types only if that fails), so the source snippet in a TS error is the transformed one.
- If `fish_prompt` is wider than the terminal (it wraps), entering/exiting leaves half of the old prompt above the block.
- The completion menu stops at 8 rows.
- Only verified on fish 4.9.3 and node 24.

## Development

```fish
npm --prefix sakanajs run build         # tsc -> lib/
npm --prefix sakanajs run typecheck     # tsc --noEmit
npm --prefix sakanajs test          # build + node --test
```

pty regression (drives a real fish in a pty and dumps the screen):

```fish
node sakanajs/scripts/pty-drive.mjs '[{"d":400,"s":"\u0018"},{"d":900,"s":"1 + 1\r"},{"d":600,"s":"\u0004"}]'
node sakanajs/scripts/pty-drive.mjs '[{"d":400,"s":"\u0018"},{"d":900,"s":"1 + 1\r"},{"d":600,"s":"\u0004"}]' two vi
```

`\u0018` is `Ctrl-X`, `\u0004` is `Ctrl-D`; the third argument `two` / `three` switches to a multi-line
prompt and `vi` enables `fish_vi_key_bindings`. A `{"run": "command"}` step runs a shell command on the
host (e.g. `kill -9` the daemon to check recovery).

The screen is rendered with `@xterm/headless` (a dev dependency), but it can only verify behaviour: the
fish inside the harness runs with `--no-config`, and it repaints its prompt differently (it draws `⏎`
marker lines and never moves the cursor up) than a real, fully configured shell. So **cursor geometry
can't be judged there** — check it in a real terminal.

