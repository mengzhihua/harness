# Workbench commands

The Harness IDE workbench wires Apply / Undo / Save / Steer / TUI buttons. Clicks dispatch `ide/command` through the host bridge (`window.harness`, VS Code `postMessage`, or `parent`). `harness workbench --serve` injects `window.harness` on loopback. Without a host they still print the matching `ide/command` hint.
