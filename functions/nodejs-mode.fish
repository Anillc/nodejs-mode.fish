function nodejs-mode --description "run js/ts through this session's daemon; no args enters the repl (same as Ctrl-X)"
    if test (count $argv) -eq 0
        if test -t 0
            nodejs-mode-enter
            return 0
        end
        set argv -f -
    end

    set -l cli $__nodejs_mode_root/nodejs-mode/bin/nodejs-mode
    if not test -x "$cli"
        printf '\e[31mnodejs-mode: %s is missing\e[0m\n' $cli >&2
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

    command $cli --socket $sock $opts
end
