# Todos, memory, workspace status

The agent keeps an in-thread checklist with `todo_write` (visible in the TUI and restored on `/resume`). `remember` writes a short note under `.harness/knowledge` so the next thread still knows how to test the repo; `recall` loads the full body. `workspace_status` reports the agent worktree vs the user's dirty tree without shelling out to git.
