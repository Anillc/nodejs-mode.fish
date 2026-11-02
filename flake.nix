{
  outputs = inputs@{
    self, nixpkgs, flake-parts,
  }: flake-parts.lib.mkFlake { inherit inputs; } {
    systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
    perSystem = { self', pkgs, ... }: {
      devShells.default = pkgs.mkShell {
        buildInputs = with pkgs; [];
        nativeBuildInputs = with pkgs; [ yarn-berry nodejs ];
      };

      packages.nodejs-mode = pkgs.stdenv.mkDerivation (finalAttrs: {
        pname = "nodejs-mode";
        version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./package.json ./yarn.lock ./.yarnrc.yml ./src ./fish
          ];
        };

        offlineCache = pkgs.yarn-berry.fetchYarnBerryDeps {
          inherit (finalAttrs) src;
          hash = "sha256-HPJ9f/gexskouW0/uLE7Q+iV2OhZBV0/A1yIoM7/z80=";
        };

        nativeBuildInputs = [ pkgs.yarn-berry.yarnBerryConfigHook pkgs.nodejs pkgs.fish ];

        dontBuild = true;

        installPhase = ''
          runHook preInstall

          mkdir -p $out/share/nodejs-mode.fish
          cp -r src fish package.json node_modules $out/share/nodejs-mode.fish/

          substituteInPlace $out/share/nodejs-mode.fish/fish/conf.d/nodejs-mode.fish \
            --replace-fail 'set -l node (command -s node)' 'set -l node ${pkgs.lib.getExe pkgs.nodejs}'

          mkdir -p $out/share/fish/vendor_conf.d
          ln -s $out/share/nodejs-mode.fish/fish/conf.d/nodejs-mode.fish \
                $out/share/fish/vendor_conf.d/nodejs-mode.fish

          runHook postInstall
        '';

        doInstallCheck = true;
        installCheckPhase = ''
          fish -c '
            source $out/share/fish/vendor_conf.d/nodejs-mode.fish
            test -n "$__nodejs_mode_root"; or begin; echo "no root"; exit 1; end
            test -f "$__nodejs_mode_root/src/daemon.ts"; or begin; echo "no daemon"; exit 1; end
            test -f "$__nodejs_mode_root/node_modules/zx/package.json"; or begin; echo "no zx"; exit 1; end
          '
        '';
      });

      packages.default = self'.packages.nodejs-mode;
      checks.default = self'.packages.nodejs-mode;
    };
  };
}
