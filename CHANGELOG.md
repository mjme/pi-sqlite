# Changelog

## 0.2.0

Security hardening.

- `--sqlite-readonly` opens the database read-only (remembered when a session is resumed).
- `ATTACH`, `VACUUM INTO`, `load_extension()` and PRAGMAs that touch files or can corrupt the database are blocked, so SQL can no longer create, read or change files outside the opened database.
- Queries run in a separate process: a 30-second timeout and Esc stop them without freezing Pi, and an interrupted write is rolled back. The database can grow by at most 1 GiB per session.
- Comments in the schema are no longer copied into the system prompt, and the prompt tells the model to treat database content as data, not instructions.
- Escape sequences in errors and SQL are no longer sent to the terminal.
- In SQL mode, calls to any tool other than `sqlite` are blocked, including tools that register late.
- Requires Node.js 24.12 or newer.

## 0.1.0

- `--sqlite-mode <path>` turns Pi into a SQLite-only agent with a single `sqlite` tool.
- Schema is injected into the system prompt and refreshed after DDL.
- Query results render as width-aware tables (Ctrl+O to expand); the model sees a capped text version.
- `/sql <statement>` runs SQL directly and shares the result with the model.
- Status bar shows the open database and table count.
- SQL-mode sessions remember their database on resume.
- Agent persona lives in `src/system-prompt.md`.
