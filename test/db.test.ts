import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COUNT_LIMIT, DETAILS_MAX_CELL_CHARS, countStatements, execute, openDatabase } from "../src/db.ts";

function memDb() {
	return openDatabase(":memory:").db;
}

test("countStatements counts top-level statements", () => {
	assert.equal(countStatements("select 1"), 1);
	assert.equal(countStatements("select 1;"), 1);
	assert.equal(countStatements("select ';'; select 2"), 2);
	assert.equal(countStatements("select 1; -- trailing ; comment"), 1);
	assert.equal(countStatements("/* ; */ select 1"), 1);
	assert.equal(countStatements('select "a;b" from t'), 1);
	assert.equal(countStatements("select [a;b], `c;d` from t"), 1);
	assert.equal(countStatements("select 'it''s; fine'"), 1);
	assert.equal(countStatements(""), 0);
	assert.equal(countStatements("  ;  "), 0);
});

test("countStatements routes triggers with inner semicolons to script (>= 2)", () => {
	assert.ok(countStatements("create trigger tr after insert on t begin update t set x=1; end;") >= 2);
});

test("execute SELECT returns rows and columns", () => {
	const db = memDb();
	db.exec("create table t(a,b); insert into t values (1,'x'),(2,'y'),(3,'z')");
	const r = execute(db, "select * from t");
	assert.equal(r.kind, "rows");
	assert.deepEqual(r.columns, ["a", "b"]);
	assert.deepEqual(r.rows, [[1, "x"], [2, "y"], [3, "z"]]);
	assert.equal(r.rowCount, 3);
	assert.equal(r.truncated, false);
	assert.equal(r.schemaChanged, false);
	assert.equal(typeof r.durationMs, "number");
});

test("execute caps stored rows but counts all", () => {
	const db = memDb();
	db.exec(
		"create table big as with recursive c(n) as (select 1 union all select n+1 from c where n < 1200) select n from c",
	);
	const r = execute(db, "select * from big", 500);
	assert.equal(r.rows.length, 500);
	assert.equal(r.rowCount, 1200);
	assert.equal(r.truncated, true);
});

test("execute converts bigints and blobs to JSON-safe cells", () => {
	const db = memDb();
	const r = execute(db, "select 9007199254740993 as big, x'00ff' as b, null as n, 1.5 as f");
	assert.equal(r.kind, "rows");
	assert.deepEqual(r.rows, [["9007199254740993", "<blob 2 bytes>", null, 1.5]]);
	assert.doesNotThrow(() => JSON.stringify(r));
});

test("execute keeps duplicate column names as separate columns", () => {
	const r = execute(memDb(), "select 1 as a, 2 as a");
	assert.deepEqual(r.columns, ["a", "a"]);
	assert.deepEqual(r.rows, [[1, 2]]);
});

test("execute write returns changes and last insert rowid", () => {
	const db = memDb();
	db.exec("create table t(a,b); insert into t values (1,1),(2,2),(3,3)");
	const r = execute(db, "insert into t values(9,9)");
	assert.equal(r.kind, "changes");
	assert.equal(r.changes, 1);
	assert.equal(r.lastInsertRowid, 4);
	assert.equal(r.schemaChanged, false);
	assert.deepEqual(r.ddl, []);
});

test("execute DDL reports schema changes", () => {
	const db = memDb();
	const created = execute(db, "create table u(x int)");
	assert.equal(created.schemaChanged, true);
	assert.ok(created.ddl.includes("CREATE TABLE u(x int)"), JSON.stringify(created.ddl));
	const dropped = execute(db, "drop table u");
	assert.equal(dropped.schemaChanged, true);
	assert.ok(dropped.ddl.includes("DROPPED table u"), JSON.stringify(dropped.ddl));
});

test("execute runs multi-statement scripts without dropping statements", () => {
	const db = memDb();
	const r = execute(db, "create table s(x); insert into s values(1); insert into s values(2)");
	assert.equal(r.kind, "script");
	assert.equal(r.statements, 3);
	assert.equal(r.schemaChanged, true);
	assert.deepEqual(execute(db, "select count(*) c from s").rows, [[2]]);
});

test("execute reports SQL errors without throwing", () => {
	const r = execute(memDb(), "select * from nope");
	assert.equal(r.kind, "error");
	assert.match(r.error ?? "", /no such table/);
});

test("openDatabase creates a missing file and enables foreign keys", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-sqlite-"));
	const p = join(dir, "new.db");
	const { db, created } = openDatabase(p);
	assert.equal(created, true);
	assert.equal(existsSync(p), true);
	assert.deepEqual(execute(db, "pragma foreign_keys").rows, [[1]]);
	db.close();
	const again = openDatabase(p);
	assert.equal(again.created, false);
	again.db.close();
});

test("fix: DML RETURNING with a huge integer runs exactly once", () => {
	const db = memDb();
	db.exec("create table c(n integer)");
	const r = execute(db, "insert into c values (9223372036854775807) returning n");
	assert.equal(r.kind, "rows");
	assert.deepEqual(r.rows, [["9223372036854775807"]]);
	assert.deepEqual(execute(db, "select count(*) from c").rows, [[1]]);
});

test("fix: runaway queries stop counting at a budget instead of hanging", () => {
	const r = execute(memDb(), "with recursive c(n) as (select 1 union all select n+1 from c) select n from c");
	assert.equal(r.kind, "rows");
	assert.equal(r.countCapped, true);
	assert.equal(r.rowCount, COUNT_LIMIT);
	assert.equal(r.rows.length, 500);
});

test("fix: huge cells are capped in details", () => {
	const r = execute(memDb(), "select printf('%.*c', 50000, 'x') as big");
	const cell = r.rows[0][0] as string;
	assert.ok(cell.length <= DETAILS_MAX_CELL_CHARS, `got ${cell.length}`);
	assert.ok(cell.endsWith("…"));
});

test("fix: statements that change no rows don't report stale counts", () => {
	const db = memDb();
	db.exec("create table t(a); insert into t values (1),(2)");
	const r = execute(db, "create table u(x)");
	assert.equal(r.kind, "changes");
	assert.equal(r.changes, 0);
	assert.equal(r.lastInsertRowid, undefined);
	const upd = execute(db, "update t set a = a + 1");
	assert.equal(upd.changes, 2);
	assert.equal(upd.lastInsertRowid, undefined);
});
