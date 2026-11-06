# pi-sqlite

A [Pi](https://pi.dev) extension that turns Pi into a **SQLite agent**. Point it at a database and Pi drops its file and shell tools. It gets one `sqlite` tool, learns your schema, and shows query results as tables in the terminal.

```bash
pi --sqlite-mode ./music.db
```

> **Heads up:** the agent can change and delete data in your database without asking. Add `--sqlite-readonly` (or point it at a copy) if you only want to read.

```
 sqlite SELECT name, country FROM artists LIMIT 5
 name                │ country
 ────────────────────┼────────
 The Silver Harbor   │ Canada
 The Midnight Rivers │ Brazil
 The Electric Echoes │ Sweden
 The Quiet Tides     │ France
 The Golden Lanterns │ USA
 5 rows · 0.7ms
```

## What it does

When you start Pi with `--sqlite-mode <path>`:

- **SQL-only agent.** Pi's built-in `read`, `write`, `edit` and `bash` tools are switched off. The model gets a single `sqlite` tool that runs any SQL, reads and writes alike. Tools added by MCP servers are kept off too.
- **Schema up front.** The database schema (tables, views, indexes, triggers, row counts) goes into the system prompt, so even a small local model knows the table and column names before its first query. The schema is refreshed after the model creates, alters or drops anything.
- **Results as tables.** Query results render as a table that fits your terminal width. The first 10 rows show by default; press **Ctrl+O** to expand to the full result.
- **Small context.** The model sees at most 50 rows (about 8 KB) per result, plus a note saying how many rows were left out. The full rows (up to 500) are only drawn on your screen.
- **`/sql` command.** Type `/sql SELECT …` to run SQL yourself. The result renders the same way and is also added to the conversation, so you can follow up with "why are so many of those NULL?"
- **Status bar.** The footer shows `sqlite: music.db · 4 tables`.
- **Sessions remember their database.** Resume a SQL session with `pi -c` (no flag needed) and it reopens the same database, read-only if it was before.
- **Read-only mode.** `pi --sqlite-mode ./music.db --sqlite-readonly` opens the database read-only: queries work, writes fail, and a missing file is never created. Pi reads the word after a flag as its value, so don't put `--sqlite-readonly` directly before your prompt.

Without the flag, the extension does nothing: plain `pi` keeps its normal tools and prompt.

If the path doesn't exist, a new empty database is created there.

## Install

Requires Pi and Node.js 24.12 or newer, which is newer than Pi's own minimum: the safety checks need `node:sqlite`'s authorizer. On older Node.js the extension refuses to open a database. There are no other dependencies.

```bash
pi install git:github.com/mjme/pi-sqlite
```

Or try it without installing:

```bash
git clone https://github.com/mjme/pi-sqlite && cd pi-sqlite
npm run sample                                   # builds examples/sample.db
pi -e ./src/index.ts --sqlite-mode examples/sample.db
```

## Customising the agent

The agent's instructions live in one plain markdown file: **[`src/system-prompt.md`](src/system-prompt.md)**. Edit it to change how the agent behaves: its tone, how cautious it is with writes, or domain knowledge about your data. Changes apply to the next session (or after `/reload`); nothing needs rebuilding.

The schema is appended automatically, so don't paste it into that file. If you use your own Pi system prompt (`--system-prompt` or `SYSTEM.md`), it is kept and placed after this file's text.

## Notes

- Writes are allowed and not confirmed unless you use `--sqlite-readonly`.
- The agent can only reach the opened database: `ATTACH`, `VACUUM INTO`, `load_extension()` and PRAGMAs that touch files or can corrupt the database are blocked, for `/sql` too.
- Queries run in a separate process. One that runs longer than 30 seconds is stopped, Esc cancels one, and a write that was cut off is rolled back.
- The database can grow by at most 1 GiB per session, so a runaway query can't fill the disk.
- Query results are sent to your model provider and saved in Pi's session files, like any other tool output.
- Several statements in one call (`CREATE …; INSERT …;`) run as a script and return no rows. Send one statement when you want rows back.
- Big integers beyond JavaScript's safe range are shown as text, and BLOBs as `<blob N bytes>`.

## Development

```bash
npm install
npm test        # node:test, no Pi needed
npm run check   # TypeScript type check
```

Source layout:

| File | Responsibility |
|---|---|
| `src/index.ts` | Pi wiring: flag, tool, `/sql`, renderers, prompt, status |
| `src/system-prompt.md` | The agent persona (edit me) |
| `src/db.ts` | Opening the database and running SQL |
| `src/security.ts` | The SQL safety policy (authorizer, defensive mode, growth cap) |
| `src/client.ts` | Runs SQL in a separate process that can be killed (timeouts, Esc) |
| `src/host/` | The query process: a small loader and the request loop |
| `src/schema.ts` | Reading and formatting the schema for the prompt |
| `src/format.ts` | The capped text the model sees |
| `src/table.ts` | The terminal table renderer |
| `src/mode.ts` | Which database a session uses (flag or saved session) |

## License

MIT
