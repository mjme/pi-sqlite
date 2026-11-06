import { resolve } from "node:path";

/** customType of the session entry that remembers which database a SQL-mode session uses. */
export const MODE_ENTRY = "sqlite-mode";

export interface ModeEntryData {
	/** Absolute path to the database file. */
	path: string;
}

type BranchEntry = { type: string; customType?: string; data?: unknown };

function lastSavedPath(branch: ReadonlyArray<BranchEntry>): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type !== "custom" || e.customType !== MODE_ENTRY) continue;
		const path = (e.data as Partial<ModeEntryData> | undefined)?.path;
		if (typeof path === "string" && path !== "") return path;
	}
	return undefined;
}

/**
 * Decide which database (if any) this session uses: the --sqlite-mode flag wins, otherwise the
 * latest saved entry on the current branch. `persisted` says whether that path is already saved.
 */
export function resolveDbPath(
	flag: boolean | string | undefined,
	cwd: string,
	branch: ReadonlyArray<BranchEntry>,
): { path: string; fromFlag: boolean; persisted: boolean } | undefined {
	const saved = lastSavedPath(branch);
	if (typeof flag === "string" && flag !== "") {
		const path = resolve(cwd, flag);
		return { path, fromFlag: true, persisted: saved === path };
	}
	return saved ? { path: saved, fromFlag: false, persisted: true } : undefined;
}
