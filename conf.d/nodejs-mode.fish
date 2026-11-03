# 用 status filename 而不是 dirname：从 ~/.config/fish/conf.d 软链进来时也能找到仓库
set -g __nodejs_mode_root (realpath (dirname (dirname (realpath (status filename)))))

# 插件树里的 autoload 目录：只把 conf.d 软链进 ~/.config/fish 也要能找到 functions/
if test -d $__nodejs_mode_root/functions
    if not contains -- $__nodejs_mode_root/functions $fish_function_path
        set -g fish_function_path $__nodejs_mode_root/functions $fish_function_path
    end
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

bind \cx nodejs-mode-enter
bind -M insert \cx nodejs-mode-enter
