function __sakanajs_runtime_dir --description "pick a writable private directory for the socket"
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

function __sakanajs_daemon_dir --description "create the directory, check it, and say what failed"
    set -l dir (__sakanajs_runtime_dir)
    if test -z "$dir"
        printf '\e[31msakanajs: no writable runtime directory\e[0m\n' >&2
        printf '  none of XDG_RUNTIME_DIR=%s, TMPDIR=%s or /tmp is usable\n' "$XDG_RUNTIME_DIR" "$TMPDIR" >&2
        printf '  set SAKANAJS_RUNTIME_DIR to point at one\n' >&2
        return 1
    end

    if not test -d "$dir"
        set -l err (command mkdir -p -m 700 $dir 2>&1)
        if test $status -ne 0
            printf '\e[31msakanajs: cannot create %s\e[0m\n' $dir >&2
            test -n "$err"; and printf '  %s\n' $err >&2
            return 1
        end
    end
    if not test -w "$dir"
        printf '\e[31msakanajs: %s is not writable\e[0m\n' $dir >&2
        return 1
    end

    set -l sock $dir/sakanajs-$fish_pid.sock
    set -l len (string length -- $sock)
    if test $len -gt 100
        printf '\e[31msakanajs: socket path is too long (%d bytes, the limit is about 104)\e[0m\n' $len >&2
        printf '  %s\n' $sock >&2
        printf '  set SAKANAJS_RUNTIME_DIR to a shorter directory\n' >&2
        return 1
    end

    echo $dir
end

function __sakanajs_socket
    set -l dir (__sakanajs_runtime_dir)
    test -n "$dir"; or return 1
    echo $dir/sakanajs-$fish_pid.sock
end

function __sakanajs_daemon_alive --description "is the daemon in the pid file next to the socket still alive (socket files outlive the process)"
    set -l pid (command cat $argv[1].pid 2>/dev/null | string trim)
    test -n "$pid"; or return 1
    kill -0 $pid 2>/dev/null
end

function __sakanajs_ensure_daemon --description "start this session's daemon and echo its socket path"
    set -l dir (__sakanajs_daemon_dir)
    test -n "$dir"; or return 1

    set -l sock $dir/sakanajs-$fish_pid.sock
    set -l pidfile $sock.pid
    set -l logfile $dir/sakanajs-$fish_pid.log

    if test -S $sock
        if __sakanajs_daemon_alive $sock
            echo $sock
            return 0
        end
        # the previous daemon is gone but its socket file is still there
        command rm -f $sock $pidfile
    end

    set -l cli (command -s sakanajs)
    test -n "$cli"; or return 1

    # output goes to the log: it is what explains a failed start
    command $cli --daemon --socket $sock --parent $fish_pid </dev/null >$logfile 2>&1 &
    set -l pid $last_pid
    set -g __sakanajs_daemon_pid $pid
    disown 2>/dev/null

    for i in (seq 300)
        if test -S $sock
            echo $sock
            return 0
        end
        # do not wait forever if it already died
        if not kill -0 $pid 2>/dev/null
            break
        end
        sleep 0.01
    end

    printf '\e[31msakanajs: the daemon did not start\e[0m\n' >&2
    printf '  socket: %s\n' $sock >&2
    printf '  log:    %s\n' $logfile >&2
    set -l log (command tail -n 20 $logfile 2>/dev/null)
    if test -n "$log"
        printf '  ---\n' >&2
        printf '%s\n' $log >&2
    else
        printf '  (the daemon printed nothing)\n' >&2
    end
    command rm -f $sock $pidfile
    set -e __sakanajs_daemon_pid
    return 1
end

function __sakanajs_prompt_lines
    set -l out (fish_prompt 2>/dev/null | string collect -N)
    set -l n (string split \n -- $out | count)
    test $n -lt 1; and set n 1
    echo $n
end

function __sakanajs_cleanup --on-event fish_exit
    if set -q __sakanajs_daemon_pid
        command kill $__sakanajs_daemon_pid 2>/dev/null
        set -e __sakanajs_daemon_pid
    end
    set -l sock (__sakanajs_socket)
    if test -n "$sock"
        command rm -f $sock $sock.pid
        # a clean exit leaves an empty log; drop those, keep the ones that say something
        set -l logfile (string replace -r '\.sock$' .log $sock)
        if test -f $logfile; and not test -s $logfile
            command rm -f $logfile
        end
    end
end

bind \cx sakanajs-enter
bind -M insert \cx sakanajs-enter
