/**
 * Tests for shell rule discovery.
 *
 * Unit tests run against in-memory fake `DiscoveryDeps` (a content/mtime
 * store plus a call log) so ordering, trust gating, cache reuse, and
 * vanished-file behavior are observable without any real I/O. One
 * integration test exercises the real production adapters
 * (`tinyglobbyScanner`, `nodeDiscoveryDeps().listRuleFiles`) against a
 * `mkdtemp` directory under `os.tmpdir()`, cleaned up in `afterAll`.
 *
 * Fixtures return listings in reverse insertion order on purpose: discover
 * must sort deterministically, so unsorted deps input must not leak through.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, MAX_NESTED_RULES_DIR_DEPTH, nestedProjectRuleDirs, nodeDiscoveryDeps, projectRuleDirs, tinyglobbyScanner } from "./discovery.ts";
import type { DiscoveryDeps, DiscoveryOptions } from "./discovery.ts";
import { COPILOT_IMPORTER } from "./importers/copilot.ts";
import type { Importer } from "./importers/seam.ts";
import { normalizedPath } from "../src/types.ts";

const GLOBAL_DIR = "/home/u/.pi/agent/rules";
const PROJECT_DIR = "/work/.pi/rules";

/** Valid minimal rule file: required metadata plus one activation condition. */
const ruleText = (description: string): string =>
	`---\ndescription: ${description}\nversion: 1\nalwaysApply: true\n---\nBody.\n`;

/** Text guaranteed to fail parsing (no frontmatter block at byte 0). */
const brokenText = "no frontmatter block here\n";

/**
 * ENOENT-shaped cause, mirroring real node:fs errors (which carry `code`).
 * Plain errors model genuine failures (permissions, wrong type), not absence.
 */
const enoent = (path: string): Error => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });

interface FakeFile {
	content: string;
	mtimeMs: number;
}

const file = (content: string, mtimeMs = 1): FakeFile => ({ content, mtimeMs });

const seed = (entries: ReadonlyArray<readonly [string, FakeFile]>): Map<string, FakeFile> => new Map(entries);

/**
 * In-memory DiscoveryDeps: files keyed by absolute path, listing returns
 * relative names (reversed to prove discover sorts), and every list/stat/
 * read call is recorded for trust-gate and cache-reuse assertions.
 */
const fakeDeps = (files: Map<string, FakeFile>, nestedDirs: readonly string[] = []) => {
	const callLog = { listed: [] as string[], stat: [] as string[], read: [] as string[], nested: [] as string[] };
	const deps: DiscoveryDeps = {
		listRuleFiles: async (dir) => {
			callLog.listed.push(dir);
			const names: string[] = [];
			for (const abs of files.keys()) {
				if (abs.startsWith(`${dir}/`)) {
					names.push(abs.slice(dir.length + 1));
				}
			}
			return names.reverse();
		},
		listNestedRuleDirs: async (cwd) => {
			callLog.nested.push(cwd);
			return nestedDirs;
		},
		stat: async (path) => {
			callLog.stat.push(path);
			const stored = files.get(path);
			if (stored === undefined) {
				throw enoent(path);
			}
			return { mtimeMs: stored.mtimeMs };
		},
		readFile: async (path) => {
			callLog.read.push(path);
			const stored = files.get(path);
			if (stored === undefined) {
				throw enoent(path);
			}
			return stored.content;
		},
	};
	return { deps, callLog };
};

/**
 * Single-directory options (cwd == the project rules base): the shape every
 * pre-monorepo test used, now expressed as the one-element walk-up list.
 */
const opts = (isProjectTrusted: boolean): DiscoveryOptions => ({
	globalDir: GLOBAL_DIR,
	projectDirs: [{ dir: PROJECT_DIR, base: "/work" }],
	cwd: "/work",
	isProjectTrusted,
});

/** Options for a global-only pass (adapters/production tests): no project dirs. */
const globalOnly = (globalDir: string): DiscoveryOptions => ({
	globalDir,
	projectDirs: [],
	cwd: normalizedPath(globalDir),
	isProjectTrusted: false,
});

describe("discover — listing and parsing", () => {
	it("discovers recursive .md rules from project and global directories", async () => {
		const { deps } = fakeDeps(
			seed([
				[`${PROJECT_DIR}/a.md`, file(ruleText("Project A"))],
				[`${PROJECT_DIR}/sub/nested.md`, file(ruleText("Nested"))],
				[`${GLOBAL_DIR}/g.md`, file(ruleText("Global G"))],
			]),
		);
		const result = await discover(deps, new Map(), opts(true));
		expect(result.rules.map((rule) => rule.id)).toEqual(["a", "nested", "g"]);
		expect(result.rules.map((rule) => rule.path)).toEqual([
			normalizedPath(`${PROJECT_DIR}/a.md`),
			normalizedPath(`${PROJECT_DIR}/sub/nested.md`),
			normalizedPath(`${GLOBAL_DIR}/g.md`),
		]);
		expect(result.rules.map((rule) => rule.source)).toEqual(["project", "project", "global"]);
		expect(result.errors).toEqual([]);
	});

	it("ignores non-.md listings entirely: no rule, no read, no cache entry", async () => {
		const { deps, callLog } = fakeDeps(
			seed([
				[`${PROJECT_DIR}/a.md`, file(ruleText("A"))],
				[`${PROJECT_DIR}/notes.txt`, file(ruleText("Not a rule"))],
			]),
		);
		const result = await discover(deps, new Map(), opts(true));
		expect(result.rules.map((rule) => rule.id)).toEqual(["a"]);
		expect(result.errors).toEqual([]);
		expect(callLog.read).toEqual([`${PROJECT_DIR}/a.md`]);
		expect(result.cache.has(normalizedPath(`${PROJECT_DIR}/notes.txt`))).toBe(false);
	});

	it("orders project rules before global and sorts within each source", async () => {
		const { deps } = fakeDeps(
			seed([
				[`${PROJECT_DIR}/b.md`, file(ruleText("B"))],
				[`${PROJECT_DIR}/a.md`, file(ruleText("A"))],
				[`${GLOBAL_DIR}/z.md`, file(ruleText("Z"))],
				[`${GLOBAL_DIR}/sub/a.md`, file(ruleText("Global sub A"))],
			]),
		);
		const result = await discover(deps, new Map(), opts(true));
		expect(result.rules.map((rule) => `${rule.source}:${rule.id}`)).toEqual([
			"project:a",
			"project:b",
			// Merged-pass id uniqueness: project:a owns the bare stem, so the
			// colliding global stem suffixes even though ordering is unchanged.
			"global:a-2",
			"global:z",
		]);
	});
});

describe("discover — unique ids per pass", () => {
	it("suffixes same-stem files within a source: first sorted keeps the stem, later get -2", async () => {
		const { deps } = fakeDeps(
			seed([
				[`${PROJECT_DIR}/sub/a.md`, file(ruleText("Sub A"))],
				[`${PROJECT_DIR}/a.md`, file(ruleText("Root A"))],
			]),
		);
		const result = await discover(deps, new Map(), opts(true));
		expect(result.rules.map((rule) => rule.id)).toEqual(["a", "a-2"]);
	});

	it("suffixes a three-way stem collision deterministically (-2, -3) in sorted-path order", async () => {
		const { deps } = fakeDeps(
			seed([
				[`${PROJECT_DIR}/c/a.md`, file(ruleText("C"))],
				[`${PROJECT_DIR}/a.md`, file(ruleText("Root"))],
				[`${PROJECT_DIR}/b/a.md`, file(ruleText("B"))],
			]),
		);
		const result = await discover(deps, new Map(), opts(true));
		expect(result.rules.map((rule) => rule.id)).toEqual(["a", "a-2", "a-3"]);
	});

	it("resolves cross-source stem collisions globally: project keeps the bare stem, global suffixes", async () => {
		// Ids are unique across the merged pass, in pass order (project first,
		// then global): on a cross-source collision the project rule keeps the
		// bare stem and the later-source rule gets the -2 suffix.
		const { deps } = fakeDeps(
			seed([
				[`${PROJECT_DIR}/a.md`, file(ruleText("Project A"))],
				[`${GLOBAL_DIR}/deep/a.md`, file(ruleText("Global A"))],
			]),
		);
		const result = await discover(deps, new Map(), opts(true));
		expect(result.rules.map((rule) => `${rule.source}:${rule.id}`)).toEqual(["project:a", "global:a-2"]);
	});

	it("resolves a three-way cross-source collision as a, a-2, a-3 in pass order", async () => {
		const { deps } = fakeDeps(
			seed([
				[`${PROJECT_DIR}/a.md`, file(ruleText("Project A"))],
				[`${PROJECT_DIR}/sub/a.md`, file(ruleText("Project Sub A"))],
				[`${GLOBAL_DIR}/a.md`, file(ruleText("Global A"))],
			]),
		);
		const result = await discover(deps, new Map(), opts(true));
		expect(result.rules.map((rule) => `${rule.source}:${rule.id}`)).toEqual([
			"project:a",
			"project:a-2",
			"global:a-3",
		]);
	});

	it("never produces a suffixed id that collides with another file's bare stem", async () => {
		// Sorted paths: a-2.md < a.md < sub/a.md. The bare "a-2" is taken, so
		// the colliding "a" stem must skip to "a-3" instead of duplicating it.
		const { deps } = fakeDeps(
			seed([
				[`${PROJECT_DIR}/a-2.md`, file(ruleText("A two"))],
				[`${PROJECT_DIR}/a.md`, file(ruleText("A"))],
				[`${PROJECT_DIR}/sub/a.md`, file(ruleText("Sub A"))],
			]),
		);
		const result = await discover(deps, new Map(), opts(true));
		expect(result.rules.map((rule) => rule.id)).toEqual(["a-2", "a", "a-3"]);
	});

	it("refreshes a cached rule's id when a later pass makes it collide", async () => {
		const store = seed([[`${PROJECT_DIR}/sub/a.md`, file(ruleText("Sub A"))]]);
		const { deps } = fakeDeps(store);
		const first = await discover(deps, new Map(), opts(true));
		expect(first.rules.map((rule) => rule.id)).toEqual(["a"]);

		store.set(`${PROJECT_DIR}/a.md`, file(ruleText("Root A"), 1));
		const second = await discover(deps, first.cache, opts(true));
		expect(second.rules.map((rule) => [rule.id, rule.description])).toEqual([
			["a", "Root A"],
			["a-2", "Sub A"],
		]);
		// The unchanged first-sorted file keeps its cache entry object; only
		// the id-changing rule gets a fresh entry.
		expect(second.cache.get(normalizedPath(`${PROJECT_DIR}/a.md`))).toBeDefined();
	});
});

describe("discover — trust gate", () => {
	it("never lists or reads the project directory when untrusted, global still works", async () => {
		const { deps, callLog } = fakeDeps(
			seed([
				[`${PROJECT_DIR}/a.md`, file(ruleText("Project A"))],
				[`${GLOBAL_DIR}/g.md`, file(ruleText("Global G"))],
			]),
		);
		const result = await discover(deps, new Map(), opts(false));
		expect(callLog.listed).toEqual([GLOBAL_DIR]);
		expect(callLog.read).toEqual([`${GLOBAL_DIR}/g.md`]);
		expect(result.rules.map((rule) => rule.id)).toEqual(["g"]);
	});
});

describe("discover — missing directories", () => {
	it("treats a missing directory as an empty contribution, not an error", async () => {
		const { deps } = fakeDeps(new Map());
		const result = await discover(deps, new Map(), opts(true));
		expect(result.rules).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(result.cache.size).toBe(0);
	});
});

describe("discover — source and read failures", () => {
	it("collects source-unreadable for a rejected listRuleFiles; the other source continues", async () => {
		const deps: DiscoveryDeps = {
			listNestedRuleDirs: async () => [],
			listRuleFiles: async (dir) => {
				if (dir === PROJECT_DIR) {
					throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
				}
				return ["g.md"];
			},
			stat: async () => ({ mtimeMs: 1 }),
			readFile: async () => ruleText("Global G"),
		};
		const result = await discover(deps, new Map(), opts(true));

		expect(result.rules.map((rule) => rule.id)).toEqual(["g"]);
		expect(result.errors).toEqual([
			{ code: "source-unreadable", message: expect.stringContaining("EACCES"), file: PROJECT_DIR },
		]);
		// The unreadable source contributed no FILE cache entry — only the
		// directory-level outcome S13 caches (see the unreadable-source suite).
		expect([...result.cache.keys()]).toEqual([
			normalizedPath(PROJECT_DIR),
			normalizedPath(`${GLOBAL_DIR}/g.md`),
		]);
		expect(result.cache.get(normalizedPath(`${PROJECT_DIR}/a.md`))).toBeUndefined();
	});

	it("collects read-failure for a non-ENOENT read rejection and caches it by mtime", async () => {
		const store = seed([[`${PROJECT_DIR}/locked.md`, file(ruleText("Locked"))]]);
		const { deps, callLog } = fakeDeps(store);
		const failing: DiscoveryDeps = {
			...deps,
			readFile: async (path) => {
				callLog.read.push(path);
				throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
			},
		};
		const first = await discover(failing, new Map(), opts(true));
		expect(first.rules).toEqual([]);
		expect(first.errors).toEqual([
			{ code: "read-failure", message: expect.stringContaining("EACCES"), file: `${PROJECT_DIR}/locked.md` },
		]);
		const entry = first.cache.get(normalizedPath(`${PROJECT_DIR}/locked.md`));
		expect(entry?.error?.code).toBe("read-failure");

		// Cached like a parse error: an unchanged mtime reuses the error, no re-read.
		const second = await discover(failing, first.cache, opts(true));
		expect(callLog.read.filter((path) => path.endsWith("locked.md"))).toHaveLength(1);
		expect(second.errors).toEqual(first.errors);
	});
});

/**
 * Mutable fake for the unreadable-source cache (S13): which directories reject
 * `listRuleFiles`, and each directory's own mtime, can be changed BETWEEN
 * passes — that is what makes recovery observable. Every listing attempt is
 * recorded per directory so "listed once" is a count, not an inference.
 */
interface SourceFailureState {
	readonly files: Map<string, FakeFile>;
	readonly failing: Set<string>;
	readonly dirMtimes: Map<string, number>;
	readonly listed: string[];
	readonly read: string[];
}

/** `stat` on a directory answers only when {@link SourceFailureState.dirMtimes} has it. */
const sourceFailureDeps = (state: SourceFailureState): DiscoveryDeps => ({
	listNestedRuleDirs: async () => [],
	listRuleFiles: async (dir) => {
		state.listed.push(dir);
		if (state.failing.has(dir)) {
			throw Object.assign(new Error(`EACCES: permission denied, scandir '${dir}'`), { code: "EACCES" });
		}
		const names: string[] = [];
		for (const abs of state.files.keys()) {
			if (abs.startsWith(`${dir}/`)) {
				names.push(abs.slice(dir.length + 1));
			}
		}
		return names.reverse();
	},
	stat: async (path) => {
		const dirMtime = state.dirMtimes.get(path);
		if (dirMtime !== undefined) {
			return { mtimeMs: dirMtime };
		}
		const stored = state.files.get(path);
		if (stored === undefined) {
			throw enoent(path);
		}
		return { mtimeMs: stored.mtimeMs };
	},
	readFile: async (path) => {
		state.read.push(path);
		const stored = state.files.get(path);
		if (stored === undefined) {
			throw enoent(path);
		}
		return stored.content;
	},
});

const sourceFailureState = (): SourceFailureState => ({
	files: seed([[`${GLOBAL_DIR}/g.md`, file(ruleText("Global G"))]]),
	failing: new Set([PROJECT_DIR]),
	dirMtimes: new Map(),
	listed: [],
	read: [],
});

describe("discover — unreadable-source cache (S13)", () => {
	it("reports the cached source-unreadable error without re-listing the directory", async () => {
		const state = sourceFailureState();
		const deps = sourceFailureDeps(state);

		const first = await discover(deps, new Map(), opts(true));
		expect(state.listed).toEqual([PROJECT_DIR, GLOBAL_DIR]);
		expect(first.errors).toEqual([
			{ code: "source-unreadable", message: expect.stringContaining("EACCES"), file: PROJECT_DIR },
		]);
		expect(first.rules.map((rule) => rule.id)).toEqual(["g"]);
		// The cached outcome is a DIRECTORY entry: the error, no rule, no file error.
		const cachedSource = first.cache.get(normalizedPath(PROJECT_DIR));
		expect(cachedSource?.sourceUnreadable?.code).toBe("source-unreadable");
		expect(cachedSource?.rule).toBeUndefined();
		expect(cachedSource?.error).toBeUndefined();

		// Second pass: the unreadable source is NOT listed again, the identical
		// error is reported from cache (so /rules output is unchanged), and the
		// readable sources behave exactly as before.
		const second = await discover(deps, first.cache, opts(true));
		expect(state.listed.filter((dir) => dir === PROJECT_DIR)).toHaveLength(1);
		expect(state.listed.filter((dir) => dir === GLOBAL_DIR)).toHaveLength(2);
		expect(second.errors).toHaveLength(1);
		expect(second.errors[0]).toBe(first.errors[0]);
		expect(second.rules).toEqual(first.rules);
		// File-level mtime caching is untouched by the source entry: one read total.
		expect(state.read).toEqual([`${GLOBAL_DIR}/g.md`]);
		// `/rules` renders one `parse error: <file> (<code>): <message>` line per
		// embedded error, so identical error arrays mean an identical report line:
		// the cache changes repetition COST, never the output.
		const reportLine = (error: { readonly code: string; readonly message: string; readonly file?: string }): string =>
			`parse error: ${error.file ?? "unknown file"} (${error.code}): ${error.message}`;
		expect(second.errors.map(reportLine)).toEqual(first.errors.map(reportLine));
	});

	it("re-attempts the source when the directory mtime changes and yields its rules", async () => {
		const state = sourceFailureState();
		state.dirMtimes.set(PROJECT_DIR, 1);
		const deps = sourceFailureDeps(state);

		const first = await discover(deps, new Map(), opts(true));
		expect(first.errors).toHaveLength(1);
		expect(state.listed.filter((dir) => dir === PROJECT_DIR)).toHaveLength(1);

		// The directory becomes readable AND its mtime changed: the stale check
		// re-lists it and its rules join the pass.
		state.failing.delete(PROJECT_DIR);
		state.files.set(`${PROJECT_DIR}/a.md`, file(ruleText("Project A"), 3));
		state.dirMtimes.set(PROJECT_DIR, 2);
		const second = await discover(deps, first.cache, opts(true));
		expect(state.listed.filter((dir) => dir === PROJECT_DIR)).toHaveLength(2);
		expect(second.errors).toEqual([]);
		expect(second.rules.map((rule) => rule.id)).toEqual(["a", "g"]);
	});

	it("re-attempts a source whose directory could not be stat-ed as soon as stat succeeds", async () => {
		const state = sourceFailureState();
		const deps = sourceFailureDeps(state);

		// First pass: the directory cannot be stat-ed either, so no baseline exists.
		const first = await discover(deps, new Map(), opts(true));
		expect(first.cache.get(normalizedPath(PROJECT_DIR))?.sourceUnreadable).toBeDefined();

		// Still unstat-able: with no baseline to compare, the cached outcome stands
		// and the directory is never listed again.
		const second = await discover(deps, first.cache, opts(true));
		expect(second.errors[0]).toBe(first.errors[0]);
		expect(state.listed.filter((dir) => dir === PROJECT_DIR)).toHaveLength(1);

		// The moment the directory can be stat-ed again there is no baseline to
		// trust, so the source is re-attempted (and here it recovered).
		state.failing.delete(PROJECT_DIR);
		state.dirMtimes.set(PROJECT_DIR, 7);
		state.files.set(`${PROJECT_DIR}/b.md`, file(ruleText("Project B"), 2));
		const third = await discover(deps, second.cache, opts(true));
		expect(state.listed.filter((dir) => dir === PROJECT_DIR)).toHaveLength(2);
		expect(third.errors).toEqual([]);
		expect(third.rules.map((rule) => rule.id)).toEqual(["b", "g"]);
	});

	it("keeps sources isolated: recovering one never re-lists the other", async () => {
		const state = sourceFailureState();
		state.failing.add(GLOBAL_DIR);
		const deps = sourceFailureDeps(state);

		const first = await discover(deps, new Map(), opts(true));
		expect(first.errors.map((error) => error.file)).toEqual([PROJECT_DIR, GLOBAL_DIR]);
		expect(first.rules).toEqual([]);

		// Global recovers with a new directory mtime; the project stays cached.
		state.failing.delete(GLOBAL_DIR);
		state.dirMtimes.set(GLOBAL_DIR, 4);
		const second = await discover(deps, first.cache, opts(true));
		expect(second.rules.map((rule) => rule.id)).toEqual(["g"]);
		expect(second.errors.map((error) => error.file)).toEqual([PROJECT_DIR]);
		expect(state.listed.filter((dir) => dir === PROJECT_DIR)).toHaveLength(1);
		expect(state.listed.filter((dir) => dir === GLOBAL_DIR)).toHaveLength(2);
	});

	it("keeps listing a readable source on every pass — the cache is for failures only", async () => {
		const state = sourceFailureState();
		state.failing.clear();
		state.files.set(`${PROJECT_DIR}/a.md`, file(ruleText("Project A"), 2));
		const deps = sourceFailureDeps(state);

		const first = await discover(deps, new Map(), opts(true));
		const second = await discover(deps, first.cache, opts(true));
		expect(first.errors).toEqual([]);
		expect(second.errors).toEqual([]);
		expect(state.listed.filter((dir) => dir === PROJECT_DIR)).toHaveLength(2);
		// A recovered source leaves no directory entry behind: only file entries.
		expect([...second.cache.keys()].sort()).toEqual([
			normalizedPath(`${GLOBAL_DIR}/g.md`),
			normalizedPath(`${PROJECT_DIR}/a.md`),
		].sort());
	});
});

describe("discover — mtime cache", () => {
	it("reuses a cached rule without reading again when the mtime is unchanged", async () => {
		const store = seed([[`${PROJECT_DIR}/a.md`, file(ruleText("A"))]]);
		const { deps, callLog } = fakeDeps(store);
		const first = await discover(deps, new Map(), opts(true));
		expect(callLog.read).toEqual([`${PROJECT_DIR}/a.md`]);

		const second = await discover(deps, first.cache, opts(true));
		expect(callLog.read).toEqual([`${PROJECT_DIR}/a.md`]);
		expect(second.rules).toEqual(first.rules);
		expect(second.cache.get(normalizedPath(`${PROJECT_DIR}/a.md`))).toBe(
			first.cache.get(normalizedPath(`${PROJECT_DIR}/a.md`)),
		);
	});

	it("reuses a cached parse error without reading again when the mtime is unchanged", async () => {
		const store = seed([[`${PROJECT_DIR}/broken.md`, file(brokenText)]]);
		const { deps, callLog } = fakeDeps(store);
		const first = await discover(deps, new Map(), opts(true));
		expect(first.errors).toHaveLength(1);
		const readsAfterFirst = callLog.read.length;

		const second = await discover(deps, first.cache, opts(true));
		expect(callLog.read.length).toBe(readsAfterFirst);
		expect(second.errors).toEqual(first.errors);
	});

	it("re-reads and re-parses when the mtime changes, updating the cache", async () => {
		const store = seed([[`${PROJECT_DIR}/a.md`, file(ruleText("Old"), 1)]]);
		const { deps, callLog } = fakeDeps(store);
		const first = await discover(deps, new Map(), opts(true));

		const stored = store.get(`${PROJECT_DIR}/a.md`);
		if (stored === undefined) {
			throw new Error("fixture lost");
		}
		stored.content = ruleText("New");
		stored.mtimeMs = 2;

		const second = await discover(deps, first.cache, opts(true));
		expect(callLog.read).toEqual([`${PROJECT_DIR}/a.md`, `${PROJECT_DIR}/a.md`]);
		expect(second.rules.map((rule) => rule.description)).toEqual(["New"]);
		expect(second.cache.get(normalizedPath(`${PROJECT_DIR}/a.md`))?.mtimeMs).toBe(2);
	});

	it("drops deleted files from the rules and the next cache", async () => {
		const store = seed([
			[`${PROJECT_DIR}/a.md`, file(ruleText("A"))],
			[`${PROJECT_DIR}/gone.md`, file(ruleText("Gone"))],
		]);
		const { deps } = fakeDeps(store);
		const first = await discover(deps, new Map(), opts(true));
		expect(first.rules).toHaveLength(2);

		store.delete(`${PROJECT_DIR}/gone.md`);
		const second = await discover(deps, first.cache, opts(true));
		expect(second.rules.map((rule) => rule.id)).toEqual(["a"]);
		expect(second.cache.has(normalizedPath(`${PROJECT_DIR}/gone.md`))).toBe(false);
	});

	it("reports non-ENOENT stat failures without caching and continues discovery", async () => {
		const deps: DiscoveryDeps = {
			listNestedRuleDirs: async () => [],
			listRuleFiles: async (dir) => (dir === PROJECT_DIR ? ["locked.md", "a.md"] : []),
			stat: async (path) => {
				if (path.endsWith("locked.md")) {
					throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
				}
				return { mtimeMs: 1 };
			},
			readFile: async () => ruleText("A"),
		};
		const lockedPath = normalizedPath(`${PROJECT_DIR}/locked.md`);
		const result = await discover(deps, new Map(), opts(true));

		expect(result.rules.map((rule) => rule.id)).toEqual(["a"]);
		expect(result.errors).toEqual([
			{
				code: "read-failure",
				message: "failed to stat rule file: EACCES: permission denied",
				file: lockedPath,
			},
		]);
		expect(result.cache.has(lockedPath)).toBe(false);
	});

	it("skips files that vanish between listing and stat: no rule, no error, no cache entry", async () => {
		const deps: DiscoveryDeps = {
			listNestedRuleDirs: async () => [],
			listRuleFiles: async (dir) => (dir === PROJECT_DIR ? ["a.md", "gone.md"] : []),
			stat: async (path) => {
				if (path.endsWith("gone.md")) {
					throw enoent(path);
				}
				return { mtimeMs: 1 };
			},
			readFile: async () => ruleText("A"),
		};
		const result = await discover(deps, new Map(), opts(true));
		expect(result.rules.map((rule) => rule.id)).toEqual(["a"]);
		expect(result.errors).toEqual([]);
		expect(result.cache.size).toBe(1);
	});

	it("skips files that vanish between stat and read: no rule, no error, no cache entry", async () => {
		const deps: DiscoveryDeps = {
			listNestedRuleDirs: async () => [],
			listRuleFiles: async (dir) => (dir === PROJECT_DIR ? ["a.md", "gone.md"] : []),
			stat: async () => ({ mtimeMs: 1 }),
			readFile: async (path) => {
				if (path.endsWith("gone.md")) {
					throw enoent(path);
				}
				return ruleText("A");
			},
		};
		const result = await discover(deps, new Map(), opts(true));
		expect(result.rules.map((rule) => rule.id)).toEqual(["a"]);
		expect(result.errors).toEqual([]);
		expect(result.cache.size).toBe(1);
	});
});

describe("discover — parse errors", () => {
	it("collects parse errors with file info instead of throwing", async () => {
		const { deps } = fakeDeps(
			seed([
				[`${PROJECT_DIR}/a.md`, file(ruleText("A"))],
				[`${GLOBAL_DIR}/broken.md`, file(brokenText)],
			]),
		);
		const result = await discover(deps, new Map(), opts(true));
		expect(result.rules.map((rule) => rule.id)).toEqual(["a"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe("missing-frontmatter");
		expect(result.errors[0]?.file).toBe(`${GLOBAL_DIR}/broken.md`);
	});

	it("caches parse errors keyed by file with the stat mtime", async () => {
		const { deps } = fakeDeps(seed([[`${GLOBAL_DIR}/broken.md`, file(brokenText, 7)]]));
		const result = await discover(deps, new Map(), opts(false));
		const entry = result.cache.get(normalizedPath(`${GLOBAL_DIR}/broken.md`));
		expect(entry?.mtimeMs).toBe(7);
		expect(entry?.error?.code).toBe("missing-frontmatter");
		expect(entry?.rule).toBeUndefined();
	});
});

describe("discover — cache immutability", () => {
	it("never mutates the input cache; changed files land only in the fresh cache", async () => {
		const store = seed([
			[`${PROJECT_DIR}/a.md`, file(ruleText("A"))],
			[`${GLOBAL_DIR}/broken.md`, file(brokenText)],
		]);
		const { deps, callLog } = fakeDeps(store);
		const first = await discover(deps, new Map(), opts(true));

		const stored = store.get(`${PROJECT_DIR}/a.md`);
		if (stored === undefined) {
			throw new Error("fixture lost");
		}
		stored.mtimeMs = 2;
		store.set(`${GLOBAL_DIR}/extra.md`, file(ruleText("Extra")));

		const snapshot = [...first.cache.entries()].map(([key, entry]) => [key, { ...entry }] as const);
		const second = await discover(deps, first.cache, opts(true));

		expect([...first.cache.entries()]).toEqual(snapshot);
		expect(second.cache.get(normalizedPath(`${PROJECT_DIR}/a.md`))?.mtimeMs).toBe(2);
		expect(second.cache.get(normalizedPath(`${GLOBAL_DIR}/extra.md`))?.rule?.id).toBe("extra");
		// Unchanged broken file was reused from cache, not re-read.
		expect(callLog.read).toEqual([
			`${PROJECT_DIR}/a.md`,
			`${GLOBAL_DIR}/broken.md`,
			`${PROJECT_DIR}/a.md`,
			`${GLOBAL_DIR}/extra.md`,
		]);
	});
});

describe("production adapters — real filesystem", () => {
	let tmpDir: string | undefined;

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "pi-rules-md-discovery-"));
		await mkdir(join(tmpDir, "nested"), { recursive: true });
		await mkdir(join(tmpDir, "node_modules"), { recursive: true });
		await writeFile(join(tmpDir, "rule-a.md"), ruleText("A"));
		await writeFile(join(tmpDir, "nested", "rule-b.md"), ruleText("B"));
		await writeFile(join(tmpDir, "node_modules", "marker.md"), ruleText("Marker"));
	});

	afterAll(async () => {
		if (tmpDir !== undefined) {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("tinyglobbyScanner returns relative forward-slash paths and ignores node_modules", async () => {
		const dir = tmpDir;
		if (dir === undefined) {
			throw new Error("tmp fixture missing");
		}
		const found = await tinyglobbyScanner(["**/*.md"], normalizedPath(dir));
		expect(found).toContain("rule-a.md");
		expect(found).toContain("nested/rule-b.md");
		for (const path of found) {
			expect(path.includes("\\")).toBe(false);
			expect(path.startsWith("/")).toBe(false);
			expect(path.includes("node_modules")).toBe(false);
		}
	});

	it("skips a symlinked rule file outside the rules dir", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-rules-md-link-"));
		try {
			const rules = join(root, "rules");
			await mkdir(rules);
			const outside = join(root, "outside.md");
			await writeFile(outside, ruleText("Outside"));
			symlinkSync(outside, join(rules, "linked.md"));
			const result = await discover(nodeDiscoveryDeps(), new Map(), globalOnly(rules));
			expect(result.rules).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("skips rules inside a symlinked directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-rules-md-linkdir-"));
		try {
			const rules = join(root, "rules");
			const actual = join(root, "actual");
			await mkdir(rules);
			await mkdir(actual);
			await writeFile(join(actual, "linked.md"), ruleText("Linked"));
			symlinkSync(actual, join(rules, "alias"), "dir");
			const result = await discover(nodeDiscoveryDeps(), new Map(), globalOnly(rules));
			expect(result.rules).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("stops recursion at depth 10", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-rules-md-depth-"));
		try {
			const rules = join(root, "rules");
			const boundary = Array.from({ length: 9 }, (_, i) => `d${i}`).join("/");
			const beyond = `${boundary}/d9`;
			await mkdir(join(rules, boundary), { recursive: true });
			await mkdir(join(rules, beyond), { recursive: true });
			await writeFile(join(rules, boundary, "boundary.md"), ruleText("Boundary"));
			await writeFile(join(rules, beyond, "beyond.md"), ruleText("Beyond"));
			const result = await discover(nodeDiscoveryDeps(), new Map(), globalOnly(rules));
			expect(result.rules.map((rule) => rule.id)).toEqual(["boundary"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("ignores hidden entries", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-rules-md-hidden-"));
		try {
			await writeFile(join(root, ".hidden.md"), ruleText("Hidden"));
			const result = await discover(nodeDiscoveryDeps(), new Map(), globalOnly(root));
			expect(result.rules).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("nodeDiscoveryDeps lists recursive .md files relative with forward slashes; missing dir resolves to []", async () => {
		const dir = tmpDir;
		if (dir === undefined) {
			throw new Error("tmp fixture missing");
		}
		const deps = nodeDiscoveryDeps();
		const listed = await deps.listRuleFiles(dir);
		expect(listed).toContain("rule-a.md");
		expect(listed).toContain("nested/rule-b.md");
		for (const path of listed) {
			expect(path.includes("\\")).toBe(false);
			expect(path.startsWith("/")).toBe(false);
		}
		await expect(deps.listRuleFiles(join(dir, "does-not-exist"))).resolves.toEqual([]);
	});
});

/** Valid rule file with glob triggers (so rebasing is observable). */
const globRuleText = (description: string, globs: readonly string[], match = "touched"): string =>
	`---\ndescription: ${description}\nversion: 1\nglobs:\n${globs.map((glob) => `  - "${glob}"`).join("\n")}\nmatch: ${match}\n---\nBody.\n`;

describe("projectRuleDirs — walk-up bound (S10)", () => {
	it("lists cwd first, then each ancestor up to and including the git root", () => {
		expect(projectRuleDirs("/repo/packages/a", "/repo")).toEqual([
			{ dir: "/repo/packages/a/.pi/rules", base: "/repo/packages/a" },
			{ dir: "/repo/packages/.pi/rules", base: "/repo/packages" },
			{ dir: "/repo/.pi/rules", base: "/repo" },
		]);
	});

	it("falls back to exactly today's single project dir when there is no git root", () => {
		expect(projectRuleDirs("/work", undefined)).toEqual([{ dir: "/work/.pi/rules", base: "/work" }]);
	});

	it("collapses to one entry when cwd IS the git root", () => {
		expect(projectRuleDirs("/repo", "/repo")).toEqual([{ dir: "/repo/.pi/rules", base: "/repo" }]);
	});

	it("never walks up when cwd is not inside the reported root", () => {
		expect(projectRuleDirs("/other/pkg", "/repo")).toEqual([{ dir: "/other/pkg/.pi/rules", base: "/other/pkg" }]);
	});

	it("normalizes separators and a trailing root separator", () => {
		expect(projectRuleDirs("C:\\repo\\pkg", "C:/repo/")).toEqual([
			{ dir: "C:/repo/pkg/.pi/rules", base: "C:/repo/pkg" },
			{ dir: "C:/repo/.pi/rules", base: "C:/repo" },
		]);
	});

	it("handles the filesystem root as the git root without looping", () => {
		expect(projectRuleDirs("/repo", "/")).toEqual([
			{ dir: "/repo/.pi/rules", base: "/repo" },
			{ dir: "/.pi/rules", base: "/" },
		]);
	});
});

describe("discover — monorepo walk-up (S10)", () => {
	const REPO = "/repo";
	const PKG = "/repo/packages/a";
	const PKG_DIR = `${PKG}/.pi/rules`;
	const MID_DIR = `${REPO}/packages/.pi/rules`;
	const ROOT_DIR = `${REPO}/.pi/rules`;

	const monorepoOpts = (isProjectTrusted = true): DiscoveryOptions => ({
		globalDir: GLOBAL_DIR,
		projectDirs: [
			{ dir: PKG_DIR, base: PKG },
			{ dir: MID_DIR, base: `${REPO}/packages` },
			{ dir: ROOT_DIR, base: REPO },
		],
		cwd: PKG,
		isProjectTrusted,
	});

	it("orders rules cwd-first, then each ancestor, then global", async () => {
		const { deps, callLog } = fakeDeps(
			seed([
				[`${ROOT_DIR}/root.md`, file(ruleText("Root"))],
				[`${PKG_DIR}/pkg.md`, file(ruleText("Pkg"))],
				[`${MID_DIR}/mid.md`, file(ruleText("Mid"))],
				[`${GLOBAL_DIR}/g.md`, file(ruleText("Global"))],
			]),
		);
		const result = await discover(deps, new Map(), monorepoOpts());
		expect(result.rules.map((rule) => rule.id)).toEqual(["pkg", "mid", "root", "g"]);
		expect(result.rules.map((rule) => rule.source)).toEqual(["project", "project", "project", "global"]);
		expect(callLog.listed).toEqual([PKG_DIR, MID_DIR, ROOT_DIR, GLOBAL_DIR]);
	});

	it("keeps one id namespace across every project dir, cwd-first", async () => {
		const { deps } = fakeDeps(
			seed([
				[`${ROOT_DIR}/style.md`, file(ruleText("Root style"))],
				[`${MID_DIR}/style.md`, file(ruleText("Mid style"))],
				[`${PKG_DIR}/style.md`, file(ruleText("Pkg style"))],
				[`${GLOBAL_DIR}/style.md`, file(ruleText("Global style"))],
			]),
		);
		const result = await discover(deps, new Map(), monorepoOpts());
		expect(result.rules.map((rule) => `${rule.source}:${rule.id}`)).toEqual([
			"project:style",
			"project:style-2",
			"project:style-3",
			"global:style-4",
		]);
	});

	it("rebases ancestor globs onto the cwd scale and leaves cwd globs untouched", async () => {
		const { deps } = fakeDeps(
			seed([
				[`${ROOT_DIR}/root.md`, file(globRuleText("Root", ["packages/a/src/**/*.ts", "!packages/a/src/**/*.test.ts"]))],
				[`${PKG_DIR}/pkg.md`, file(globRuleText("Pkg", ["src/**/*.ts"]))],
			]),
		);
		const result = await discover(deps, new Map(), monorepoOpts());
		const pkg = result.rules.find((rule) => rule.id === "pkg");
		const root = result.rules.find((rule) => rule.id === "root");
		expect(pkg?.globs).toEqual(["src/**/*.ts"]);
		// Ancestor rule: absolute (outside cwd) + cwd-scale (inside cwd) forms.
		expect(root?.globs).toContain("/repo/packages/a/src/**/*.ts");
		expect(root?.globs).toContain("src/**/*.ts");
		expect(root?.globs).toContain("!/repo/packages/a/src/**/*.test.ts");
		expect(root?.globs).toContain("!src/**/*.test.ts");
	});

	it("gives ancestor rules a rules-dir-relative reference path and leaves cwd rules as today", async () => {
		const { deps } = fakeDeps(
			seed([
				[`${ROOT_DIR}/nested/root.md`, file(ruleText("Root"))],
				[`${PKG_DIR}/pkg.md`, file(ruleText("Pkg"))],
			]),
		);
		const result = await discover(deps, new Map(), monorepoOpts());
		const pkg = result.rules.find((rule) => rule.id === "pkg");
		const root = result.rules.find((rule) => rule.id === "root");
		// Today's shape: discovery leaves relativePath absent for the cwd dir and
		// the pipeline derives it. Ancestor rules cannot be derived by the
		// pipeline (it only knows cwd's rules root), so discovery names them.
		expect(pkg?.relativePath).toBeUndefined();
		expect(root?.relativePath).toBe(normalizedPath("nested/root.md"));
	});

	it("treats a missing ancestor rules dir as an empty contribution", async () => {
		const { deps, callLog } = fakeDeps(seed([[`${PKG_DIR}/pkg.md`, file(ruleText("Pkg"))]]));
		const result = await discover(deps, new Map(), monorepoOpts());
		expect(result.rules.map((rule) => rule.id)).toEqual(["pkg"]);
		expect(result.errors).toEqual([]);
		expect(callLog.listed).toEqual([PKG_DIR, MID_DIR, ROOT_DIR, GLOBAL_DIR]);
	});

	it("never lists any project dir when the project is untrusted", async () => {
		const { deps, callLog } = fakeDeps(
			seed([
				[`${ROOT_DIR}/root.md`, file(ruleText("Root"))],
				[`${PKG_DIR}/pkg.md`, file(ruleText("Pkg"))],
				[`${GLOBAL_DIR}/g.md`, file(ruleText("Global"))],
			]),
		);
		const result = await discover(deps, new Map(), monorepoOpts(false));
		expect(result.rules.map((rule) => rule.id)).toEqual(["g"]);
		expect(callLog.listed).toEqual([GLOBAL_DIR]);
		expect(callLog.read).toEqual([`${GLOBAL_DIR}/g.md`]);
	});

	it("never reads a .pi/rules dir ABOVE the git root, even when one exists", async () => {
		const above = "/.pi/rules";
		const { deps, callLog } = fakeDeps(
			seed([
				[`${above}/escaped.md`, file(ruleText("Escaped"))],
				[`${ROOT_DIR}/root.md`, file(ruleText("Root"))],
			]),
		);
		const dirs = projectRuleDirs(PKG, REPO);
		const result = await discover(deps, new Map(), {
			globalDir: GLOBAL_DIR,
			projectDirs: dirs,
			cwd: PKG,
			isProjectTrusted: true,
		});
		expect(dirs.every((entry) => entry.base !== "/")).toBe(true);
		expect(result.rules.map((rule) => rule.id)).toEqual(["root"]);
		expect(callLog.listed).not.toContain(above);
		expect(callLog.listed).not.toContain("/.pi/rules");
	});
});

describe("nestedProjectRuleDirs — enumeration filtering (S10 nested half)", () => {
	/** The `.pi/rules` dir under one base. */
	const rulesDir = (base: string): string => `${base}/.pi/rules`;
	/** A base exactly `MAX_NESTED_RULES_DIR_DEPTH` segments below cwd. */
	const atBound = `/repo/${Array.from({ length: MAX_NESTED_RULES_DIR_DEPTH }, (_, index) => `d${index}`).join("/")}`;

	it("accepts .pi/rules dirs strictly below cwd and rejects cwd's own dir", () => {
		expect(nestedProjectRuleDirs("/repo", [rulesDir("/repo"), rulesDir("/repo/packages/b")])).toEqual([
			{ dir: normalizedPath("/repo/packages/b/.pi/rules"), base: normalizedPath("/repo/packages/b") },
		]);
	});

	it("bounds the depth at MAX_NESTED_RULES_DIR_DEPTH", () => {
		expect(nestedProjectRuleDirs("/repo", [rulesDir(atBound), rulesDir(`${atBound}/deeper`)])).toEqual([
			{ dir: normalizedPath(`${atBound}/.pi/rules`), base: normalizedPath(atBound) },
		]);
	});

	it("never accepts a dir under .git or node_modules at any depth", () => {
		expect(
			nestedProjectRuleDirs("/repo", [
				rulesDir("/repo/.git"),
				rulesDir("/repo/.git/sub"),
				rulesDir("/repo/node_modules"),
				rulesDir("/repo/packages/b/node_modules/pkg"),
			]),
		).toEqual([]);
	});

	it("never accepts a dir outside cwd, in either direction", () => {
		expect(
			nestedProjectRuleDirs("/repo/packages/a", [
				rulesDir("/repo/packages/b"),
				rulesDir("/repo"),
				rulesDir("/etc"),
				rulesDir("/repo/packages/a/packages/b"),
			]),
		).toEqual([
			{ dir: normalizedPath("/repo/packages/a/packages/b/.pi/rules"), base: normalizedPath("/repo/packages/a/packages/b") },
		]);
	});

	it("orders shallow-first, then lexicographically, and dedupes", () => {
		const dirs = nestedProjectRuleDirs("/repo", [
			rulesDir("/repo/b"),
			rulesDir("/repo/a/deep"),
			rulesDir("/repo/a"),
			rulesDir("/repo/a"),
		]);
		expect(dirs.map((entry) => entry.base)).toEqual([
			normalizedPath("/repo/a"),
			normalizedPath("/repo/b"),
			normalizedPath("/repo/a/deep"),
		]);
	});

	it("ignores entries that are not .pi/rules dirs, and normalizes separators/trailing slashes", () => {
		expect(
			nestedProjectRuleDirs("/repo", [
				"/repo/packages/b/.pi",
				"/repo/packages/b/rules",
				"\\repo\\packages\\b\\.pi\\rules\\",
			]),
		).toEqual([{ dir: normalizedPath("/repo/packages/b/.pi/rules"), base: normalizedPath("/repo/packages/b") }]);
	});

	it("handles the filesystem root as cwd", () => {
		expect(nestedProjectRuleDirs("/", [rulesDir("/repo")])).toEqual([
			{ dir: normalizedPath("/repo/.pi/rules"), base: normalizedPath("/repo") },
		]);
	});
});

describe("discover — nested descendant dirs (S10 nested half)", () => {
	const REPO = "/repo";
	const PKG = "/repo/packages/a";
	const PKG_DIR = `${PKG}/.pi/rules`;
	const ROOT_DIR = `${REPO}/.pi/rules`;
	const B_DIR = `${PKG}/packages/b/.pi/rules`;
	const C_DIR = `${PKG}/packages/c/.pi/rules`;

	/** cwd + ancestor list plus the nested dirs the fake enumerator reports. */
	const nestedOpts = (nestedDirs: readonly string[], isProjectTrusted = true): DiscoveryOptions => ({
		globalDir: GLOBAL_DIR,
		projectDirs: [
			{ dir: PKG_DIR, base: PKG },
			{ dir: ROOT_DIR, base: REPO },
		],
		cwd: PKG,
		isProjectTrusted,
	});

	it("appends nested dirs after the walk-up list and before global", async () => {
		const { deps, callLog } = fakeDeps(
			seed([
				[`${PKG_DIR}/pkg.md`, file(ruleText("Pkg"))],
				[`${ROOT_DIR}/root.md`, file(ruleText("Root"))],
				[`${B_DIR}/b.md`, file(ruleText("B"))],
				[`${C_DIR}/c.md`, file(ruleText("C"))],
				[`${GLOBAL_DIR}/g.md`, file(ruleText("Global"))],
			]),
			// Reverse-inserted on purpose: discover must sort deterministically.
			[C_DIR, B_DIR],
		);
		const result = await discover(deps, new Map(), nestedOpts([C_DIR, B_DIR]));
		expect(callLog.listed).toEqual([PKG_DIR, ROOT_DIR, B_DIR, C_DIR, GLOBAL_DIR]);
		expect(result.rules.map((rule) => rule.id)).toEqual(["pkg", "root", "b", "c", "g"]);
		expect(result.rules.every((rule) => rule.source === "project" || rule.id === "g")).toBe(true);
	});

	it("keeps ONE id namespace across cwd, ancestor, nested and global dirs", async () => {
		const { deps } = fakeDeps(
			seed([
				[`${PKG_DIR}/style.md`, file(ruleText("Pkg style"))],
				[`${ROOT_DIR}/style.md`, file(ruleText("Root style"))],
				[`${B_DIR}/style.md`, file(ruleText("B style"))],
				[`${GLOBAL_DIR}/style.md`, file(ruleText("Global style"))],
			]),
			[B_DIR],
		);
		const result = await discover(deps, new Map(), nestedOpts([B_DIR]));
		expect(result.rules.map((rule) => `${rule.source}:${rule.id}`)).toEqual([
			"project:style",
			"project:style-2",
			"project:style-3",
			"global:style-4",
		]);
	});

	it("rebases a nested rule's globs onto its OWN subtree and names its reference path", async () => {
		const { deps } = fakeDeps(seed([[`${B_DIR}/nested.md`, file(globRuleText("Nested", ["src/**", "!src/**/*.test.ts"]))]]), [B_DIR]);
		const result = await discover(deps, new Map(), nestedOpts([B_DIR]));
		const nested = result.rules.find((rule) => rule.id === "nested");
		// Both scales: cwd-relative (paths inside cwd) and absolute (the exists scan).
		expect(nested?.globs).toContain("packages/b/src/**");
		expect(nested?.globs).toContain("/repo/packages/a/packages/b/src/**");
		expect(nested?.globs).toContain("!packages/b/src/**/*.test.ts");
		expect(nested?.relativePath).toBe(normalizedPath("nested.md"));
	});

	it("enumerates nothing and lists nothing below an untrusted project", async () => {
		const { deps, callLog } = fakeDeps(
			seed([
				[`${B_DIR}/b.md`, file(ruleText("B"))],
				[`${GLOBAL_DIR}/g.md`, file(ruleText("Global"))],
			]),
			[B_DIR],
		);
		const result = await discover(deps, new Map(), nestedOpts([B_DIR], false));
		expect(callLog.nested).toEqual([]);
		expect(callLog.listed).toEqual([GLOBAL_DIR]);
		expect(callLog.read).toEqual([`${GLOBAL_DIR}/g.md`]);
		expect(result.rules.map((rule) => rule.id)).toEqual(["g"]);
	});

	it("never lists a nested dir under .git/node_modules or outside cwd", async () => {
		const gitDir = `${PKG}/.git/.pi/rules`;
		const modulesDir = `${PKG}/node_modules/pkg/.pi/rules`;
		const outsideDir = "/etc/.pi/rules";
		const { deps, callLog } = fakeDeps(
			seed([
				[`${gitDir}/git.md`, file(ruleText("Git"))],
				[`${modulesDir}/vendored.md`, file(ruleText("Vendored"))],
				[`${outsideDir}/escaped.md`, file(ruleText("Escaped"))],
				[`${B_DIR}/b.md`, file(ruleText("B"))],
				[`${GLOBAL_DIR}/g.md`, file(ruleText("Global"))],
			]),
			[gitDir, modulesDir, outsideDir, B_DIR],
		);
		const result = await discover(deps, new Map(), nestedOpts([gitDir, modulesDir, outsideDir, B_DIR]));
		expect(callLog.listed).toEqual([PKG_DIR, ROOT_DIR, B_DIR, GLOBAL_DIR]);
		expect(result.rules.map((rule) => rule.id)).toEqual(["b", "g"]);
	});

	it("reports a rejected enumeration as source-unreadable and keeps the other sources", async () => {
		const { deps } = fakeDeps(
			seed([
				[`${PKG_DIR}/pkg.md`, file(ruleText("Pkg"))],
				[`${GLOBAL_DIR}/g.md`, file(ruleText("Global"))],
			]),
		);
		const failing: DiscoveryDeps = {
			...deps,
			listNestedRuleDirs: async () => {
				throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
			},
		};
		const result = await discover(failing, new Map(), nestedOpts([]));
		expect(result.rules.map((rule) => rule.id)).toEqual(["pkg", "g"]);
		expect(result.errors).toEqual([
			{
				code: "source-unreadable",
				message: expect.stringContaining("failed to enumerate nested rules sources"),
				file: normalizedPath(PKG),
			},
		]);
	});

	it("adds no visible behavior when no nested dirs exist", async () => {
		const { deps, callLog } = fakeDeps(
			seed([
				[`${PROJECT_DIR}/a.md`, file(ruleText("A"))],
				[`${GLOBAL_DIR}/g.md`, file(ruleText("Global"))],
			]),
		);
		const result = await discover(deps, new Map(), opts(true));
		// The enumeration runs (once, at cwd) and reports nothing: the pass below
		// is exactly the pre-T12 single-directory pass.
		expect(callLog.nested).toEqual(["/work"]);
		expect(callLog.listed).toEqual([PROJECT_DIR, GLOBAL_DIR]);
		expect(result.rules.map((rule) => `${rule.source}:${rule.id}`)).toEqual(["project:a", "global:g"]);
		expect(result.rules[0]?.globs).toBeUndefined();
		expect(result.rules[0]?.relativePath).toBeUndefined();
		expect([...result.cache.keys()]).toEqual([
			normalizedPath(`${PROJECT_DIR}/a.md`),
			normalizedPath(`${GLOBAL_DIR}/g.md`),
		]);
	});
});

describe("production adapters — nested enumeration (S10 nested half)", () => {
	it("finds nested .pi/rules dirs and skips .git, node_modules and dirs beyond the depth bound", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-rules-md-nested-"));
		try {
			const atBound = Array.from({ length: MAX_NESTED_RULES_DIR_DEPTH }, (_, index) => `d${index}`).join("/");
			// `""` is cwd's OWN `.pi/rules`: the walk-up list already carries it, so the
			// enumeration must not report it as a nested dir (no duplicate pass).
			const bases = ["", "packages/b", "a/b/c", atBound, `${atBound}/deeper`, ".git/sub", "node_modules/pkg", "packages/b/node_modules/x"];
			for (const base of bases) {
				await mkdir(join(root, base, ".pi", "rules"), { recursive: true });
			}
			const found = await nodeDiscoveryDeps().listNestedRuleDirs(normalizedPath(root));
			// The adapter reports what it found (cwd's own dir included); discovery's
			// pure filter is what drops the non-nested entries.
			expect(found.map((path) => path.slice(root.length + 1)).sort()).toEqual(
				[".pi/rules", "a/b/c/.pi/rules", "packages/b/.pi/rules", `${atBound}/.pi/rules`].sort(),
			);
			// Filtered and ordered shallow-first: depth 1, depth 3, depth MAX.
			expect(nestedProjectRuleDirs(normalizedPath(root), found).map((entry) => entry.base.slice(root.length + 1))).toEqual([
				"packages/b",
				"a/b/c",
				atBound,
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("never enumerates a rule dir behind a symlinked directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-rules-md-nested-link-"));
		const outside = await mkdtemp(join(tmpdir(), "pi-rules-md-nested-outside-"));
		try {
			await mkdir(join(outside, ".pi", "rules"), { recursive: true });
			await mkdir(join(root, "packages/b/.pi/rules"), { recursive: true });
			symlinkSync(outside, join(root, "linked"), "dir");
			const found = await nodeDiscoveryDeps().listNestedRuleDirs(normalizedPath(root));
			expect(found.map((path) => path.slice(root.length + 1))).toEqual(["packages/b/.pi/rules"]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("resolves a missing cwd to an empty enumeration", async () => {
		const found = await nodeDiscoveryDeps().listNestedRuleDirs(normalizedPath("/does/not/exist/anywhere"));
		expect(found).toEqual([]);
	});
});

/**
 * Importer discovery (S11 seam + Copilot adapter): imported files are project
 * rules listed behind the SAME trust gate as `.pi/rules`, materialized with the
 * importer contract (v1, touched, pinned, inform, project source, stem id from
 * the shared namespace, importer-root-relative reference path), placed after
 * the nested dirs and before global, and cached by mtime like any other rule
 * file. With no importers configured nothing is listed at all (the
 * `PI_RULES_IMPORT=none` composition-root path).
 */
describe("importer discovery (S11)", () => {
	/** Copilot's root below cwd for these fixtures. */
	const IMPORT_DIR = "/work/.github/instructions";

	/** Minimal Copilot instructions file: frontmatter `applyTo` plus a body. */
	const copilotText = (applyTo: string, body = "Imported body.\n"): string => `---\napplyTo: ${applyTo}\n---\n${body}`;

	/** Single-directory project options plus an importer list. */
	const importerOpts = (isProjectTrusted = true, importers: readonly Importer[] = [COPILOT_IMPORTER]): DiscoveryOptions => ({
		globalDir: GLOBAL_DIR,
		projectDirs: [{ dir: PROJECT_DIR, base: "/work" }],
		cwd: "/work",
		isProjectTrusted,
		importers,
	});

	it("lists `<cwd>/.github/instructions/**/*.instructions.md` with the importer contract", async () => {
		const { deps } = fakeDeps(
			seed([
				[`${IMPORT_DIR}/typescript.instructions.md`, file(copilotText("src/**"))],
				[`${IMPORT_DIR}/nested/api.instructions.md`, file(copilotText("docs/**"))],
				// Not an instructions file: ignored entirely, not even read.
				[`${IMPORT_DIR}/notes.md`, file(copilotText("src/**"))],
			]),
		);
		const result = await discover(deps, new Map(), importerOpts());
		expect(result.errors).toEqual([]);
		expect(result.rules.map((rule) => rule.id)).toEqual(["api", "typescript"]);
		expect(result.rules.find((rule) => rule.id === "typescript")).toMatchObject({
			source: "project",
			match: "touched",
			load: "pinned",
			enforcement: "inform",
			priority: 0,
			version: 1,
			alwaysApply: false,
			description: "typescript",
			globs: ["src/**"],
			path: normalizedPath(`${IMPORT_DIR}/typescript.instructions.md`),
			// Reference path is relative to the importer's own root.
			relativePath: normalizedPath("typescript.instructions.md"),
			content: "Imported body.\n",
		});
	});

	it("keeps imported globs cwd-relative (importer base IS cwd), not importer-dir-relative", async () => {
		// The instructions live BELOW cwd, but Copilot's `applyTo` is authored
		// against the repository root, so nothing is prepended or consumed.
		const { deps } = fakeDeps(seed([[`${IMPORT_DIR}/ts.instructions.md`, file(copilotText("src/**/*.ts"))]]));
		const result = await discover(deps, new Map(), importerOpts());
		expect(result.rules[0]?.globs).toEqual(["src/**/*.ts"]);
	});

	it("places imported rules after nested dirs and before global", async () => {
		const nestedDir = "/work/packages/b/.pi/rules";
		const { deps } = fakeDeps(
			seed([
				[`${PROJECT_DIR}/a.md`, file(ruleText("Cwd"))],
				[`${nestedDir}/b.md`, file(ruleText("Nested"))],
				[`${IMPORT_DIR}/c.instructions.md`, file(copilotText("src/**"))],
				[`${GLOBAL_DIR}/d.md`, file(ruleText("Global"))],
			]),
			[nestedDir],
		);
		const result = await discover(deps, new Map(), importerOpts());
		expect(result.rules.map((rule) => `${rule.source}:${rule.id}`)).toEqual([
			"project:a",
			"project:b",
			"project:c",
			"global:d",
		]);
	});

	it("shares ONE id namespace with native project rules (stem disambiguation)", async () => {
		const { deps } = fakeDeps(
			seed([
				[`${PROJECT_DIR}/typescript.md`, file(ruleText("Native"))],
				[`${IMPORT_DIR}/typescript.instructions.md`, file(copilotText("src/**"))],
			]),
		);
		const result = await discover(deps, new Map(), importerOpts());
		// Native cwd rules come first in the pass, so they keep the bare stem; the
		// imported rule takes the suffix (the `.instructions` part is not part of
		// the stem).
		expect(result.rules.map((rule) => rule.id)).toEqual(["typescript", "typescript-2"]);
	});

	it("lists, stats and reads nothing when the project is untrusted", async () => {
		const { deps, callLog } = fakeDeps(
			seed([
				[`${IMPORT_DIR}/typescript.instructions.md`, file(copilotText("src/**"))],
				[`${GLOBAL_DIR}/g.md`, file(ruleText("Global"))],
			]),
		);
		const result = await discover(deps, new Map(), importerOpts(false));
		expect(callLog.listed).toEqual([GLOBAL_DIR]);
		expect(callLog.read).toEqual([`${GLOBAL_DIR}/g.md`]);
		expect(callLog.stat).toEqual([`${GLOBAL_DIR}/g.md`]);
		expect(result.rules.map((rule) => rule.id)).toEqual(["g"]);
		expect(result.errors).toEqual([]);
	});

	it("reports an importer parse error under the REAL file and keeps the other rules", async () => {
		const broken = `${IMPORT_DIR}/broken.instructions.md`;
		const { deps } = fakeDeps(
			seed([
				[broken, file("---\napplyTo:\n  - src/**\n---\nBody.\n")],
				[`${IMPORT_DIR}/ok.instructions.md`, file(copilotText("src/**"))],
			]),
		);
		const result = await discover(deps, new Map(), importerOpts());
		expect(result.rules.map((rule) => rule.id)).toEqual(["ok"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.code).toBe("invalid-value");
		expect(result.errors[0]?.file).toBe(broken);
	});

	it("reuses the mtime cache for imported files and re-reads on change", async () => {
		const imported = `${IMPORT_DIR}/typescript.instructions.md`;
		const files = seed([[imported, file(copilotText("src/**"))]]);
		const first = fakeDeps(files);
		const one = await discover(first.deps, new Map(), importerOpts());
		expect(one.rules.map((rule) => rule.id)).toEqual(["typescript"]);

		// Unchanged mtime: the cached rule is reused with no second read.
		const two = await discover(first.deps, one.cache, importerOpts());
		expect(two.rules).toEqual(one.rules);
		expect(first.callLog.read).toEqual([imported]);

		// Changed mtime: re-read and re-parsed, the new globs win.
		files.set(imported, file(copilotText("docs/**"), 2));
		const three = await discover(first.deps, two.cache, importerOpts());
		expect(three.rules[0]?.globs).toEqual(["docs/**"]);
		expect(first.callLog.read).toEqual([imported, imported]);
		expect(three.cache.has(normalizedPath(imported))).toBe(true);
	});

	it("lists no importer root when no importers are configured (toggle off)", async () => {
		const { deps, callLog } = fakeDeps(
			seed([
				[`${IMPORT_DIR}/typescript.instructions.md`, file(copilotText("src/**"))],
				[`${GLOBAL_DIR}/g.md`, file(ruleText("Global"))],
			]),
		);
		const result = await discover(deps, new Map(), importerOpts(true, []));
		expect(callLog.listed).toEqual([PROJECT_DIR, GLOBAL_DIR]);
		expect(result.rules.map((rule) => rule.id)).toEqual(["g"]);
	});

	it("drops an importer whose root escapes cwd, without listing it", async () => {
		const { deps, callLog } = fakeDeps(seed([[`${IMPORT_DIR}/a.instructions.md`, file(copilotText("src/**"))]]));
		const escaping: Importer = { ...COPILOT_IMPORTER, dir: "../outside" };
		const result = await discover(deps, new Map(), importerOpts(true, [escaping]));
		expect(callLog.listed).not.toContain("/outside");
		expect(result.rules).toEqual([]);
		expect(result.errors).toEqual([]);
	});
});

describe("production adapters — Copilot importer (S11)", () => {
	it("discover lists real .instructions.md files below .github/instructions recursively", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-rules-md-import-"));
		try {
			await mkdir(join(root, ".github/instructions/nested"), { recursive: true });
			await writeFile(join(root, ".github/instructions/a.instructions.md"), "---\napplyTo: src/**\n---\nA body.\n");
			await writeFile(join(root, ".github/instructions/nested/b.instructions.md"), "No frontmatter: applies everywhere.\n");
			await writeFile(join(root, ".github/instructions/README.md"), "---\napplyTo: src/**\n---\nnot a rule\n");
			const result = await discover(nodeDiscoveryDeps(), new Map(), {
				globalDir: join(root, "no-global-rules"),
				projectDirs: [],
				cwd: normalizedPath(root),
				isProjectTrusted: true,
				importers: [COPILOT_IMPORTER],
			});
			expect(result.errors).toEqual([]);
			expect(result.rules.map((rule) => rule.id)).toEqual(["a", "b"]);
			expect(result.rules.find((rule) => rule.id === "b")?.alwaysApply).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
