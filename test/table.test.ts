import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExecResult } from "../src/db.ts";
import { plainStyle, renderResultLines, resultView } from "../src/table.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

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
		durationMs: 3,
		...r,
	};
}

const artists = result({
	columns: ["id", "name"],
	rows: [
		[1, "AC/DC"],
		[2, "Accept"],
		[10, null],
	],
	rowCount: 3,
});

const opts = { expanded: false, style: plainStyle, expandHint: "ctrl+o to expand" };

test("renders header, separator, rows and footer", () => {
	const lines = renderResultLines(artists, 80, opts).map(strip);
	assert.match(lines[0], /id.*│.*name/);
	assert.match(lines[1], /^[─┼]+$/);
	assert.equal(lines.length, 2 + 3 + 1);
	assert.match(lines.at(-1)!, /3 rows/);
	// numbers right-aligned: "1" and "10" end at the same column
	assert.equal(lines[2].indexOf("1") + 1, lines[4].indexOf("10") + 2);
	assert.match(lines[4], /NULL/);
});

test("every line fits the width, including wide characters", () => {
	const wide = result({
		columns: ["id", "description", "japanese", "emoji", "notes", "more"],
		rows: Array.from({ length: 5 }, (_, i) => [
			i,
			"a fairly long piece of descriptive text that will need truncation",
			"日本語テキスト日本語テキスト",
			"😀😀😀😀 party",
			"x".repeat(80),
			"multi\nline",
		]),
		rowCount: 5,
	});
	for (const width of [20, 40, 80, 200]) {
		for (const line of renderResultLines(wide, width, opts)) {
			assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`);
		}
	}
	const text = renderResultLines(wide, 200, opts).map(strip).join("\n");
	assert.match(text, /multi⏎line/);
});

test("collapsed view shows 10 rows and an expand hint", () => {
	const r = result({ columns: ["n"], rows: Array.from({ length: 25 }, (_, i) => [i]), rowCount: 25 });
	const lines = renderResultLines(r, 80, opts).map(strip);
	assert.equal(lines.length, 2 + 10 + 1);
	const footer = lines.at(-1)!;
	assert.match(footer, /15 more/);
	assert.match(footer, /25 total/);
	assert.match(footer, /ctrl\+o to expand/);
});

test("expanded view shows all stored rows and notes truncation", () => {
	const r = result({ columns: ["n"], rows: Array.from({ length: 25 }, (_, i) => [i]), rowCount: 25 });
	assert.equal(renderResultLines(r, 80, { ...opts, expanded: true }).length, 2 + 25 + 1);
	const big = result({ columns: ["n"], rows: Array.from({ length: 500 }, (_, i) => [i]), rowCount: 1200, truncated: true });
	const lines = renderResultLines(big, 80, { ...opts, expanded: true }).map(strip);
	assert.equal(lines.length, 2 + 500 + 1);
	assert.match(lines.at(-1)!, /500 of 1,200 rows shown/);
});

test("changes, script and error results", () => {
	const changes = renderResultLines(result({ kind: "changes", changes: 3, lastInsertRowid: 42 }), 80, opts).map(strip);
	assert.deepEqual(changes, ["✓ 3 rows changed · last id 42"]);
	const script = renderResultLines(result({ kind: "script", statements: 3 }), 80, opts).map(strip);
	assert.equal(script[0], "✓ script executed (3 statements)");
	const err = renderResultLines(result({ kind: "error", error: "no such table: nope" }), 80, opts).map(strip);
	assert.ok(err.some((l) => l.includes("no such table: nope")));
});

test("resultView caches per width and recomputes after invalidate", () => {
	const view = resultView(artists, opts);
	const a = view.render(40);
	assert.equal(view.render(40), a);
	view.invalidate();
	const b = view.render(40);
	assert.notEqual(b, a);
	assert.deepEqual(b, a);
});

test("fix: unknown details render nothing harmful instead of undefined", () => {
	const lines = renderResultLines({} as ExecResult, 40, opts);
	assert.ok(Array.isArray(lines));
});
