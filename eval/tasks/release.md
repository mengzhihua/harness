# Release pack

`pnpm pack:release` bundles the CLI into `@harness/cli`. Users install the tarball (`npm i -g ./harness-cli-<version>.tgz`) and run `harness --version`, `harness doctor`, then `harness exec --model mock` without tsx or a source checkout. Profiles and the local catalog ship inside the pack.
