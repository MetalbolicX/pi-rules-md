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
import { discover, nodeDiscoveryDeps, tinyglobbyScanner } from "./discovery.ts";
import type { DiscoveryDeps, DiscoveryOptions } from "./discovery.ts";
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
const fakeDeps = (files: Map<string, FakeFile>) => {
	const callLog = { listed: [] as string[], stat: [] as string[], read: [] as string[] };
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

const opts = (isProjectTrusted: boolean): DiscoveryOptions => ({
	globalDir: GLOBAL_DIR,
	projectDir: PROJECT_DIR,
	isProjectTrusted,
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
		// The unreadable source contributed no cache entries.
		expect([...result.cache.keys()]).toEqual([normalizedPath(`${GLOBAL_DIR}/g.md`)]);
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
			const result = await discover(nodeDiscoveryDeps(), new Map(), {
				globalDir: rules, projectDir: rules, isProjectTrusted: false,
			});
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
			const result = await discover(nodeDiscoveryDeps(), new Map(), {
				globalDir: rules, projectDir: rules, isProjectTrusted: false,
			});
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
			const result = await discover(nodeDiscoveryDeps(), new Map(), {
				globalDir: rules, projectDir: rules, isProjectTrusted: false,
			});
			expect(result.rules.map((rule) => rule.id)).toEqual(["boundary"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("ignores hidden entries", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-rules-md-hidden-"));
		try {
			await writeFile(join(root, ".hidden.md"), ruleText("Hidden"));
			const result = await discover(nodeDiscoveryDeps(), new Map(), {
				globalDir: root, projectDir: root, isProjectTrusted: false,
			});
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
