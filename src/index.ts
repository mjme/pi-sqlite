import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type ExecResult, execute, openDatabase } from "./db.ts";
import { formatForModel } from "./format.ts";
import { MODE_ENTRY, type ModeEntryData, resolveDbPath } from "./mode.ts";
import { type SchemaObject, formatSchema, readSchema, tableCount } from "./schema.ts";
import { resultView, themeStyle } from "./table.ts";

const FLAG = "sqlite-mode";
const TOOL = "sqlite";
const STATUS_KEY = "sqlite";
const SCHEMA_SECTION = "database_schema";
const RESULT_MESSAGE = "sqlite-result";
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const NO_DB_MESSAGE = "No SQLite database is open. Start pi with --sqlite-mode <path/to/database.db>.";

interface State {
	db?: DatabaseSync;
	path?: string;
	schema: SchemaObject[];
	persona: string;
	openError?: string;
}

/** Read src/system-prompt.md, dropping the leading HTML comment meant for humans editing the file. */
function readPersona(): string {
	return readFileSync(new URL("./system-prompt.md", import.meta.url), "utf8")
		.replace(/^\s*<!--[\s\S]*?-->\s*/, "")
		.trim();
}

const RESULT_KINDS = new Set(["rows", "changes", "script", "error"]);

/** Pi builds some tool results itself (validation errors, aborts, blocked calls) with `details: {}`. */
function isExecResult(d: unknown): d is ExecResult {
	return typeof d === "object" && d !== null && RESULT_KINDS.has((d as { kind?: unknown }).kind as string);
}

/** Writes can change table row counts, which the schema section shows. */
function changesData(r: ExecResult): boolean {
	return r.schemaChanged || r.kind === "script" || (r.kind === "changes" && (r.changes ?? 0) > 0);
}

/** Small component: one line per entry, truncated to the width (no wrapping). */
function linesView(lines: string[]): Component {
	return {
		render: (width: number) => lines.map((l) => truncateToWidth(l, Math.max(1, width), "…")),
		invalidate() {},
	};
}

export default function piSqlite(pi: ExtensionAPI): void {
	const state: State = { schema: [], persona: "" };

	const statusText = () => {
		const tables = tableCount(state.schema);
		return `sqlite: ${basename(state.path ?? "")} · ${tables} ${tables === 1 ? "table" : "tables"}`;
	};

	const refreshSchema = (ctx: ExtensionContext) => {
		if (!state.db) return;
		state.schema = readSchema(state.db);
		ctx.ui.setStatus(STATUS_KEY, statusText());
	};

	const closeDb = (ctx: ExtensionContext) => {
		const wasOpen = state.db !== undefined || state.path !== undefined;
		try {
			state.db?.close();
		} catch {
			// already closed
		}
		state.db = undefined;
		state.path = undefined;
		state.schema = [];
		state.openError = undefined;
		if (wasOpen) ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const enterMode = (ctx: ExtensionContext) => {
		const resolved = resolveDbPath(pi.getFlag(FLAG), ctx.cwd, ctx.sessionManager.getBranch());
		if (!resolved) {
			closeDb(ctx);
			const active = pi.getActiveTools();
			if (active.includes(TOOL)) {
				const rest = active.filter((t) => t !== TOOL);
				pi.setActiveTools(rest.length > 0 ? rest : DEFAULT_TOOLS);
			}
			return;
		}

		closeDb(ctx);
		state.path = resolved.path;
		state.persona = readPersona();
		try {
			const { db, created } = openDatabase(resolved.path);
			state.db = db;
			state.schema = readSchema(db);
			if (created && ctx.hasUI) ctx.ui.notify(`Created new database ${resolved.path}`, "info");
		} catch (err) {
			try {
				state.db?.close();
			} catch {}
			state.db = undefined;
			state.openError = `Could not open ${resolved.path}: ${err instanceof Error ? err.message : String(err)}`;
			if (ctx.hasUI) ctx.ui.notify(state.openError, "error");
			else console.error(`pi-sqlite: ${state.openError}`);
		}
		if (!resolved.persisted) pi.appendEntry<ModeEntryData>(MODE_ENTRY, { path: resolved.path });
		pi.setActiveTools([TOOL]);
		ctx.ui.setStatus(STATUS_KEY, state.db ? statusText() : `sqlite: ${basename(resolved.path)} · not open`);
	};

	pi.registerFlag(FLAG, {
		type: "string",
		description: "Open a SQLite database and run Pi as a SQL-only agent",
	});

	pi.on("session_start", (_event, ctx) => enterMode(ctx));
	pi.on("session_tree", (_event, ctx) => enterMode(ctx));
	pi.on("session_shutdown", (_event, ctx) => closeDb(ctx));

	pi.on("before_agent_start", (event) => {
		if (!state.path) return;
		const o = event.systemPromptOptions;
		const prev = o.customPrompt;
		if (!prev?.startsWith(state.persona)) o.customPrompt = prev ? `${state.persona}\n\n${prev}` : state.persona;
		o.sections[SCHEMA_SECTION] = state.db
			? formatSchema(state.path, state.schema)
			: `Database: ${state.path}\n${state.openError ?? NO_DB_MESSAGE}`;
		o.selectedTools = [TOOL];
	});

	pi.registerCommand("sql", {
		description: "Run SQL directly against the open database (result is shared with the model)",
		handler: async (args, ctx) => {
			const sql = args.trim();
			if (!state.db) {
				ctx.ui.notify(state.openError ?? NO_DB_MESSAGE, "warning");
				return;
			}
			if (!sql) {
				ctx.ui.notify("Usage: /sql <statement>", "info");
				return;
			}
			const r = execute(state.db, sql);
			if (changesData(r)) refreshSchema(ctx);
			// triggerTurn: false appends now when idle, or at the end of the current turn when busy.
			pi.sendMessage<ExecResult>(
				{ customType: RESULT_MESSAGE, content: formatForModel(r), display: true, details: r },
				{ triggerTurn: false },
			);
		},
	});

	pi.registerMessageRenderer<ExecResult>(RESULT_MESSAGE, (message, options, theme) => {
		if (!isExecResult(message.details)) return undefined;
		const sql = message.details.sql.trim().split("\n")[0];
		const header = linesView([theme.fg("toolTitle", theme.bold("/sql ")) + theme.fg("muted", sql)]);
		const table = resultView(message.details, {
			expanded: options.expanded,
			style: themeStyle(theme),
			expandHint: options.keyHint("app.tools.expand", "to expand"),
		});
		return {
			render: (width: number) => [...header.render(width), ...table.render(width)],
			invalidate() {
				table.invalidate();
			},
		};
	});

	const SqliteParams = Type.Object({
		sql: Type.String({ description: "One SQLite statement (or a script of several for DDL/batch writes)" }),
	});

	pi.registerTool<typeof SqliteParams, ExecResult>({
		name: TOOL,
		label: "SQLite",
		description:
			"Run SQL against the open SQLite database. Returns rows for queries, or the number of changed rows for writes. " +
			"Send one statement when you need rows back; several statements separated by ';' run as a script and return no rows.",
		promptSnippet: "Run SQL against the open SQLite database",
		promptGuidelines: [
			"Use sqlite for every question about the data; check the database schema before writing a query.",
			"Use sqlite with a LIMIT when exploring large tables.",
		],
		parameters: SqliteParams,
		defaultActive: false,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.db) {
				const text = state.openError ? `${state.openError}\n${NO_DB_MESSAGE}` : NO_DB_MESSAGE;
				const details: ExecResult = {
					sql: params.sql,
					kind: "error",
					columns: [],
					rows: [],
					rowCount: 0,
					truncated: false,
					schemaChanged: false,
					ddl: [],
					durationMs: 0,
					error: text,
				};
				return { content: [{ type: "text", text }], details, isError: true };
			}
			const r = execute(state.db, params.sql);
			if (changesData(r)) refreshSchema(ctx);
			return {
				content: [{ type: "text", text: formatForModel(r) }],
				details: r,
				...(r.kind === "error" ? { isError: true } : {}),
			};
		},

		renderCall(args, theme, context) {
			const sql = String(args?.sql ?? "").trim();
			const title = theme.fg("toolTitle", theme.bold("sqlite "));
			if (context.expanded) {
				return {
					render: (width: number) =>
						[title, ...sql.split("\n").map((l) => `  ${theme.fg("muted", l)}`)].flatMap((l) =>
							wrapTextWithAnsi(l, Math.max(1, width)),
						),
					invalidate() {},
				};
			}
			const lines = sql.split("\n");
			const first = lines[0] + (lines.length > 1 ? " …" : "");
			return linesView([title + theme.fg("muted", first)]);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return linesView([theme.fg("warning", "Running…")]);
			if (!isExecResult(result.details)) {
				const text = result.content
					.map((c) => (c.type === "text" ? c.text : ""))
					.join("\n")
					.trim();
				const color = context.isError || (result as { isError?: boolean }).isError ? "error" : "toolOutput";
				return {
					render: (width: number) =>
						text
							.split("\n")
							.flatMap((l) => wrapTextWithAnsi(l, Math.max(1, width)))
							.map((l) => truncateToWidth(theme.fg(color, l), Math.max(1, width), "…")),
					invalidate() {},
				};
			}
			return resultView(result.details, {
				expanded,
				style: themeStyle(theme),
				expandHint: context.keyHint("app.tools.expand", "to expand"),
			});
		},
	});
}
