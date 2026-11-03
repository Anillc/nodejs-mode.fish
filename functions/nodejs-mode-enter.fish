function nodejs-mode-enter --description "run the node.js repl in place (Ctrl-X)"
    set -l cli $__nodejs_mode_root/nodejs-mode/bin/nodejs-mode
    if not test -x "$cli"
        printf '\e[31mnodejs-mode: %s is missing\e[0m\n' $cli >&2
        return 1
    end

    set -l state (command mktemp 2>/dev/null)
    if test -z "$state"
        # TMPDIR 坏了也得能写回 cd/env
        set -l dir (__nodejs_mode_runtime_dir)
        if test -n "$dir"
            command mkdir -p -m 700 $dir 2>/dev/null
            set state $dir/nodejs-mode-$fish_pid.state
        else
            printf '\e[33mnodejs-mode: 建不了临时文件，cwd/env 不会写回 fish\e[0m\n' >&2
        end
    end
    set -l seed (commandline -b)
    set -l lines (__nodejs_mode_prompt_lines)
    commandline -r ''

    # 整个 prompt 都会被 node 重画，先整块擦掉（避免头部重复）
    printf '\r'
    if test $lines -gt 1
        printf '\e[%dA' (math $lines - 1)
    end
    printf '\e[J'

    set -l sock (__nodejs_mode_ensure_daemon)
    if test -z "$sock"
        printf '\e[31mnodejs-mode: daemon 不可用，进不了 JS 模式\e[0m\n' >&2
        return 1
    end

    set -l retried 0
    while true
        # 每轮现抓一次 prompt（头部交给 node 画，最后一行换成 js ❯）
        set -l header (fish_prompt 2>/dev/null | string collect -N)
        printf '\r\e[J'

        command $cli --prepainted --socket "$sock" --state "$state" --seed "$seed" --header "$header"
        set -l code $status

        # 43 = 客户端连不上 daemon：清掉残留，重开一个，这一轮再跑一次
        if test $code -eq 43; and test $retried -eq 0
            set retried 1
            set -e __nodejs_mode_daemon_pid
            set -l stale (__nodejs_mode_socket)
            if test -n "$stale"
                command rm -f $stale $stale.pid
            end
            set sock (__nodejs_mode_ensure_daemon)
            continue
        end

        set seed ''

        if test -s "$state"
            source "$state"
            rm -f "$state"
        end

        test $code -eq 42; or break
    end

    # 收尾：node 已把光标放在 prompt 末行，repaint 重画整块
    commandline -f repaint
    return 0
end
