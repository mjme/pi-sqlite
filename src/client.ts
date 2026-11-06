import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { type ExecResult, execute, openDatabase } from "./db.ts";
import { type SchemaObject, readSchema } from "./schema.ts";

/** A query (or schema read) running longer than this is killed. */
export const QUERY_TIMEOUT_MS = 30_000;
/** How long the query process may take to start. */
const START_TIMEOUT_MS = 15_000;
/** Bytes of the query process's stderr kept for error messages. */
const STDERR_TAIL = 2000;

export interface OpenParams {
	path: string;
	readOnly: boolean;
	growthLimitBytes?: number;
}

export type HostOp =
	| ({ op: "open" } & OpenParams)
	| { op: "exec"; sql: string; maxRows?: number }
	| { op: "schema" }
	| { op: "close" };
export type HostRequest = { id: number } & HostOp;
export type HostResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

/** Runs SQL against one open database. */
export interface SqliteClient {
	/** "child": a separate process that can be killed; "in-process": on Pi's own thread (no cancel). */
	readonly kind: "child" | "in-process";
	open(params: OpenParams): Promise<{ created: boolean }>;
	/** Never rejects: failures, timeouts and cancellation come back as `kind: "error"` results. */
	exec(sql: string, signal?: AbortSignal): Promise<ExecResult>;
	schema(): Promise<SchemaObject[]>;
	close(): void;
}

export interface ClientOptions {
	timeoutMs?: number;
}

/** The query process could not be started (as opposed to the database failing to open). */
export class HostStartError extends Error {}

class StoppedError extends Error {
	readonly why: "timeout" | "cancelled";
	constructor(why: "timeout" | "cancelled") {
		super(why);
		this.why = why;
	}
}

function errorResult(sql: string, error: string, durationMs = 0): ExecResult {
	return {
		sql,
		kind: "error",
		columns: [],
		rows: [],
		rowCount: 0,
		truncated: false,
		schemaChanged: false,
		ddl: [],
		durationMs,
		error,
	};
}

const BOOTSTRAP = fileURLToPath(new URL("./host/bootstrap.mjs", import.meta.url));

/** SQLite in a forked Node process: Pi stays responsive, and timeouts/Esc kill the query outright. */
export class ChildClient implements SqliteClient {
	readonly kind = "child";
	private child?: ChildProcess;
	private params?: OpenParams;
	private queue: Promise<unknown> = Promise.resolve();
	private nextId = 1;
	private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
	private stderr = "";
	private closed = false;
	private readonly timeoutMs: number;

	constructor(opts: ClientOptions = {}) {
		this.timeoutMs = opts.timeoutMs ?? QUERY_TIMEOUT_MS;
	}

	/** PID of the running query process (for tests). */
	get pid(): number | undefined {
		return this.child?.pid;
	}

	open(params: OpenParams): Promise<{ created: boolean }> {
		return this.serial(async () => {
			await this.ensureStarted();
			this.params = undefined;
			const value = (await this.request({ op: "open", ...params }, this.timeoutMs)) as { created: boolean };
			this.params = params;
			return value;
		});
	}

	exec(sql: string, signal?: AbortSignal): Promise<ExecResult> {
		return this.serial(async () => {
			const started = performance.now();
			const elapsed = () => Math.round(performance.now() - started);
			if (signal?.aborted) return errorResult(sql, "Query cancelled.");
			try {
				await this.ensureReady();
				return (await this.request({ op: "exec", sql }, this.timeoutMs, signal)) as ExecResult;
			} catch (err) {
				if (err instanceof StoppedError) {
					const what =
						err.why === "timeout"
							? `Query stopped after ${Math.round(this.timeoutMs / 1000)}s. Narrow it (LIMIT, WHERE, fewer joins) and try again.`
							: "Query cancelled.";
					return errorResult(sql, `${what} Any statement still running was rolled back.`, elapsed());
				}
				return errorResult(sql, err instanceof Error ? err.message : String(err), elapsed());
			}
		});
	}

	schema(): Promise<SchemaObject[]> {
		return this.serial(async () => {
			await this.ensureReady();
			return (await this.request({ op: "schema" }, this.timeoutMs)) as SchemaObject[];
		});
	}

	close(): void {
		this.closed = true;
		this.params = undefined;
		const child = this.child;
		if (!child) return;
		// Idle: let it close the database cleanly. Busy: a query may never return, so kill it.
		if (this.pending.size > 0) this.kill();
		else if (child.connected) child.disconnect();
	}

	/** Run one operation at a time: there is one connection, and Pi may run tool calls in parallel. */
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => {});
		return run;
	}

	/** Start the process if needed and reopen the database after a kill. */
	private async ensureReady(): Promise<void> {
		if (this.closed) throw new Error("The database is closed.");
		if (this.child) return;
		const params = this.params;
		await this.ensureStarted();
		if (params) await this.request({ op: "open", ...params }, this.timeoutMs);
	}

	private async ensureStarted(): Promise<void> {
		if (this.child) return;
		this.closed = false;
		this.stderr = "";
		let child: ChildProcess;
		try {
			child = fork(BOOTSTRAP, [], {
				execPath: process.execPath,
				execArgv: [],
				// stdout/stderr must never reach Pi's TUI; stderr is kept for error messages.
				stdio: ["ignore", "ignore", "pipe", "ipc"],
				serialization: "advanced",
			});
		} catch (err) {
			throw new HostStartError(`Could not start the query process: ${err instanceof Error ? err.message : String(err)}`);
		}
		this.child = child;
		// Each process gets its own pending map: a killed process's late exit event must not fail
		// requests already sent to its replacement.
		const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
		this.pending = pending;
		// Don't keep Pi (or a test run) alive just because the query process exists; pending
		// requests hold a timer, which keeps the event loop alive while they wait.
		child.unref();
		child.channel?.unref();
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_TAIL);
		});
		(child.stderr as { unref?: () => void } | null)?.unref?.();
		child.on("message", (res: HostResponse) => {
			const p = pending.get(res.id);
			if (!p) return;
			pending.delete(res.id);
			if (res.ok) p.resolve(res.value);
			else p.reject(new Error(res.error));
		});
		child.on("exit", (code, signal) => {
			if (this.child === child) this.child = undefined;
			const why = `The query process exited (${signal ?? `code ${code}`}).${this.stderrNote()}`;
			for (const p of pending.values()) p.reject(new Error(why));
			pending.clear();
		});
		child.on("error", (err) => {
			for (const p of pending.values()) p.reject(err);
			pending.clear();
		});
		try {
			await this.waitFor(0, START_TIMEOUT_MS);
		} catch (err) {
			this.kill();
			throw new HostStartError(
				`Could not start the query process: ${err instanceof Error ? err.message : String(err)}${this.stderrNote()}`,
			);
		}
	}

	private stderrNote(): string {
		const tail = this.stderr.trim().split("\n").filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l)).slice(-3).join(" ");
		return tail ? ` ${tail}` : "";
	}

	private request(req: HostOp, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		const child = this.child;
		if (!child) return Promise.reject(new Error("The query process is not running."));
		const id = this.nextId++;
		const reply = this.waitFor(id, timeoutMs, signal);
		child.send({ ...req, id } as HostRequest);
		return reply;
	}

	/** Wait for the response with this id; on timeout or abort, kill the process. */
	private waitFor(id: number, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const finish = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			const pending = this.pending;
			const stop = (why: "timeout" | "cancelled") => {
				finish();
				pending.delete(id);
				this.kill();
				reject(new StoppedError(why));
			};
			const timer = setTimeout(() => stop("timeout"), timeoutMs);
			const onAbort = () => stop("cancelled");
			signal?.addEventListener("abort", onAbort, { once: true });
			pending.set(id, {
				resolve: (v) => {
					finish();
					resolve(v);
				},
				reject: (e) => {
					finish();
					reject(e);
				},
			});
		});
	}

	private kill(): void {
		const child = this.child;
		this.child = undefined;
		if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
}

/** SQLite on Pi's own thread: the fallback when a query process can't be used. Queries can't be cancelled. */
export class InProcessClient implements SqliteClient {
	readonly kind = "in-process";
	private db?: DatabaseSync;

	async open(params: OpenParams): Promise<{ created: boolean }> {
		this.close();
		const { db, created } = openDatabase(params.path, { readOnly: params.readOnly, growthLimitBytes: params.growthLimitBytes });
		this.db = db;
		return { created };
	}

	async exec(sql: string): Promise<ExecResult> {
		if (!this.db) return errorResult(sql, "The database is closed.");
		return execute(this.db, sql);
	}

	async schema(): Promise<SchemaObject[]> {
		if (!this.db) throw new Error("The database is closed.");
		return readSchema(this.db);
	}

	close(): void {
		try {
			this.db?.close();
		} catch {
			// already closed
		}
		this.db = undefined;
	}
}

/** Why the query process can't be used in this runtime, if it can't. */
export function inProcessReason(): string | undefined {
	if (process.env.PI_SQLITE_IN_PROCESS === "1") return "PI_SQLITE_IN_PROCESS=1 is set";
	if (typeof process.versions.bun === "string") return "Pi is running on Bun";
	const sea = process.getBuiltinModule?.("node:sea") as { isSea?: () => boolean } | undefined;
	if (sea?.isSea?.()) return "Pi is a single-executable build";
	return undefined;
}

export interface OpenedClient {
	client: SqliteClient;
	created: boolean;
	/** Set when queries run in-process, explaining why (long queries can't be cancelled). */
	fallbackReason?: string;
}

/** Open a database in a query process, falling back to in-process when the process can't start. */
export async function openClient(params: OpenParams, opts: ClientOptions = {}): Promise<OpenedClient> {
	let fallbackReason = inProcessReason();
	if (!fallbackReason) {
		const client = new ChildClient(opts);
		try {
			const { created } = await client.open(params);
			return { client, created };
		} catch (err) {
			client.close();
			if (!(err instanceof HostStartError)) throw err;
			fallbackReason = err.message;
		}
	}
	const client = new InProcessClient();
	const { created } = await client.open(params);
	return { client, created, fallbackReason };
}
