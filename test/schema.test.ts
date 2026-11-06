import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.ts";
import { formatSchema, readSchema, tableCount } from "../src/schema.ts";

function musicDb() {
	const { db } = openDatabase(":memory:");
	db.exec(`
		create table artists(id integer primary key, name text);
		insert into artists(name) values ('a'),('b'),('c');
		create table albums(id integer primary key autoincrement, artist_id references artists(id), title);
		create view v_albums as select title from albums;
		create index ix_albums_artist on albums(artist_id);
	`);
	return db;
}

test("readSchema lists user objects with columns and row counts", () => {
	const objs = readSchema(musicDb());
	assert.deepEqual(objs.map((o) => o.name).sort(), ["albums", "artists", "ix_albums_artist", "v_albums"]);
	assert.ok(!objs.some((o) => o.name.startsWith("sqlite_")));
	const artists = objs.find((o) => o.name === "artists")!;
	assert.equal(artists.type, "table");
	assert.equal(artists.rowCount, 3);
	assert.deepEqual(artists.columns, [
		{ name: "id", type: "INTEGER" },
		{ name: "name", type: "TEXT" },
	]);
	assert.equal(tableCount(objs), 2);
});

test("formatSchema includes path, CREATE statements and row counts", () => {
	const objs = readSchema(musicDb());
	const text = formatSchema("/x/a.db", objs);
	assert.match(text, /\/x\/a\.db/);
	for (const o of objs) assert.ok(text.includes(o.sql!), `missing ${o.name}`);
	assert.match(text, /3 rows/);
});

test("formatSchema falls back to compact form within the byte cap", () => {
	const { db } = openDatabase(":memory:");
	const cols = Array.from({ length: 10 }, (_, i) => `column_number_${i} text`).join(", ");
	for (let t = 0; t < 200; t++) db.exec(`create table table_${t}(${cols})`);
	const text = formatSchema("/x/wide.db", readSchema(db), { maxBytes: 8192 });
	assert.ok(Buffer.byteLength(text) <= 8192, `got ${Buffer.byteLength(text)} bytes`);
	assert.match(text, /table_0\(column_number_0 TEXT, /);
	assert.match(text, /sqlite_schema/);
	assert.match(text, /pragma_table_info/);
});

test("formatSchema on an empty database says so", () => {
	const { db } = openDatabase(":memory:");
	const text = formatSchema("/x/empty.db", readSchema(db));
	assert.match(text, /\/x\/empty\.db/);
	assert.match(text, /empty/i);
});

test("fix: row counts are bounded so refreshes stay fast on big tables", () => {
	const { db } = openDatabase(":memory:");
	db.exec("create table big as with recursive c(n) as (select 1 union all select n+1 from c where n < 100005) select n from c");
	const big = readSchema(db).find((o) => o.name === "big")!;
	assert.equal(big.rowCount, 100000);
	assert.equal(big.rowCountCapped, true);
	assert.match(formatSchema("/x/big.db", readSchema(db)), /100,000\+ rows/);
});
