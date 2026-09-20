# Workbench HTTP host

`harness workbench --serve` binds 127.0.0.1 and injects `window.harness.command`, which POSTs `/rpc/ide/command`. Save writes the editor into the agent worktree. Path escape fails closed. Non-loopback binds are rejected.
