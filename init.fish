# oh-my-fish clones the repository and sources this file with $path set to the package
# directory; fisher copies functions/ into the fish config directory instead and never
# reads init.fish. Registering the directory here keeps both installs on autoload.
set -l dir (realpath (dirname (realpath (status filename))))
set -l functions $dir/functions
if test -d $functions; and not contains -- $functions $fish_function_path
    set -g fish_function_path $fish_function_path[1] $functions $fish_function_path[2..-1]
end
