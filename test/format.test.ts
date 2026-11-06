import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecResult } from "../src/db.ts";
import { MODEL_MAX_BYTES, formatForModel } from "../src/format.ts";

function result(r: Partial<ExecResult>): ExecResult {
	return {
		sql: "select 1",
		kind: "rows",
		columns: [],
		rows: [],
		rowCount: 0,
		truncated: false,
		schemaChanged: false,
		ddl: [],
		durationMs: 1,
		...r,
	};
}

test("rows render as a pipe table with a row count", () => {
	const text = formatForModel(result({ columns: ["id", "name"], rows: [[1, "a"], [2, null]], rowCount: 2 }));
	assert.equal(text, "id | name\n1 | a\n2 | NULL\n(2 rows)");
});

test("cells escape pipes and newlines and are cut at 200 chars", () => {
	const long = "x".repeat(250);
	const text = formatForModel(result({ columns: ["c"], rows: [["x|y\nz"], [long]], rowCount: 2 }));
	const lines = text.split("\n");
	assert.equal(lines[1], "x\\|y\\nz");
	assert.equal(lines[2], `${"x".repeat(199)}…`);
});

test("row cap shows 50 rows and a footer with the true total", () => {
	const rows = Array.from({ length: 120 }, (_, i) => [i]);
	const lines = formatForModel(result({ columns: ["n"], rows, rowCount: 120 })).split("\n");
	assert.equal(lines.length, 1 + 50 + 1);
	assert.equal(lines.at(-1), "(120 rows total, 50 shown — add LIMIT/WHERE to narrow)");
});

test("byte cap keeps output within MODEL_MAX_BYTES and reports the true total", () => {
	const rows = Array.from({ length: 50 }, () => ["y".repeat(1000)]);
	const text = formatForModel(result({ columns: ["c"], rows, rowCount: 50 }));
	assert.ok(Buffer.byteLength(text) <= MODEL_MAX_BYTES, `got ${Buffer.byteLength(text)}`);
	assert.match(text.split("\n").at(-1)!, /^\(50 rows total, \d+ shown — add LIMIT\/WHERE to narrow\)$/);
});

test("zero rows shows header and (0 rows)", () => {
	assert.equal(formatForModel(result({ columns: ["a", "b"], rows: [], rowCount: 0 })), "a | b\n(0 rows)");
});

test("changes, script, ddl and errors", () => {
	assert.equal(
		formatForModel(result({ kind: "changes", changes: 3, lastInsertRowid: 42 })),
		"OK: 3 rows changed (last insert rowid 42)",
	);
	assert.match(formatForModel(result({ kind: "script", statements: 3 })), /^OK: script executed \(3 statements\)/);
	const ddl = formatForModel(
		result({ kind: "changes", changes: 0, lastInsertRowid: 0, schemaChanged: true, ddl: ["CREATE TABLE u(x int)"] }),
	);
	assert.ok(ddl.endsWith("Schema changed:\nCREATE TABLE u(x int)"), ddl);
	assert.equal(formatForModel(result({ kind: "error", error: "no such table: nope" })), "SQLite error: no such table: nope");
});
