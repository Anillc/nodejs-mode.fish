function __nodejs_mode_socket
    set -l dir (__nodejs_mode_runtime_dir)
    test -n "$dir"; or return 1
    echo $dir/nodejs-mode-$fish_pid.sock
end
