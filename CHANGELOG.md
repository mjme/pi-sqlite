# Changelog

## 0.1.0

- `--sqlite-mode <path>` turns Pi into a SQLite-only agent with a single `sqlite` tool.
- Schema is injected into the system prompt and refreshed after DDL.
- Query results render as width-aware tables (Ctrl+O to expand); the model sees a capped text version.
- `/sql <statement>` runs SQL directly and shares the result with the model.
- Status bar shows the open database and table count.
- SQL-mode sessions remember their database on resume.
- Agent persona lives in `src/system-prompt.md`.
