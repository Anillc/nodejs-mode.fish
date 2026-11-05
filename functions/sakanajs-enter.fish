function sakanajs-enter --description "run the node.js repl in place (Ctrl-X)"
    set -l cli (command -s sakanajs)
    if test -z "$cli"
        printf '\e[31msakanajs: the sakanajs command is not on PATH\e[0m\n' >&2
        printf '  install it: npm i -g sakanajs\e[0m\n' >&2
        return 1
    end

    set -l state (command mktemp 2>/dev/null)
    if test -z "$state"
        # even with a broken TMPDIR, cwd/env must be written back
        set -l dir (__sakanajs_runtime_dir)
        if test -n "$dir"
            command mkdir -p -m 700 $dir 2>/dev/null
            set state $dir/sakanajs-$fish_pid.state
        else
            printf '\e[33msakanajs: cannot create a temp file, cwd/env will not be written back to fish\e[0m\n' >&2
        end
    end
    set -l seed (commandline -b)
    set -l lines (__sakanajs_prompt_lines)
    commandline -r ''

    # node repaints the whole prompt, so erase the block first (no duplicated header)
    printf '\r'
    if test $lines -gt 1
        printf '\e[%dA' (math $lines - 1)
    end
    printf '\e[J'

    set -l sock (__sakanajs_ensure_daemon)
    if test -z "$sock"
        printf '\e[31msakanajs: the daemon is unavailable, cannot enter JS mode\e[0m\n' >&2
        return 1
    end

    set -l retried 0
    while true
        # grab the prompt once per round (node paints the header, the last line becomes js ❯)
        set -l header (fish_prompt 2>/dev/null | string collect -N)
        printf '\r\e[J'

        command $cli --prepainted --socket "$sock" --state "$state" --seed "$seed" --header "$header"
        set -l code $status

        # 43 = the client cannot reach the daemon: clean up, start another, retry this round
        if test $code -eq 43; and test $retried -eq 0
            set retried 1
            set -e __sakanajs_daemon_pid
            set -l stale (__sakanajs_socket)
            if test -n "$stale"
                command rm -f $stale $stale.pid
            end
            set sock (__sakanajs_ensure_daemon)
            continue
        end

        set seed ''

        if test -s "$state"
            source "$state"
            rm -f "$state"
        end

        test $code -eq 42; or break
    end

    # done: node left the cursor on the last prompt line, repaint redraws the block
    commandline -f repaint
    return 0
end
