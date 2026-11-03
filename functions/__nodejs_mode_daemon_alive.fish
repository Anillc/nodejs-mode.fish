function __nodejs_mode_daemon_alive --description "socket 旁边 pid 文件里的 daemon 还活着吗（socket 文件死了也不会消失）"
    set -l pid (command cat $argv[1].pid 2>/dev/null | string trim)
    test -n "$pid"; or return 1
    kill -0 $pid 2>/dev/null
end
