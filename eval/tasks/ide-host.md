# Workbench host bridge

Workbench buttons dispatch `ide/command` through `window.harness`, `acquireVsCodeApi`, or `parent.postMessage`. TUI `/ide apply` runs the same RPC. `thread/items/list` includes `ide/command`. Apply on a dirty user tree keeps `USER_WIP.md`.
