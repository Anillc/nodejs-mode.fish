{
  outputs = inputs@{
    self, nixpkgs, flake-parts,
  }: flake-parts.lib.mkFlake { inherit inputs; } {
    systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
    perSystem = { self', pkgs, ... }: {
      devShells.default = pkgs.mkShell {
        nativeBuildInputs = with pkgs; [ nodejs ];
      };

      packages.nodejs-mode-runtime = pkgs.buildNpmPackage {
        pname = "nodejs-mode-runtime";
        version = (builtins.fromJSON (builtins.readFile ./nodejs-mode/package.json)).version;

        src = ./nodejs-mode;

        npmDeps = pkgs.importNpmLock { npmRoot = ./nodejs-mode; };
        npmConfigHook = pkgs.importNpmLock.npmConfigHook;
      };

      packages.default = pkgs.stdenv.mkDerivation (finalAttrs: {
        pname = "nodejs-mode";
        version = (builtins.fromJSON (builtins.readFile ./nodejs-mode/package.json)).version;

        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [ ./conf.d ./functions ];
        };

        nativeBuildInputs = [ pkgs.fish ];

        dontBuild = true;
        installPhase = ''
          runHook preInstall

          mkdir -p $out/share/nodejs-mode.fish
          cp -r conf.d functions $out/share/nodejs-mode.fish/
          ln -s ${self'.packages.nodejs-mode-runtime} $out/share/nodejs-mode.fish/nodejs-mode

          mkdir -p $out/share/fish/vendor_conf.d $out/share/fish/vendor_functions.d
          ln -s $out/share/nodejs-mode.fish/conf.d/nodejs-mode.fish \
                $out/share/fish/vendor_conf.d/nodejs-mode.fish
          for f in $out/share/nodejs-mode.fish/functions/*.fish; do
            ln -s "$f" $out/share/fish/vendor_functions.d/
          done

          runHook postInstall
        '';
      });
    };
  };
}
