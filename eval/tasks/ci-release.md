# Continuous GitHub Release

Every green push (`pnpm test` pass) publishes Windows / macOS / Linux native packs, the Spring Boot JAR, and the npm tarball to GitHub Releases. Pull requests only run tests. `[skip release]` / `[skip ci]` and docs-only commits do not ship. Latest: the newest green build.
