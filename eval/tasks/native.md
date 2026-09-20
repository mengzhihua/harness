# Native packs and Spring Boot server

`pnpm pack:native` builds Node SEA executables: Windows `harness.exe` zip, Linux tar.gz, and Finder-friendly macOS zips (`harness-macos-arm64-*.zip` for Apple Silicon, plus Intel and optional universal). Pack fails if the Apple Silicon zip is missing. Unpack and run; Node does not need to be installed. `pnpm pack:server` builds `java -jar harness-server-<version>.jar` (Spring Boot adapter, Maven dependency, Spring source is not vendored). `harness serve --http` is the same JSON-RPC on Node.
