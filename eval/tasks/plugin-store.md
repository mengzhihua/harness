# Install a catalog plugin

`harness plugin search test-runner` must list `harness.test-runner`.
`harness plugin install harness.test-runner` copies it into `.harness/plugins` without a git remote. This is the local catalog store, not a marketplace.
