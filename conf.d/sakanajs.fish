function __sakanajs_runtime_dir --description "pick a writable private directory for the session socket"
    if set -q SAKANAJS_RUNTIME_DIR; and test -n "$SAKANAJS_RUNTIME_DIR"
        echo $SAKANAJS_RUNTIME_DIR
        return 0
    end
    set -l uid (id -u)
    for dir in $XDG_RUNTIME_DIR $TMPDIR /tmp
        test -n "$dir"; or continue
        test -d "$dir"; or continue
        test -w "$dir"; or continue
        echo $dir/sakanajs-$uid
        return 0
    end
    return 1
end

function __sakanajs_prompt_lines
    set -l out (fish_prompt 2>/dev/null | string collect -N)
    set -l n (string split \n -- $out | count)
    test $n -lt 1; and set n 1
    echo $n
end

function __sakanajs_cleanup --on-event fish_exit
    set -q SAKANAJS_SOCKET; or return 0
    command rm -f $SAKANAJS_SOCKET $SAKANAJS_SOCKET.pid
    # a clean exit leaves an empty log; drop those, keep the ones that say something
    if test -f $SAKANAJS_SOCKET.log; and not test -s $SAKANAJS_SOCKET.log
        command rm -f $SAKANAJS_SOCKET.log
    end
end

if not set -q SAKANAJS_SOCKET
    set -l dir (__sakanajs_runtime_dir)
    if test -n "$dir"
        set -gx SAKANAJS_SOCKET $dir/sakanajs-$fish_pid.sock
    end
end
set -q SAKANAJS_PARENT; or set -gx SAKANAJS_PARENT $fish_pid

function __sakanajs_enter --description "run the node.js repl in place (Ctrl-X)"
    if not command -sq sakanajs
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

    while true
        # grab the prompt once per round (node paints the header, the last line becomes js ❯)
        set -l header (fish_prompt 2>/dev/null | string collect -N)
        printf '\r\e[J'

        command sakanajs --prepainted --state "$state" --seed "$seed" --header "$header"
        set -l code $status

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

bind \cx __sakanajs_enter
bind -M insert \cx __sakanajs_enter
