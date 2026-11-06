import { test } from "node:test";
import assert from "node:assert/strict";
import { MODE_ENTRY, resolveDbPath } from "../src/mode.ts";

const entry = (path: unknown) => ({ type: "custom", customType: MODE_ENTRY, data: { path } });

test("flag path resolves relative to cwd", () => {
	assert.deepEqual(resolveDbPath("db/a.db", "/w", []), { path: "/w/db/a.db", fromFlag: true, persisted: false });
	assert.deepEqual(resolveDbPath("/abs/a.db", "/w", []), { path: "/abs/a.db", fromFlag: true, persisted: false });
});

test("no flag falls back to the saved session entry", () => {
	for (const flag of [undefined, false, ""]) {
		assert.deepEqual(resolveDbPath(flag, "/w", [entry("/old.db")]), { path: "/old.db", fromFlag: false, persisted: true });
	}
});

test("the last saved entry wins", () => {
	assert.equal(resolveDbPath(undefined, "/w", [entry("/one.db"), { type: "message" }, entry("/two.db")])?.path, "/two.db");
});

test("flag overrides the saved entry; equal paths count as persisted", () => {
	assert.deepEqual(resolveDbPath("/new.db", "/w", [entry("/old.db")]), { path: "/new.db", fromFlag: true, persisted: false });
	assert.deepEqual(resolveDbPath("/old.db", "/w", [entry("/old.db")]), { path: "/old.db", fromFlag: true, persisted: true });
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
