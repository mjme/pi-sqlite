/**
 * The query process: owns the SQLite connection and answers requests from src/client.ts over IPC.
 * Running SQL here keeps Pi responsive, and lets the parent kill a runaway query outright
 * (node:sqlite has no interrupt API).
 */
import type { DatabaseSync } from "node:sqlite";
import type { HostRequest, HostResponse } from "../client.ts";
import { execute, openDatabase } from "../db.ts";
import { readSchema } from "../schema.ts";

let db: DatabaseSync | undefined;

function requireDb(): DatabaseSync {
	if (!db) throw new Error("No database is open.");
	return db;
}

function closeDb(): void {
	try {
		db?.close();
	} catch {
		// already closed
	}
	db = undefined;
}

function handle(req: HostRequest): unknown {
	switch (req.op) {
		case "open": {
			closeDb();
			const opened = openDatabase(req.path, { readOnly: req.readOnly, growthLimitBytes: req.growthLimitBytes });
			db = opened.db;
			return { created: opened.created };
		}
		case "exec":
			return execute(requireDb(), req.sql, req.maxRows);
		case "schema":
			return readSchema(requireDb());
		case "close":
			closeDb();
			return null;
	}
}

const send = (res: HostResponse) => process.send?.(res);

process.on("message", (req: HostRequest) => {
	try {
		send({ id: req.id, ok: true, value: handle(req) });
	} catch (err) {
		send({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
	}
});

// Never outlive Pi.
process.on("disconnect", () => {
	closeDb();
	process.exit(0);
});

send({ id: 0, ok: true, value: "ready" });
