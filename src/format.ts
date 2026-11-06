import { type Cell, type ExecResult, capText } from "./db.ts";

export const MODEL_MAX_ROWS = 50;
export const MODEL_MAX_BYTES = 8192;
const MODEL_MAX_CELL_CHARS = 200;

const n = (v: number) => v.toLocaleString("en-US");

function cellText(cell: Cell): string {
	if (cell === null) return "NULL";
	const s = String(cell).replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
	return capText(s, MODEL_MAX_CELL_CHARS);
}

function footer(total: number, shown: number, capped = false): string {
	const totalText = capped ? `${n(total)}+` : n(total);
	if (shown < total) return `(${totalText} rows total, ${n(shown)} shown — add LIMIT/WHERE to narrow)`;
	return `(${totalText} ${total === 1 ? "row" : "rows"})`;
}

function formatRows(r: ExecResult): string {
	const lines = [r.columns.map((c) => cellText(c)).join(" | ")];
	let used = Buffer.byteLength(lines[0]);
	let shown = 0;
	for (const row of r.rows.slice(0, MODEL_MAX_ROWS)) {
		const line = row.map(cellText).join(" | ");
		const cost = Buffer.byteLength(line) + 1;
		// Reserve room for the worst-case footer.
		if (used + cost + Buffer.byteLength(footer(r.rowCount, shown + 1, r.countCapped)) + 1 > MODEL_MAX_BYTES) break;
		lines.push(line);
		used += cost;
		shown++;
	}
	lines.push(footer(r.rowCount, shown, r.countCapped));
	return lines.join("\n");
}

/** Text the model sees for a query result: compact, capped, and explicit about what was left out. */
export function formatForModel(r: ExecResult): string {
	let text: string;
	switch (r.kind) {
		case "error":
			return `SQLite error: ${r.error ?? "unknown error"}`;
		case "rows":
			return formatRows(r);
		case "changes":
			text = `OK: ${n(r.changes ?? 0)} ${r.changes === 1 ? "row" : "rows"} changed`;
			if (r.lastInsertRowid !== undefined) text += ` (last insert rowid ${r.lastInsertRowid})`;
			break;
		case "script":
			text = `OK: script executed (${r.statements ?? 0} statements)`;
			break;
		default:
			return "SQLite error: unexpected result";
	}
	if (r.schemaChanged && r.ddl.length > 0) text += `\nSchema changed:\n${r.ddl.join("\n")}`;
	return text;
}
