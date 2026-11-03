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
