import { resolve } from "node:path";

/** customType of the session entry that remembers which database a SQL-mode session uses. */
export const MODE_ENTRY = "sqlite-mode";

export interface ModeEntryData {
	/** Absolute path to the database file. */
	path: string;
	/** The database was opened read-only (--sqlite-readonly). */
	readOnly?: boolean;
}

export interface ResolvedMode {
	path: string;
	readOnly: boolean;
	fromFlag: boolean;
	/** The latest saved entry already records this path and read-only setting. */
	persisted: boolean;
}

type BranchEntry = { type: string; customType?: string; data?: unknown };

function lastSaved(branch: ReadonlyArray<BranchEntry>): { path: string; readOnly: boolean } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type !== "custom" || e.customType !== MODE_ENTRY) continue;
		const data = e.data as Partial<ModeEntryData> | undefined;
		if (typeof data?.path === "string" && data.path !== "") return { path: data.path, readOnly: data.readOnly === true };
	}
	return undefined;
}

/**
 * Decide which database (if any) this session uses: the --sqlite-mode flag wins, otherwise the
 * latest saved entry on the current branch. --sqlite-readonly always forces read-only; without it,
 * a resumed session keeps its saved setting and an explicit --sqlite-mode opens read-write.
 */
export function resolveDbPath(
	flag: boolean | string | undefined,
	cwd: string,
	branch: ReadonlyArray<BranchEntry>,
	readOnlyFlag?: boolean | string,
): ResolvedMode | undefined {
	const saved = lastSaved(branch);
	// Fail safe: any value other than an explicit false counts as asking for read-only.
	const forceReadOnly = readOnlyFlag !== undefined && readOnlyFlag !== false && readOnlyFlag !== "false";
	const same = (path: string, readOnly: boolean) => saved?.path === path && saved.readOnly === readOnly;
	if (typeof flag === "string" && flag !== "") {
		const path = resolve(cwd, flag);
		return { path, readOnly: forceReadOnly, fromFlag: true, persisted: same(path, forceReadOnly) };
	}
	if (!saved) return undefined;
	const readOnly = forceReadOnly || saved.readOnly;
	return { path: saved.path, readOnly, fromFlag: false, persisted: same(saved.path, readOnly) };
}
