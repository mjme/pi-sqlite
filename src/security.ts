import type { DatabaseSync } from "node:sqlite";

/**
 * SQL safety policy. SQLite can reach outside the opened database file: ATTACH and VACUUM INTO
 * create or open files at any path, and some PRAGMAs corrupt the database or redirect temp files.
 * An authorizer callback vetoes those at prepare time, for the model, for /sql and for trigger
 * bodies alike.
 */

/** SQLite authorizer action and result codes (stable C API values, see sqlite3.h). */
export const SQLITE_OK = 0;
export const SQLITE_DENY = 1;
export const SQLITE_PRAGMA = 19;
export const SQLITE_ATTACH = 24;
export const SQLITE_FUNCTION = 31;

/** Default cap on how much the database may grow per connection (disk-fill guard). */
export const DEFAULT_GROWTH_LIMIT_BYTES = 1024 * 1024 * 1024;

/** First Node.js versions with DatabaseSync#setAuthorizer and #enableDefensive. */
export const MIN_NODE_VERSION = "24.12.0";

/** PRAGMAs that may be read but not set. */
const LOCKED_PRAGMAS = new Set([
	"writable_schema",
	"schema_version",
	"trusted_schema",
	"temp_store_directory",
	"data_store_directory",
	"max_page_count",
	"mmap_size",
]);

const BLOCKED_FUNCTIONS = new Set(["load_extension", "fts3_tokenizer"]);

const ATTACH_REASON = "ATTACH and VACUUM INTO are blocked because they can read or write files outside this database.";

/**
 * Decide one authorizer request. Returns a denial reason, or undefined to allow.
 * `arg1`/`arg2` follow sqlite3_set_authorizer: ATTACH → (filename, null); PRAGMA → (name, value);
 * FUNCTION → (null, name).
 */
export function denialReason(action: number, arg1: string | null, arg2: string | null): string | undefined {
	switch (action) {
		case SQLITE_ATTACH:
			// Plain VACUUM attaches a temporary database with an empty filename; nothing touches disk by name.
			return arg1 === "" || arg1 === ":memory:" ? undefined : ATTACH_REASON;
		case SQLITE_PRAGMA: {
			if (arg2 === null) return undefined;
			const name = (arg1 ?? "").toLowerCase();
			if (LOCKED_PRAGMAS.has(name) || (name === "journal_mode" && arg2.toLowerCase() === "off")) {
				return `PRAGMA ${name} can't be changed here because it can corrupt the database or touch files outside it.`;
			}
			return undefined;
		}
		case SQLITE_FUNCTION: {
			const name = (arg2 ?? "").toLowerCase();
			return BLOCKED_FUNCTIONS.has(name) ? `${name}() is blocked.` : undefined;
		}
		default:
			return undefined;
	}
}

interface Guard {
	lastDenial?: string;
}

const guards = new WeakMap<DatabaseSync, Guard>();

/** Clear the remembered denial before running a statement. */
export function resetDenial(db: DatabaseSync): void {
	const g = guards.get(db);
	if (g) g.lastDenial = undefined;
}

/** The reason the authorizer last denied something on this connection, if any. */
export function lastDenial(db: DatabaseSync): string | undefined {
	return guards.get(db)?.lastDenial;
}

/** Throw unless this Node.js build has the APIs the safety policy depends on. */
export function assertSafetySupport(proto: object): void {
	const p = proto as { setAuthorizer?: unknown; enableDefensive?: unknown };
	if (typeof p.setAuthorizer !== "function" || typeof p.enableDefensive !== "function") {
		throw new Error(
			`pi-sqlite needs Node.js ${MIN_NODE_VERSION} or newer for its SQL safety checks (found ${process.version}).`,
		);
	}
}

export interface HardenOptions {
	readOnly?: boolean;
	growthLimitBytes?: number;
}

/** Apply the safety policy to a freshly opened connection. The authorizer goes in last so setup isn't blocked. */
export function hardenDatabase(db: DatabaseSync, opts: HardenOptions = {}): void {
	const d = db as DatabaseSync & {
		enableDefensive(active: boolean): void;
		setAuthorizer(cb: (action: number, a1: string | null, a2: string | null, dbName: string | null, trigger: string | null) => number): void;
	};
	d.enableDefensive(true);
	db.exec("PRAGMA trusted_schema = OFF");
	if (!opts.readOnly) {
		const { page_count, page_size } = db.prepare("SELECT page_count, page_size FROM pragma_page_count, pragma_page_size").get() as {
			page_count: number;
			page_size: number;
		};
		const limit = opts.growthLimitBytes ?? DEFAULT_GROWTH_LIMIT_BYTES;
		db.exec(`PRAGMA max_page_count = ${Number(page_count) + Math.max(1, Math.ceil(limit / Number(page_size)))}`);
	}
	const guard: Guard = {};
	guards.set(db, guard);
	d.setAuthorizer((action, a1, a2) => {
		const reason = denialReason(action, a1, a2);
		if (reason === undefined) return SQLITE_OK;
		guard.lastDenial = reason;
		return SQLITE_DENY;
	});
}
