# Agent hands: patch, questions, live web

`apply_patch` applies `*** Begin Patch` / unified diffs in the worktree. `ask_user` waits for the human's answer (TUI QUESTION card / `user/respond`). `web_fetch` and `web_search` do real HTTP when `HARNESS_NET` or `--network` is on; metadata IPs stay blocked. `[skip release]` only matches the commit subject or a standalone line.
