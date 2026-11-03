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
