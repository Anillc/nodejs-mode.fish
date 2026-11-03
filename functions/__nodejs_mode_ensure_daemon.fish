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
    command $__nodejs_mode_root/nodejs-mode/bin/nodejs-mode-daemon --socket $sock --parent $fish_pid </dev/null >$logfile 2>&1 &
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
