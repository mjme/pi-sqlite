import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Cell, ExecResult } from "./db.ts";

export const COLLAPSED_ROWS = 10;
const MAX_COLUMN_WIDTH = 40;
const MIN_COLUMN_WIDTH = 3;
const SEPARATOR = " │ ";

export interface TableStyle {
	header(s: string): string;
	border(s: string): string;
	dim(s: string): string;
	error(s: string): string;
	success(s: string): string;
}

const identity = (s: string) => s;
export const plainStyle: TableStyle = { header: identity, border: identity, dim: identity, error: identity, success: identity };

export function themeStyle(theme: Theme): TableStyle {
	return {
		header: (s) => theme.bold(theme.fg("accent", s)),
		border: (s) => theme.fg("dim", s),
		dim: (s) => theme.fg("dim", s),
		error: (s) => theme.fg("error", s),
		success: (s) => theme.fg("success", s),
	};
}

export interface ResultViewOptions {
	expanded: boolean;
	style: TableStyle;
	expandHint?: string;
}

const n = (v: number) => v.toLocaleString("en-US");
const rowsWord = (v: number) => `${n(v)} ${v === 1 ? "row" : "rows"}`;

function cellText(cell: Cell): string {
	if (cell === null) return "NULL";
	return String(cell)
		.replace(/\r?\n/g, "⏎")
		.replace(/\t/g, " ")
		.replace(/[\x00-\x1f\x7f]/g, "�");
}

function columnWidths(header: string[], body: string[][], width: number): number[] {
	const widths = header.map((h, i) =>
		Math.max(1, Math.min(MAX_COLUMN_WIDTH, Math.max(visibleWidth(h), ...body.map((row) => visibleWidth(row[i] ?? ""))))),
	);
	const total = () => widths.reduce((a, b) => a + b, 0) + SEPARATOR.length * (widths.length - 1);
	while (total() > width) {
		let widest = -1;
		for (let i = 0; i < widths.length; i++) {
			if (widths[i] > MIN_COLUMN_WIDTH && (widest < 0 || widths[i] > widths[widest])) widest = i;
		}
		if (widest < 0) break;
		widths[widest]--;
	}
	return widths;
}

function fit(text: string, w: number, rightAlign: boolean): string {
	const vw = visibleWidth(text);
	if (vw > w) return truncateToWidth(text, w, "…", true);
	return rightAlign ? " ".repeat(w - vw) + text : text + " ".repeat(w - vw);
}

const fitLine = (l: string, width: number) => (visibleWidth(l) > width ? truncateToWidth(l, width, "…") : l);

function rowsLines(r: ExecResult, width: number, o: ResultViewOptions): string[] {
	const { style } = o;
	const visible = o.expanded ? r.rows : r.rows.slice(0, COLLAPSED_ROWS);
	const body = visible.map((row) => row.map(cellText));
	const widths = columnWidths(r.columns, body, width);
	const sep = style.border(SEPARATOR);
	const lines: string[] = [];
	lines.push(r.columns.map((c, i) => style.header(fit(cellText(c), widths[i], false))).join(sep));
	lines.push(style.border(widths.map((w) => "─".repeat(w)).join("─┼─")));
	visible.forEach((row, ri) => {
		lines.push(
			row
				.map((cell, i) => {
					const text = fit(body[ri][i], widths[i], typeof cell === "number");
					return cell === null ? style.dim(text) : text;
				})
				.join(sep),
		);
	});

	const parts: string[] = [];
	if (visible.length < r.rowCount && !(o.expanded && r.truncated)) {
		parts.push(`… ${rowsWord(r.rowCount - visible.length).replace(/^(\S+)/, "$1 more")}`);
		parts.push(`${n(r.rowCount)}${r.countCapped ? "+" : ""} total`);
	} else if (r.truncated) {
		parts.push(`${n(r.rows.length)} of ${n(r.rowCount)}${r.countCapped ? "+" : ""} rows shown`);
	} else {
		parts.push(rowsWord(r.rowCount));
	}
	parts.push(`${r.durationMs}ms`);
	if (!o.expanded && visible.length < r.rows.length && o.expandHint) parts.push(o.expandHint);
	lines.push(style.dim(parts.join(" · ")));
	return lines.map((l) => fitLine(l, width));
}

export function renderResultLines(r: ExecResult, width: number, o: ResultViewOptions): string[] {
	const { style } = o;
	switch (r.kind) {
		case "rows":
			return rowsLines(r, width, o);
		case "changes": {
			const id = r.lastInsertRowid !== undefined && r.lastInsertRowid !== 0 ? ` · last id ${r.lastInsertRowid}` : "";
			const lines = [style.success(`✓ ${n(r.changes ?? 0)} ${r.changes === 1 ? "row" : "rows"} changed${id}`)];
			if (r.schemaChanged) lines.push(style.dim("schema updated"));
			return lines.map((l) => fitLine(l, width));
		}
		case "script":
			return [style.success(`✓ script executed (${r.statements ?? 0} statements)`), ...(r.schemaChanged ? [style.dim("schema updated")] : [])].map((l) => fitLine(l, width));
		case "error":
			return wrapTextWithAnsi(`✗ ${r.error ?? "unknown error"}`, Math.max(1, width)).map((l) => fitLine(style.error(l), width));
		default:
			return [];
	}
}

export function resultView(r: ExecResult, o: ResultViewOptions): Component {
	let cache: { width: number; lines: string[] } | undefined;
	return {
		render(width: number): string[] {
			if (!cache || cache.width !== width) cache = { width, lines: renderResultLines(r, width, o) };
			return cache.lines;
		},
		invalidate() {
			cache = undefined;
		},
	};
}
