# Doctor and live workbench

`harness doctor` checks that a release or source install can actually run: protocol, package root, profiles, catalog, Node, git, cwd, config, API key presence (never the value), default-off network. `harness workbench --serve` keeps the page live over loopback SSE (`GET /events`) and `GET /rpc/runtime/doctor`.
