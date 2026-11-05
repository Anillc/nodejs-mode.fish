# sakanajs

The node half of [sakanajs](https://github.com/Anillc/sakanajs): a `sakanajs` command that
runs one snippet or file (`-c` / `-f`) and a per-session daemon (`--daemon`) that keeps the state.

```console
$ sakanajs -c '1 + 1'
2
```

Installing this package is only half of it — the fish plugin (conf.d + functions) lives in the repository
above and is what binds `Ctrl-X`. See its README.
