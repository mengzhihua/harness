# Stream LLM

Each `llm.chat` step emits `item/delta` with `append: true` and `source: llm` so the TUI can show tokens (or a `→ tool` preview) before the step completes. Trajectory still stores the complete `step` event, not per-token lines.
