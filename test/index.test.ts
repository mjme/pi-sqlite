import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import piSqlite from "../src/index.ts";
import { openDatabase } from "../src/db.ts";
import { formatForModel } from "../src/format.ts";
import { MODE_ENTRY } from "../src/mode.ts";
import { createFakeCtx, createFakePi, plainTheme } from "./fake-pi.ts";

const persona = readFileSync(new URL("../src/system-prompt.md", import.meta.url), "utf8")
	.replace(/^\s*<!--[\s\S]*?-->\s*/, "")
	.trim();

function tempDb(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-sqlite-"));
	const p = join(dir, "test.db");
	const { db } = openDatabase(p);
	db.exec("create table t(x); insert into t values (1),(2)");
	db.close();
	return p;
}

function promptEvent(opts: Partial<{ customPrompt: string; selectedTools: string[] }> = {}) {
	return {
		systemPrompt: "",
		systemPromptOptions: {
			cwd: "/w",
			customPrompt: opts.customPrompt,
			sections: {} as Record<string, string>,
			selectedTools: opts.selectedTools ?? ["read", "sqlite", "mcp_x"],
			hiddenTools: [],
			toolSnippets: {},
			toolGuidelines: {},
			promptGuidelines: [],
			appendSystemPrompt: "",
			contextFiles: [],
			skills: [],
		},
	};
}

async function sqlSession(dbPath = tempDb(), ctxOpts: { hasUI?: boolean } = {}) {
	const fake = createFakePi({ flags: { "sqlite-mode": dbPath } });
	piSqlite(fake.pi);
	const ctx = createFakeCtx({ cwd: "/w", ...ctxOpts });
	await fake.emit("session_start", { reason: "startup" }, ctx);
	return { fake, ctx, dbPath };
}

const runTool = (fake: any, ctx: any, sql: string) => fake.tools.sqlite.execute("id1", { sql }, undefined, undefined, ctx);
const lastStatus = (ctx: any) => ctx.statuses.filter((s: any) => s.key === "sqlite").at(-1)?.text;

test("registers flag and inactive tool without opening a DB", () => {
	const fake = createFakePi();
	piSqlite(fake.pi);
	assert.equal(fake.flags["sqlite-mode"].type, "string");
	assert.equal(fake.tools.sqlite.defaultActive, false);
	assert.equal(fake.tools.sqlite.label, "SQLite");
	assert.equal(fake.setActiveToolsCalls.length, 0);
});

test("plain session is untouched", async () => {
	const fake = createFakePi();
	piSqlite(fake.pi);
	const ctx = createFakeCtx({ cwd: "/w" });
	await fake.emit("session_start", { reason: "startup" }, ctx);
	assert.equal(fake.setActiveToolsCalls.length, 0);
	assert.equal(ctx.statuses.length, 0);
	assert.equal(fake.entries.length, 0);
	const ev = promptEvent();
	const before = structuredClone(ev);
	await fake.emit("before_agent_start", ev, ctx);
	assert.deepEqual(ev, before);
});

test("plain session with sqlite restored from the transcript gets it removed", async () => {
	const only = createFakePi({ activeTools: ["sqlite"] });
	piSqlite(only.pi);
	await only.emit("session_start", { reason: "resume" }, createFakeCtx({ cwd: "/w" }));
	assert.deepEqual(only.activeTools, ["read", "bash", "edit", "write"]);

	const mixed = createFakePi({ activeTools: ["read", "sqlite"] });
	piSqlite(mixed.pi);
	await mixed.emit("session_start", { reason: "resume" }, createFakeCtx({ cwd: "/w" }));
	assert.deepEqual(mixed.activeTools, ["read"]);
});

test("--sqlite-mode activates sqlite only, saves the path and sets the status", async () => {
	const { fake, ctx, dbPath } = await sqlSession();
	assert.deepEqual(fake.activeTools, ["sqlite"]);
	assert.deepEqual(fake.entries, [{ customType: MODE_ENTRY, data: { path: dbPath } }]);
	assert.equal(lastStatus(ctx), `sqlite: ${basename(dbPath)} · 1 table`);
});

test("a missing database file is created with a notice", async () => {
	const p = join(mkdtempSync(join(tmpdir(), "pi-sqlite-")), "fresh.db");
	const { ctx } = await sqlSession(p);
	assert.ok(existsSync(p));
	assert.ok(ctx.notifications.some((n) => n.message.includes("Created new database")));
});

test("no notice without UI, and nothing throws", async () => {
	const p = join(mkdtempSync(join(tmpdir(), "pi-sqlite-")), "fresh.db");
	const { ctx } = await sqlSession(p, { hasUI: false });
	assert.equal(ctx.notifications.length, 0);
});

test("resuming a saved SQL session without the flag re-enters SQL mode", async () => {
	const dbPath = tempDb();
	const fake = createFakePi();
	piSqlite(fake.pi);
	const ctx = createFakeCtx({
		cwd: "/elsewhere",
		branch: [{ type: "custom", customType: MODE_ENTRY, data: { path: dbPath } }],
	});
	await fake.emit("session_start", { reason: "resume" }, ctx);
	assert.deepEqual(fake.activeTools, ["sqlite"]);
	assert.equal(fake.entries.length, 0);
	assert.match(lastStatus(ctx), /1 table/);
});

test("before_agent_start sets persona, schema section and sqlite-only tools", async () => {
	const { fake, ctx } = await sqlSession();
	const ev = promptEvent();
	await fake.emit("before_agent_start", ev, ctx);
	const o = ev.systemPromptOptions;
	assert.equal(o.customPrompt, persona);
	assert.ok(!o.customPrompt!.includes("<!--"));
	assert.match(o.sections.database_schema, /CREATE TABLE t/);
	assert.deepEqual(o.selectedTools, ["sqlite"]);
});

test("a user's own custom prompt is kept after the persona, idempotently", async () => {
	const { fake, ctx } = await sqlSession();
	const ev = promptEvent({ customPrompt: "USER" });
	await fake.emit("before_agent_start", ev, ctx);
	assert.equal(ev.systemPromptOptions.customPrompt, `${persona}\n\nUSER`);
	await fake.emit("before_agent_start", ev, ctx);
	assert.equal(ev.systemPromptOptions.customPrompt, `${persona}\n\nUSER`);
});

test("tool returns model text and details; errors are flagged", async () => {
	const { fake, ctx } = await sqlSession();
	const ok = await runTool(fake, ctx, "select * from t");
	assert.equal(ok.details.kind, "rows");
	assert.equal(ok.content[0].text, formatForModel(ok.details));
	assert.ok(!ok.isError);
	const bad = await runTool(fake, ctx, "select * from nope");
	assert.equal(bad.isError, true);
	assert.equal(bad.details.kind, "error");
});

test("DDL through the tool refreshes status and the schema section", async () => {
	const { fake, ctx } = await sqlSession();
	await runTool(fake, ctx, "create table u(y)");
	assert.match(lastStatus(ctx), /2 tables/);
	const ev = promptEvent();
	await fake.emit("before_agent_start", ev, ctx);
	assert.match(ev.systemPromptOptions.sections.database_schema, /CREATE TABLE u/);
});

test("tool without an open database explains how to start SQL mode", async () => {
	const fake = createFakePi();
	piSqlite(fake.pi);
	const ctx = createFakeCtx({ cwd: "/w" });
	await fake.emit("session_start", { reason: "startup" }, ctx);
	const r = await runTool(fake, ctx, "select 1");
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /--sqlite-mode/);
});

test("session_shutdown closes the database and clears the status", async () => {
	const { fake, ctx } = await sqlSession();
	await fake.emit("session_shutdown", { reason: "quit" }, ctx);
	assert.equal(lastStatus(ctx), undefined);
	const r = await runTool(fake, ctx, "select 1");
	assert.equal(r.isError, true);
});

test("renderers produce width-bounded output", async () => {
	const { fake, ctx } = await sqlSession();
	const result = await runTool(fake, ctx, "select * from t");
	const rctx = { keyHint: () => "ctrl+o to expand", expanded: false, lastComponent: undefined };
	const lines = fake.tools.sqlite
		.renderResult(result, { expanded: false, isPartial: false }, plainTheme, rctx)
		.render(60) as string[];
	assert.ok(lines.length > 0);
	for (const l of lines) assert.ok(visibleWidth(l) <= 60);
	const call = fake.tools.sqlite.renderCall({ sql: "select 1\nfrom t" }, plainTheme, rctx).render(60).join("\n");
	assert.match(call, /select 1/);
	assert.doesNotMatch(call, /from t/);
});

test("registers the /sql command and the sqlite-result message renderer", () => {
	const fake = createFakePi();
	piSqlite(fake.pi);
	assert.ok(fake.commands.sql?.handler);
	assert.ok(fake.commands.sql.description);
	assert.ok(fake.messageRenderers["sqlite-result"]);
});

test("/sql runs the query and adds the result to the model's context without a turn", async () => {
	const { fake, ctx } = await sqlSession();
	await fake.commands.sql.handler("select * from t", ctx);
	assert.equal(fake.sent.length, 1);
	const { message, options } = fake.sent[0];
	assert.equal(message.customType, "sqlite-result");
	assert.equal(message.display, true);
	assert.equal(message.details.kind, "rows");
	assert.equal(message.content, formatForModel(message.details));
	assert.ok(!options?.triggerTurn);
});

test("/sql DDL refreshes the status", async () => {
	const { fake, ctx } = await sqlSession();
	await fake.commands.sql.handler("create table w(z)", ctx);
	assert.match(lastStatus(ctx), /2 tables/);
});

test("/sql outside SQL mode and with no SQL just notifies", async () => {
	const plain = createFakePi();
	piSqlite(plain.pi);
	const pctx = createFakeCtx({ cwd: "/w" });
	await plain.emit("session_start", { reason: "startup" }, pctx);
	await plain.commands.sql.handler("select 1", pctx);
	assert.equal(plain.sent.length, 0);
	assert.ok(pctx.notifications.some((n) => n.message.includes("--sqlite-mode")));

	const { fake, ctx } = await sqlSession();
	await fake.commands.sql.handler("   ", ctx);
	assert.equal(fake.sent.length, 0);
	assert.ok(ctx.notifications.some((n) => n.message.includes("Usage: /sql <statement>")));
});

test("fix: /sql while the agent is busy is appended without steering or waiting for the next prompt", async () => {
	const fake = createFakePi({ flags: { "sqlite-mode": tempDb() } });
	piSqlite(fake.pi);
	const ctx = createFakeCtx({ cwd: "/w", idle: false });
	await fake.emit("session_start", { reason: "startup" }, ctx);
	await fake.commands.sql.handler("select 1", ctx);
	assert.equal(fake.sent[0].options?.deliverAs, undefined);
	assert.equal(fake.sent[0].options?.triggerTurn, false);
});

test("sqlite-result renderer draws a width-bounded table", async () => {
	const { fake, ctx } = await sqlSession();
	await fake.commands.sql.handler("select * from t", ctx);
	const lines = fake.messageRenderers["sqlite-result"](
		fake.sent[0].message,
		{ expanded: false, outputPad: 1, keyHint: () => "ctrl+o to expand", keyText: () => "ctrl+o" },
		plainTheme,
	).render(50) as string[];
	assert.ok(lines.length > 0);
	for (const l of lines) assert.ok(visibleWidth(l) <= 50);
});

test("fix: Pi-generated tool errors with empty details render the error text", async () => {
	const { fake } = await sqlSession();
	const rctx = { keyHint: () => "ctrl+o to expand", expanded: false, lastComponent: undefined };
	const result = { content: [{ type: "text", text: "Validation failed: sql is required" }], details: {}, isError: true };
	const lines = fake.tools.sqlite.renderResult(result, { expanded: false, isPartial: false }, plainTheme, rctx).render(60);
	assert.ok(Array.isArray(lines));
	assert.match(lines.join("\n"), /Validation failed/);
	for (const l of lines) assert.ok(visibleWidth(l) <= 60);
});

test("fix: sqlite-result renderer ignores malformed details", async () => {
	const fake = createFakePi();
	piSqlite(fake.pi);
	const out = fake.messageRenderers["sqlite-result"]({ details: {} }, { expanded: false, keyHint: () => "" }, plainTheme);
	assert.ok(out === undefined || Array.isArray(out.render(40)));
});

test("fix: row counts in the prompt refresh after writes", async () => {
	const { fake, ctx } = await sqlSession();
	await runTool(fake, ctx, "insert into t values (3),(4),(5)");
	const ev = promptEvent();
	await fake.emit("before_agent_start", ev, ctx);
	assert.match(ev.systemPromptOptions.sections.database_schema, /\(5 rows\)/);
});
