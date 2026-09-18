# Open fallback

When no editor is configured, `/open` and `harness ide FILE` read the worktree via `ide/file` instead of failing closed. `ide/open` itself still fails closed without an editor.
