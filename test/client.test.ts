import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildClient, InProcessClient, openClient } from "../src/client.ts";

const RUNAWAY = "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c) SELECT count(*) FROM c";

function dbPath(): string {
	return join(mkdtempSync(join(tmpdir(), "pi-sqlite-client-")), "c.db");
}

const alive = (pid: number | undefined) => {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 20));
	}
}

async function child(opts: { timeoutMs?: number } = {}, path = dbPath()) {
	const client = new ChildClient(opts);
	await client.open({ path, readOnly: false });
	return client;
}

test("openClient uses a query process, and results match in-process execution", async () => {
	const path = dbPath();
	const { client, created, fallbackReason } = await openClient({ path, readOnly: false });
	try {
		assert.equal(client.kind, "child");
		assert.equal(created, true);
		assert.equal(fallbackReason, undefined);
		await client.exec("create table t(a, b); insert into t values (1, 'x'), (9007199254740993, x'00')");
		const viaChild = await client.exec("select * from t");
		const local = new InProcessClient();
		await local.open({ path, readOnly: true });
		const viaLocal = await local.exec("select * from t");
		local.close();
		assert.deepEqual({ ...viaChild, durationMs: 0 }, { ...viaLocal, durationMs: 0 });
		assert.deepEqual(
			(await client.schema()).map((o) => o.name),
			["t"],
		);
	} finally {
		client.close();
	}
});

test("a runaway query is killed at the timeout and the next query works", async () => {
	const client = await child({ timeoutMs: 400 });
	try {
		await client.exec("create table t(x); insert into t values (1)");
		const first = client.pid;
		const started = Date.now();
		const r = await client.exec(RUNAWAY);
		assert.equal(r.kind, "error");
		assert.match(r.error ?? "", /stopped after/);
		assert.ok(Date.now() - started < 3000);
		await waitUntil(() => !alive(first));
		assert.deepEqual((await client.exec("select count(*) from t")).rows, [[1]]);
		assert.notEqual(client.pid, first);
	} finally {
		client.close();
	}
});

test("an abort signal cancels a running query", async () => {
	const client = await child();
	try {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 200);
		const r = await client.exec(RUNAWAY, ac.signal);
		assert.equal(r.kind, "error");
		assert.match(r.error ?? "", /cancelled/);
		const already = new AbortController();
		already.abort();
		assert.match((await client.exec("select 1", already.signal)).error ?? "", /cancelled/);
		assert.equal((await client.exec("select 1")).kind, "rows");
	} finally {
		client.close();
	}
});

test("a write killed mid-way is rolled back", async () => {
	const client = await child({ timeoutMs: 400 });
	try {
		await client.exec("create table t(x); insert into t values (1)");
		// Inserts rows continuously until killed.
		const r = await client.exec("insert into t with recursive c(i) as (select 1 union all select i + 1 from c) select i from c");
		assert.match(r.error ?? "", /stopped after/);
		assert.deepEqual((await client.exec("select count(*) from t")).rows, [[1]]);
	} finally {
		client.close();
	}
});

test("parallel calls run one at a time, in order", async () => {
	const client = await child();
	try {
		await client.exec("create table t(n)");
		await Promise.all([1, 2, 3, 4, 5].map((n) => client.exec(`insert into t values (${n})`)));
		assert.deepEqual((await client.exec("select group_concat(n) from t")).rows, [["1,2,3,4,5"]]);
	} finally {
		client.close();
	}
});

test("close() ends the query process, even mid-query", async () => {
	const idle = await child();
	const idlePid = idle.pid;
	idle.close();
	await waitUntil(() => !alive(idlePid));

	const busy = await child();
	const busyPid = busy.pid;
	const pending = busy.exec(RUNAWAY);
	await new Promise((r) => setTimeout(r, 100));
	busy.close();
	assert.equal((await pending).kind, "error");
	await waitUntil(() => !alive(busyPid));
	assert.match((await busy.exec("select 1")).error ?? "", /closed/);
});

test("open errors are reported, not hidden behind the in-process fallback", async () => {
	await assert.rejects(openClient({ path: join(dbPath(), "..", "nope", "x.db"), readOnly: true }), /does not exist/);
});

test("the query process loads from inside node_modules (where Node won't strip types itself)", async () => {
	const root = join(mkdtempSync(join(tmpdir(), "pi-sqlite-nm-")), "node_modules", "pi-sqlite");
	mkdirSync(root, { recursive: true });
	cpSync(new URL("../src", import.meta.url), join(root, "src"), { recursive: true });
	cpSync(new URL("../package.json", import.meta.url), join(root, "package.json"));
	// Drive the copied host directly over IPC, the way ChildClient does.
	const { fork } = await import("node:child_process");
	const proc = fork(join(root, "src", "host", "bootstrap.mjs"), [], {
		execArgv: [],
		stdio: ["ignore", "ignore", "pipe", "ipc"],
		serialization: "advanced",
	});
	try {
		const replies: any[] = [];
		proc.on("message", (m) => replies.push(m));
		await waitUntil(() => replies.length >= 1, 10_000);
		assert.deepEqual(replies[0], { id: 0, ok: true, value: "ready" });
		proc.send({ id: 1, op: "open", path: ":memory:", readOnly: false });
		proc.send({ id: 2, op: "exec", sql: "select 41 + 1 as n" });
		await waitUntil(() => replies.length >= 3, 10_000);
		assert.equal(replies[1].ok, true);
		assert.deepEqual(replies[2].value.rows, [[42]]);
	} finally {
		proc.kill("SIGKILL");
	}
});
