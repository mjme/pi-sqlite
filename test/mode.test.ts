import { test } from "node:test";
import assert from "node:assert/strict";
import { MODE_ENTRY, resolveDbPath } from "../src/mode.ts";

const entry = (path: unknown) => ({ type: "custom", customType: MODE_ENTRY, data: { path } });

test("flag path resolves relative to cwd", () => {
	assert.deepEqual(resolveDbPath("db/a.db", "/w", []), { path: "/w/db/a.db", readOnly: false, fromFlag: true, persisted: false });
	assert.deepEqual(resolveDbPath("/abs/a.db", "/w", []), { path: "/abs/a.db", readOnly: false, fromFlag: true, persisted: false });
});

test("no flag falls back to the saved session entry", () => {
	for (const flag of [undefined, false, ""]) {
		assert.deepEqual(resolveDbPath(flag, "/w", [entry("/old.db")]), { path: "/old.db", readOnly: false, fromFlag: false, persisted: true });
	}
});

test("the last saved entry wins", () => {
	assert.equal(resolveDbPath(undefined, "/w", [entry("/one.db"), { type: "message" }, entry("/two.db")])?.path, "/two.db");
});

test("flag overrides the saved entry; equal paths count as persisted", () => {
	assert.deepEqual(resolveDbPath("/new.db", "/w", [entry("/old.db")]), { path: "/new.db", readOnly: false, fromFlag: true, persisted: false });
	assert.deepEqual(resolveDbPath("/old.db", "/w", [entry("/old.db")]), { path: "/old.db", readOnly: false, fromFlag: true, persisted: true });
});

test("no flag and no valid entry resolves to undefined", () => {
	assert.equal(resolveDbPath(undefined, "/w", []), undefined);
	assert.equal(resolveDbPath(true, "/w", []), undefined);
	assert.equal(
		resolveDbPath(undefined, "/w", [
			{ type: "custom", customType: "other", data: { path: "/x.db" } },
			{ type: "custom", customType: MODE_ENTRY, data: { nope: 1 } },
			{ type: "custom", customType: MODE_ENTRY },
			entry(42),
		]),
		undefined,
	);
});

const roEntry = (path: string) => ({ type: "custom", customType: MODE_ENTRY, data: { path, readOnly: true } });

test("--sqlite-readonly forces read-only and a change counts as not persisted", () => {
	assert.deepEqual(resolveDbPath("/a.db", "/w", [entry("/a.db")], true), {
		path: "/a.db",
		readOnly: true,
		fromFlag: true,
		persisted: false,
	});
	assert.equal(resolveDbPath("/a.db", "/w", [roEntry("/a.db")], true)?.persisted, true);
	// Resuming with the flag but no path: the saved database, now read-only.
	assert.deepEqual(resolveDbPath(undefined, "/w", [entry("/a.db")], true), {
		path: "/a.db",
		readOnly: true,
		fromFlag: false,
		persisted: false,
	});
});

test("a resumed read-only session stays read-only; an explicit --sqlite-mode opens read-write", () => {
	assert.deepEqual(resolveDbPath(undefined, "/w", [roEntry("/a.db")]), {
		path: "/a.db",
		readOnly: true,
		fromFlag: false,
		persisted: true,
	});
	assert.deepEqual(resolveDbPath("/a.db", "/w", [roEntry("/a.db")]), {
		path: "/a.db",
		readOnly: false,
		fromFlag: true,
		persisted: false,
	});
});

test("any --sqlite-readonly value except false means read-only", () => {
	for (const v of [true, "", "yes", "/sql select 1"]) assert.equal(resolveDbPath("/a.db", "/w", [], v)?.readOnly, true, String(v));
	for (const v of [undefined, false, "false"]) assert.equal(resolveDbPath("/a.db", "/w", [], v)?.readOnly, false, String(v));
});
