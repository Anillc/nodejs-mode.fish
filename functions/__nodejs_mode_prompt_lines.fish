function __nodejs_mode_prompt_lines
    set -l out (fish_prompt 2>/dev/null | string collect -N)
    set -l n (string split \n -- $out | count)
    test $n -lt 1; and set n 1
    echo $n
end
