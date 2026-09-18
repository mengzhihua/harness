# Plugin permissions

Project plugins declare `permissions` (network, secrets, subprocess, fs). A command plugin with `subprocess: false` must fail closed and record `plugin/permission`.
