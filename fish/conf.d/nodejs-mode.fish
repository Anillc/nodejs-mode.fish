# 用 status filename 而不是 dirname：从 ~/.config/fish/conf.d 软链进来时也能找到仓库
set -g __nodejs_mode_root (realpath (dirname (dirname (realpath (status filename))))/..)

function __nodejs_mode_prompt_lines
    set -l out (fish_prompt 2>/dev/null | string collect -N)
    set -l n (string split \n -- $out | count)
    test $n -lt 1; and set n 1
    echo $n
end

function __nodejs_mode_runtime_dir --description "挑一个可写的私有目录放 socket"
    if set -q NODEJS_MODE_RUNTIME_DIR; and test -n "$NODEJS_MODE_RUNTIME_DIR"
        echo $NODEJS_MODE_RUNTIME_DIR
        return 0
    end
    set -l uid (id -u)
    for dir in $XDG_RUNTIME_DIR $TMPDIR /tmp
        test -n "$dir"; or continue
        test -d "$dir"; or continue
        test -w "$dir"; or continue
        echo $dir/nodejs-mode-$uid
        return 0
    end
    return 1
end

function __nodejs_mode_daemon_dir --description "建好目录并检查，失败时把原因说清楚"
    set -l dir (__nodejs_mode_runtime_dir)
    if test -z "$dir"
        printf '\e[31mnodejs-mode: 找不到可写的运行时目录\e[0m\n' >&2
        printf '  XDG_RUNTIME_DIR=%s TMPDIR=%s /tmp 都不可用\n' "$XDG_RUNTIME_DIR" "$TMPDIR" >&2
        printf '  可以设 NODEJS_MODE_RUNTIME_DIR 指定一个\n' >&2
        return 1
    end

    if not test -d "$dir"
        set -l err (command mkdir -p -m 700 $dir 2>&1)
        if test $status -ne 0
            printf '\e[31mnodejs-mode: 建不了目录 %s\e[0m\n' $dir >&2
            test -n "$err"; and printf '  %s\n' $err >&2
            return 1
        end
    end
    if not test -w "$dir"
        printf '\e[31mnodejs-mode: 目录不可写 %s\e[0m\n' $dir >&2
        return 1
    end

    set -l sock $dir/nodejs-mode-$fish_pid.sock
    set -l len (string length -- $sock)
    if test $len -gt 100
        printf '\e[31mnodejs-mode: socket 路径太长（%d 字节，上限约 104）\e[0m\n' $len >&2
        printf '  %s\n' $sock >&2
        printf '  设 NODEJS_MODE_RUNTIME_DIR 换一个短一点的目录\n' >&2
        return 1
    end

    echo $dir
end

function __nodejs_mode_socket
    set -l dir (__nodejs_mode_runtime_dir)
    test -n "$dir"; or return 1
    echo $dir/nodejs-mode-$fish_pid.sock
end

function __nodejs_mode_daemon_alive --description "socket 旁边 pid 文件里的 daemon 还活着吗（socket 文件死了也不会消失）"
    set -l pid (command cat $argv[1].pid 2>/dev/null | string trim)
    test -n "$pid"; or return 1
    kill -0 $pid 2>/dev/null
end

function __nodejs_mode_ensure_daemon --description "起好本会话的 daemon，echo socket 路径"
    set -l dir (__nodejs_mode_daemon_dir)
    test -n "$dir"; or return 1

    set -l sock $dir/nodejs-mode-$fish_pid.sock
    set -l pidfile $sock.pid
    set -l logfile $dir/nodejs-mode-$fish_pid.log

    if test -S $sock
        if __nodejs_mode_daemon_alive $sock
            echo $sock
            return 0
        end
        # 上次的 daemon 已经没了，socket 文件还在
        command rm -f $sock $pidfile
    end

    # 输出进 log：起不来的时候要靠它说清楚原因
    command node $__nodejs_mode_root/src/daemon.ts --socket $sock --parent $fish_pid </dev/null >$logfile 2>&1 &
    set -l pid $last_pid
    set -g __nodejs_mode_daemon_pid $pid
    disown 2>/dev/null

    for i in (seq 300)
        if test -S $sock
            echo $sock
            return 0
        end
        # 已经死了就别干等
        if not kill -0 $pid 2>/dev/null
            break
        end
        sleep 0.01
    end

    printf '\e[31mnodejs-mode: daemon 没能启动\e[0m\n' >&2
    printf '  socket: %s\n' $sock >&2
    printf '  log:    %s\n' $logfile >&2
    set -l log (command tail -n 20 $logfile 2>/dev/null)
    if test -n "$log"
        printf '  ---\n' >&2
        printf '%s\n' $log >&2
    else
        printf '  (daemon 没有任何输出)\n' >&2
    end
    command rm -f $sock $pidfile
    set -e __nodejs_mode_daemon_pid
    return 1
end

function __nodejs_mode_cleanup --on-event fish_exit
    if set -q __nodejs_mode_daemon_pid
        command kill $__nodejs_mode_daemon_pid 2>/dev/null
        set -e __nodejs_mode_daemon_pid
    end
    set -l sock (__nodejs_mode_socket)
    if test -n "$sock"
        command rm -f $sock $sock.pid
        # 正常退出的 log 是空的，留着只会越积越多；有内容的留着给人看
        set -l logfile (string replace -r '\.sock$' .log $sock)
        if test -f $logfile; and not test -s $logfile
            command rm -f $logfile
        end
    end
end

function nodejs-mode-enter --description "run the node.js repl in place (Ctrl-X)"
    set -l node (command -s node)
    if test -z "$node"
        printf '\e[31mnodejs-mode: node not found in PATH\e[0m\n' >&2
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

        command $node $__nodejs_mode_root/src/boot.ts --prepainted --socket "$sock" --state "$state" --seed "$seed" --header "$header"
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

function nodejs-mode --description "run js/ts through this session's daemon; no args enters the repl (same as Ctrl-X)"
    if test (count $argv) -eq 0
        if test -t 0
            nodejs-mode-enter
            return 0
        end
        set argv -f -
    end

    set -l node (command -s node)
    if test -z "$node"
        printf '\e[31mnodejs-mode: node not found in PATH\e[0m\n' >&2
        return 1
    end

    # nodejs-mode script.ts -> -f；别的原样交给 boot（-c / --code / …）
    set -l opts $argv
    if not string match -q -- '-*' $argv[1]
        if test -f $argv[1]
            set opts -f $argv[1] $argv[2..-1]
        else if string match -q -- '*.ts' '*.js' '*.mjs' '*.cjs' $argv[1]
            printf '\e[31mnodejs-mode: no such file: %s\e[0m\n' $argv[1] >&2
            return 1
        else
            set opts -c (string join ' ' -- $argv)
        end
    end

    # 没有就现开一个；这个 daemon 之后 Ctrl-X 直接接着用
    set -l sock (__nodejs_mode_ensure_daemon)
    test -n "$sock"; or return 1

    command $node $__nodejs_mode_root/src/boot.ts --socket $sock $opts
end

function __nodejs_mode_bind --description "bind Ctrl-X to node.js mode"
    bind \cx nodejs-mode-enter
    bind -M insert \cx nodejs-mode-enter
end

__nodejs_mode_bind
