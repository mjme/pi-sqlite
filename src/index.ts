import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type ClientOptions, type SqliteClient, openClient } from "./client.ts";
import type { ExecResult } from "./db.ts";
import { formatForModel } from "./format.ts";
import { MODE_ENTRY, type ModeEntryData, resolveDbPath } from "./mode.ts";
import { type SchemaObject, formatSchema, schemaHeader, tableCount } from "./schema.ts";
import { resultView, sanitizeForTerminal, sanitizeLines, themeStyle } from "./table.ts";

const FLAG = "sqlite-mode";
const READONLY_FLAG = "sqlite-readonly";
const TOOL = "sqlite";
const STATUS_KEY = "sqlite";
const SCHEMA_SECTION = "database_schema";
const RESULT_MESSAGE = "sqlite-result";
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const NO_DB_MESSAGE = "No SQLite database is open. Start pi with --sqlite-mode <path/to/database.db>.";
const ONLY_SQLITE = "Only the sqlite tool is available in SQL mode.";

interface State {
	client?: SqliteClient;
	path?: string;
	readOnly: boolean;
	schema: SchemaObject[];
	persona: string;
	openError?: string;
	/** Bumped on every open/close so a slow open from an earlier session can't install itself. */
	generation: number;
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

/** The extension factory. `options` exists for tests (e.g. a short query timeout). */
export default function piSqlite(pi: ExtensionAPI, options: ClientOptions = {}): void {
	const state: State = { schema: [], persona: "", readOnly: false, generation: 0 };

	const dbLabel = () => sanitizeForTerminal(basename(state.path ?? "")) + (state.readOnly ? " (read-only)" : "");

	const statusText = () => {
		const tables = tableCount(state.schema);
		return `sqlite: ${dbLabel()} · ${tables} ${tables === 1 ? "table" : "tables"}`;
	};

	const refreshSchema = async (ctx: ExtensionContext) => {
		const client = state.client;
		if (!client) return;
		try {
			const schema = await client.schema();
			if (state.client !== client) return;
			state.schema = schema;
		} catch {
			// e.g. the schema read timed out: keep the previous schema
		}
		ctx.ui.setStatus(STATUS_KEY, statusText());
	};

	const closeDb = (ctx: ExtensionContext) => {
		const wasOpen = state.client !== undefined || state.path !== undefined;
		state.generation++;
		state.client?.close();
		state.client = undefined;
		state.path = undefined;
		state.readOnly = false;
		state.schema = [];
		state.openError = undefined;
		if (wasOpen) ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const enterMode = async (ctx: ExtensionContext) => {
		const resolved = resolveDbPath(pi.getFlag(FLAG), ctx.cwd, ctx.sessionManager.getBranch(), pi.getFlag(READONLY_FLAG));
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
		const generation = state.generation;
		state.path = resolved.path;
		state.readOnly = resolved.readOnly;
		state.persona = readPersona();
		// Lock the tools down before anything slow happens.
		if (!resolved.persisted) {
			pi.appendEntry<ModeEntryData>(MODE_ENTRY, { path: resolved.path, ...(resolved.readOnly ? { readOnly: true } : {}) });
		}
		pi.setActiveTools([TOOL]);
		const warn = (message: string, type: "info" | "warning" | "error") => {
			if (ctx.hasUI) ctx.ui.notify(message, type);
			else if (type !== "info") console.error(`pi-sqlite: ${message}`);
		};
		try {
			const opened = await openClient({ path: resolved.path, readOnly: resolved.readOnly }, options);
			if (state.generation !== generation) {
				opened.client.close();
				return;
			}
			state.client = opened.client;
			state.schema = await opened.client.schema();
			if (opened.created) warn(`Created new database ${resolved.path}`, "info");
			if (opened.fallbackReason) {
				warn(`pi-sqlite: running queries inside Pi (${opened.fallbackReason}); long queries can't be cancelled.`, "warning");
			}
		} catch (err) {
			if (state.generation !== generation) return;
			state.client?.close();
			state.client = undefined;
			state.openError = `Could not open ${resolved.path}: ${err instanceof Error ? err.message : String(err)}`;
			warn(state.openError, "error");
		}
		ctx.ui.setStatus(STATUS_KEY, state.client ? statusText() : `sqlite: ${dbLabel()} · not open`);
	};

	pi.registerFlag(FLAG, {
		type: "string",
		description: "Open a SQLite database and run Pi as a SQL-only agent",
	});
	pi.registerFlag(READONLY_FLAG, {
		type: "boolean",
		description: "With --sqlite-mode: open the database read-only so the agent can't change it",
	});

	pi.on("session_start", (_event, ctx) => enterMode(ctx));
	pi.on("session_tree", (_event, ctx) => enterMode(ctx));
	pi.on("session_shutdown", (_event, ctx) => closeDb(ctx));

	// Pi activates tools that register late (e.g. MCP servers that finish connecting mid-run).
	// before_agent_start resets the tool list each prompt; this blocks anything else in between.
	pi.on("tool_call", (event) => (state.path && event.toolName !== TOOL ? { block: true, reason: ONLY_SQLITE } : undefined));

	pi.on("before_agent_start", (event) => {
		if (!state.path) return;
		const o = event.systemPromptOptions;
		const prev = o.customPrompt;
		if (!prev?.startsWith(state.persona)) o.customPrompt = prev ? `${state.persona}\n\n${prev}` : state.persona;
		o.sections[SCHEMA_SECTION] = state.client
			? formatSchema(state.path, state.schema, { readOnly: state.readOnly })
			: `${schemaHeader(state.path, state.readOnly)}\n${state.openError ?? NO_DB_MESSAGE}`;
		o.selectedTools = [TOOL];
	});

	pi.registerCommand("sql", {
		description: "Run SQL directly against the open database (result is shared with the model)",
		handler: async (args, ctx) => {
			const sql = args.trim();
			const client = state.client;
			if (!client) {
				ctx.ui.notify(state.openError ?? NO_DB_MESSAGE, "warning");
				return;
			}
			if (!sql) {
				ctx.ui.notify("Usage: /sql <statement>", "info");
				return;
			}
			const r = await client.exec(sql);
			if (changesData(r)) await refreshSchema(ctx);
			// triggerTurn: false appends now when idle, or at the end of the current turn when busy.
			pi.sendMessage<ExecResult>(
				{ customType: RESULT_MESSAGE, content: formatForModel(r), display: true, details: r },
				{ triggerTurn: false },
			);
		},
	});

	pi.registerMessageRenderer<ExecResult>(RESULT_MESSAGE, (message, options, theme) => {
		if (!isExecResult(message.details)) return undefined;
		const sql = sanitizeForTerminal(message.details.sql.trim().split("\n")[0]);
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

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const client = state.client;
			if (!client) {
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
			const r = await client.exec(params.sql, signal);
			if (changesData(r)) await refreshSchema(ctx);
			return {
				content: [{ type: "text", text: formatForModel(r) }],
				details: r,
				...(r.kind === "error" ? { isError: true } : {}),
			};
		},

		renderCall(args, theme, context) {
			// The SQL comes from the model, which may have copied it from untrusted data.
			const lines = sanitizeLines(String(args?.sql ?? "").trim());
			const title = theme.fg("toolTitle", theme.bold("sqlite "));
			if (context.expanded) {
				return {
					render: (width: number) =>
						[title, ...lines.map((l) => `  ${theme.fg("muted", l)}`)].flatMap((l) => wrapTextWithAnsi(l, Math.max(1, width))),
					invalidate() {},
				};
			}
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
						sanitizeLines(text)
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
