import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { assertSafetySupport, type HardenOptions, hardenDatabase, lastDenial, resetDenial } from "./security.ts";

export type Cell = string | number | null;
export type ExecKind = "rows" | "changes" | "script" | "error";

export interface ExecResult {
	sql: string;
	kind: ExecKind;
	columns: string[];
	/** Capped at DETAILS_MAX_ROWS (or the maxRows argument). */
	rows: Cell[][];
	/** Total number of rows the statement produced (a lower bound when countCapped). */
	rowCount: number;
	truncated: boolean;
	/** Counting stopped at COUNT_LIMIT rows or COUNT_TIME_MS; the real total is larger. */
	countCapped?: boolean;
	changes?: number;
	lastInsertRowid?: number | string;
	/** For kind "script". */
	statements?: number;
	error?: string;
	schemaChanged: boolean;
	/** New/changed CREATE sql, plus "DROPPED <type> <name>" lines. */
	ddl: string[];
	durationMs: number;
}

export const DETAILS_MAX_ROWS = 500;
/** Stop stepping through a result after this many rows (keeps runaway queries from hanging Pi). */
export const COUNT_LIMIT = 100_000;
/** …or after this long, whichever comes first. */
export const COUNT_TIME_MS = 2000;
/** Longest cell text kept in details (persisted in the session file). */
export const DETAILS_MAX_CELL_CHARS = 2000;

type SqliteModule = typeof import("node:sqlite");
let sqliteModule: SqliteModule | undefined;

/**
 * Load node:sqlite lazily, swallowing the one-time ExperimentalWarning Node 22.x prints,
 * which would otherwise be written to stderr on top of Pi's TUI.
 */
function loadSqlite(): SqliteModule {
	if (sqliteModule) return sqliteModule;
	const original = process.emitWarning;
	process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
		const message = typeof warning === "string" ? warning : warning?.message;
		const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
		const name = typeof warning === "string" ? type : warning?.name;
		if ((name === "ExperimentalWarning" || type === "ExperimentalWarning") && /sqlite/i.test(message ?? "")) return;
		return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
	} as typeof process.emitWarning;
	try {
		sqliteModule = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
		return sqliteModule;
	} finally {
		process.emitWarning = original;
	}
}

export type OpenOptions = HardenOptions;

/**
 * Open a database with the safety policy applied (see security.ts). Read-only mode never creates
 * a file. Throws when the file can't be opened or this Node.js lacks the safety APIs.
 */
export function openDatabase(absPath: string, opts: OpenOptions = {}): { db: DatabaseSync; created: boolean } {
	const readOnly = opts.readOnly === true;
	const { DatabaseSync } = loadSqlite();
	assertSafetySupport(DatabaseSync.prototype);
	const exists = absPath === ":memory:" || existsSync(absPath);
	if (readOnly && !exists) throw new Error(`${absPath} does not exist (read-only mode doesn't create databases)`);
	const db = new DatabaseSync(absPath, { timeout: 5000, readOnly });
	try {
		db.exec("PRAGMA foreign_keys = ON");
		hardenDatabase(db, { readOnly, growthLimitBytes: opts.growthLimitBytes });
	} catch (err) {
		db.close();
		throw err;
	}
	return { db, created: !exists };
}

export type SqlSegmentKind = "quoted" | "comment" | "semicolon" | "code";
export interface SqlSegment {
	kind: SqlSegmentKind;
	text: string;
}

/**
 * Split SQL into string/identifier literals, comments, semicolons and other code. Concatenating
 * every segment's text gives back the input.
 */
export function scanSql(sql: string): SqlSegment[] {
	const out: SqlSegment[] = [];
	const len = sql.length;
	let codeStart = 0;
	let i = 0;
	const push = (kind: SqlSegmentKind, start: number, end: number) => {
		if (start > codeStart) out.push({ kind: "code", text: sql.slice(codeStart, start) });
		out.push({ kind, text: sql.slice(start, end) });
		codeStart = end;
		i = end;
	};
	while (i < len) {
		const c = sql[i];
		const next = sql[i + 1];
		if (c === "'" || c === '"' || c === "`") {
			let j = i + 1;
			while (j < len) {
				if (sql[j] === c) {
					if (sql[j + 1] === c) {
						j += 2;
						continue;
					}
					break;
				}
				j++;
			}
			push("quoted", i, Math.min(len, j + 1));
		} else if (c === "[") {
			const j = sql.indexOf("]", i + 1);
			push("quoted", i, j < 0 ? len : j + 1);
		} else if (c === "-" && next === "-") {
			const j = sql.indexOf("\n", i);
			push("comment", i, j < 0 ? len : j);
		} else if (c === "/" && next === "*") {
			const j = sql.indexOf("*/", i + 2);
			push("comment", i, j < 0 ? len : j + 2);
		} else if (c === ";") {
			push("semicolon", i, i + 1);
		} else {
			i++;
		}
	}
	if (len > codeStart) out.push({ kind: "code", text: sql.slice(codeStart) });
	return out;
}

/** Count top-level SQL statements, ignoring semicolons inside strings, identifiers and comments. */
export function countStatements(sql: string): number {
	let count = 0;
	let hasContent = false;
	for (const seg of scanSql(sql)) {
		if (seg.kind === "semicolon") {
			if (hasContent) count++;
			hasContent = false;
		} else if (seg.kind === "quoted" || (seg.kind === "code" && /\S/.test(seg.text))) {
			hasContent = true;
		}
	}
	if (hasContent) count++;
	return count;
}

/** Remove SQL comments (text a database author controls, e.g. in CREATE statements) without touching literals. */
export function stripSqlComments(sql: string): string {
	const parts: string[] = [];
	for (const seg of scanSql(sql)) {
		if (seg.kind !== "comment") {
			parts.push(seg.text);
		} else if (seg.text.startsWith("--")) {
			// Drop the spaces before a trailing line comment too; the newline after it is kept.
			const prev = parts.length - 1;
			if (prev >= 0 && !/^['"`[]/.test(parts[prev])) parts[prev] = parts[prev].replace(/[ \t]+$/, "");
		} else {
			parts.push(" ");
		}
	}
	return parts.join("");
}

/** Cut a string to at most max UTF-16 units, ending in "…", without splitting a surrogate pair. */
export function capText(s: string, max: number): string {
	if (s.length <= max) return s;
	let cut = max - 1;
	const code = s.charCodeAt(cut - 1);
	if (code >= 0xd800 && code <= 0xdbff) cut--;
	return `${s.slice(0, cut)}…`;
}

function toCell(value: unknown): Cell {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") return value;
	if (typeof value === "string") return capText(value, DETAILS_MAX_CELL_CHARS);
	if (typeof value === "bigint") {
		return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
			? Number(value)
			: value.toString();
	}
	if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
	return capText(String(value), DETAILS_MAX_CELL_CHARS);
}

function toNumberish(value: number | bigint): number | string {
	return typeof value === "bigint" ? toCell(value) as number | string : value;
}

type Snapshot = Map<string, { type: string; name: string; sql: string | null }>;

function snapshotSchema(db: DatabaseSync): Snapshot {
	const rows = db
		.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
		.all() as { type: string; name: string; sql: string | null }[];
	return new Map(rows.map((r) => [`${r.type}:${r.name}`, { type: r.type, name: r.name, sql: r.sql }]));
}

function diffSchema(before: Snapshot, after: Snapshot): string[] {
	const ddl: string[] = [];
	for (const [key, obj] of after) {
		const prev = before.get(key);
		if (obj.sql && (!prev || prev.sql !== obj.sql)) ddl.push(obj.sql);
	}
	for (const [key, obj] of before) {
		if (!after.has(key)) ddl.push(`DROPPED ${obj.type} ${obj.name}`);
	}
	return ddl;
}

function readRows(
	stmt: StatementSync,
	columns: string[],
	maxRows: number,
): { rows: Cell[][]; rowCount: number; countCapped: boolean } {
	const arrays = typeof (stmt as { setReturnArrays?: unknown }).setReturnArrays === "function";
	if (arrays) (stmt as unknown as { setReturnArrays(v: boolean): void }).setReturnArrays(true);
	// Read integers as BigInt up front: re-running after an out-of-range error would execute
	// DML ... RETURNING twice. toCell turns safe bigints back into numbers.
	stmt.setReadBigInts(true);
	const started = performance.now();
	const rows: Cell[][] = [];
	let rowCount = 0;
	let countCapped = false;
	for (const raw of stmt.iterate()) {
		rowCount++;
		if (rows.length < maxRows) {
			const values: unknown[] = arrays
				? (raw as unknown as unknown[])
				: columns.map((c) => (raw as Record<string, unknown>)[c]);
			rows.push(values.map(toCell));
		}
		if (rowCount >= COUNT_LIMIT || (rowCount % 1000 === 0 && performance.now() - started > COUNT_TIME_MS)) {
			countCapped = true;
			break;
		}
	}
	return { rows, rowCount, countCapped };
}

export function execute(db: DatabaseSync, sql: string, maxRows: number = DETAILS_MAX_ROWS): ExecResult {
	const start = performance.now();
	const base: ExecResult = {
		sql,
		kind: "error",
		columns: [],
		rows: [],
		rowCount: 0,
		truncated: false,
		schemaChanged: false,
		ddl: [],
		durationMs: 0,
	};
	const done = (r: Partial<ExecResult>): ExecResult => ({
		...base,
		...r,
		durationMs: Math.round((performance.now() - start) * 100) / 100,
	});
	resetDenial(db);
	try {
		const statements = countStatements(sql);
		if (statements === 0) return done({ kind: "error", error: "No SQL statement to execute." });
		if (statements > 1) {
			const before = snapshotSchema(db);
			db.exec(sql);
			const ddl = diffSchema(before, snapshotSchema(db));
			return done({ kind: "script", statements, ddl, schemaChanged: ddl.length > 0 });
		}
		const stmt = db.prepare(sql);
		const columns = stmt.columns().map((c) => c.name);
		if (columns.length > 0) {
			const { rows, rowCount, countCapped } = readRows(stmt, columns, maxRows);
			return done({
				kind: "rows",
				columns,
				rows,
				rowCount,
				truncated: rowCount > rows.length,
				...(countCapped ? { countCapped } : {}),
			});
		}
		const before = snapshotSchema(db);
		const counters = db.prepare("SELECT total_changes() AS tc, last_insert_rowid() AS lr");
		counters.setReadBigInts(true);
		const c0 = counters.get() as { tc: bigint; lr: bigint };
		const res = stmt.run();
		const c1 = counters.get() as { tc: bigint; lr: bigint };
		const ddl = diffSchema(before, snapshotSchema(db));
		// sqlite3_changes() keeps the previous DML's count for statements that change no rows
		// (CREATE, ALTER, PRAGMA, ...), so only trust it when total_changes() moved.
		const changed = c1.tc !== c0.tc;
		return done({
			kind: "changes",
			changes: changed ? Number(res.changes) : 0,
			...(c1.lr !== c0.lr ? { lastInsertRowid: toNumberish(c1.lr) } : {}),
			ddl,
			schemaChanged: ddl.length > 0,
		});
	} catch (err) {
		const denial = lastDenial(db);
		const message = err instanceof Error ? err.message : String(err);
		return done({ kind: "error", error: denial ? `Blocked by pi-sqlite: ${denial}` : message });
	}
}
