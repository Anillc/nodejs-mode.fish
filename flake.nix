{
  outputs = inputs@{
    self, nixpkgs, flake-parts,
  }: flake-parts.lib.mkFlake { inherit inputs; } {
    systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
    perSystem = { self', pkgs, ... }: {
      devShells.default = pkgs.mkShell {
        nativeBuildInputs = with pkgs; [ nodejs ];
      };

      packages.sakanajs-runtime = pkgs.buildNpmPackage {
        pname = "sakanajs-runtime";
        version = (builtins.fromJSON (builtins.readFile ./sakanajs/package.json)).version;
        src = ./sakanajs;
        npmDeps = pkgs.importNpmLock { npmRoot = ./sakanajs; };
        npmConfigHook = pkgs.importNpmLock.npmConfigHook;
      };

      packages.sakanajs-plugin = pkgs.stdenv.mkDerivation (finalAttrs: {
        pname = "sakanajs";
        version = (builtins.fromJSON (builtins.readFile ./sakanajs/package.json)).version;
        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./conf.d
            ./functions
          ];
        };
        dontBuild = true;
        installPhase = ''
          runHook preInstall
          mkdir -p $out/share/fish/vendor_conf.d $out/share/fish/vendor_functions.d
          cp conf.d/*.fish $out/share/fish/vendor_conf.d/
          cp functions/*.fish $out/share/fish/vendor_functions.d/
          runHook postInstall
        '';
      });

      packages.default = pkgs.symlinkJoin {
        name = "sakanajs";
        paths = [
          self'.packages.sakanajs-plugin
          self'.packages.sakanajs-runtime
        ];
      };
    };
  };
}
