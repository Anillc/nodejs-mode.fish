function sakanajs --description "run js/ts through this session's daemon; no args enters the repl (same as Ctrl-X)"
    if test (count $argv) -eq 0
        if test -t 0
            sakanajs-enter
            return 0
        end
        set argv -f -
    end

    set -l cli (command -s sakanajs)
    if test -z "$cli"
        printf '\e[31msakanajs: the sakanajs command is not on PATH\e[0m\n' >&2
        printf '  install it: npm i -g sakanajs\e[0m\n' >&2
        return 1
    end

    # sakanajs script.ts -> -f; everything else goes to boot as-is (-c / --code / ...)
    set -l opts $argv
    if not string match -q -- '-*' $argv[1]
        if test -f $argv[1]
            set opts -f $argv[1] $argv[2..-1]
        else if string match -q -- '*.ts' '*.js' '*.mjs' '*.cjs' $argv[1]
            printf '\e[31msakanajs: no such file: %s\e[0m\n' $argv[1] >&2
            return 1
        else
            set opts -c (string join ' ' -- $argv)
        end
    end

    # start one if there is none; Ctrl-X reuses it afterwards
    set -l sock (__sakanajs_ensure_daemon)
    test -n "$sock"; or return 1

    command $cli --socket $sock $opts
end
