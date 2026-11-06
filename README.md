# pi-sqlite

A [Pi](https://pi.dev) extension that turns Pi into a **SQLite agent**. Point it at a database and Pi drops its file and shell tools. It gets one `sqlite` tool, learns your schema, and shows query results as tables in the terminal.

## Get started

```bash
pi install git:github.com/mjme/pi-sqlite
pi --sqlite-mode ./music.db
```

> **Heads up:** the agent can change and delete data in your database without asking. Add `--sqlite-readonly` (or point it at a copy) if you only want to read.

Want to try it without installing?

```bash
git clone https://github.com/mjme/pi-sqlite && cd pi-sqlite
npm run sample                                   # builds examples/sample.db
pi -e ./src/index.ts --sqlite-mode examples/sample.db
```

## SQL and an agent in one terminal

**The agent already knows your schema.** Tables, columns and row counts are in its prompt from the start:

```
-- table artists (20 rows)
CREATE TABLE artists (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  country TEXT
);
```

**`/sql` runs your queries.** Type `/sql SELECT …` and the result is shown as a table and added to the conversation, so you can ask "why are so many of those NULL?"

## Customising the agent

The agent's instructions live in one plain markdown file: **[`src/system-prompt.md`](src/system-prompt.md)**. Edit it to change how the agent behaves: its tone, how cautious it is with writes, or domain knowledge about your data. Changes apply to the next session (or after `/reload`); nothing needs rebuilding.

The schema is appended automatically, so don't paste it into that file. If you use your own Pi system prompt (`--system-prompt` or `SYSTEM.md`), it is kept and placed after this file's text.

## Development

```bash
npm install
npm test        # node:test, no Pi needed
npm run check   # TypeScript type check
```

## License

MIT
