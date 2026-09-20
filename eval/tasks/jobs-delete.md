# Background bash, wait, delete_file

Long tests use `bash` with `background: true` then `wait` (optional `job_id` / `timeout_ms`). Foreground commands still default to 30s; background jobs default to 10 minutes. `delete_file` removes a path in the AgentWorkspace instead of `bash rm`. `/stop` and turn end abort leftover jobs.
