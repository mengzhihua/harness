# Workbench commands

The Harness IDE workbench wires Apply / Undo / Steer / TUI buttons. Clicks dispatch `ide/command` through the host bridge (`window.harness`, VS Code `postMessage`, or `parent`). Without a host they still print the matching `ide/command` hint.
