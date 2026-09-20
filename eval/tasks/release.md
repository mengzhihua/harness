# Release pack

`pnpm pack:all` builds the npm tarball, Windows/macOS/Linux SEA native packs (Apple Silicon as `harness-macos-arm64-*.zip`), and the Spring Boot `harness-server-*.jar`. Users unpack a native pack (no Node install) or `java -jar` on a server, then `harness --version` / `harness doctor` / `harness exec --model mock`. Green pushes (`pnpm test` pass) publish those files to GitHub Releases automatically.
