/**
 * Rule discovery (imperative shell): finds markdown rule files in the global
 * and project rules directories, parses them through the pure frontmatter
 * parser, and maintains an mtime-keyed cache across calls so unchanged files
 * are never re-read.
 *
 * Functional core / imperative shell:
 * - `discover` orchestrates injected I/O only (`DiscoveryDeps`); it holds no
 *   module state, and the next cache is returned fresh — the input cache is
 *   never mutated (tests snapshot their fixtures to prove it).
 * - Parsing stays in src/frontmatter.ts (`parseRule`); this module never
 *   re-implements it. Only discovery metadata (path/source) is attached, and
 *   the returned rule id is finalized to the file stem per the discovery
 *   contract (the parser's broader `source:path` id is discovery's to
 *   narrow — see `loadRule`). Ids are unique across the whole merged pass,
 *   in pass order (project source first, then global; sorted path within
 *   each source): the first file with a stem keeps the bare stem, later
 *   files — within or across sources — get the smallest free `<stem>-2`,
 *   `<stem>-3`, … suffix, skipping any id already used in the pass
 *   (including another file's bare stem). A cached rule whose resolved id
 *   changes between passes is refreshed, never mutated.
 * - Production adapters (`nodeDiscoveryDeps`, `tinyglobbyScanner`) wrap
 *   node:fs/promises and tinyglobby; tests inject deterministic fakes.
 *
 * Contract notes pinned by tests:
 * - Rule files are any nested .md file per directory (recursive md glob);
 *   non-.md listings are ignored defensively (the production glob already
 *   filters).
 * - Project rules come FIRST, then global; within a source, files are sorted
 *   by absolute normalized path. Project-first ordering lets the selection
 *   pipeline's content-tie dedupe prefer project rules.
 * - Trust gate: when the project is untrusted, the project directory is
 *   never listed, stat-ed, or read.
 * - A missing directory contributes nothing and is not an error (the
 *   production `listRuleFiles` resolves ENOENT to []); a REJECTED
 *   `listRuleFiles` is collected as one `source-unreadable` error naming the
 *   directory — that source contributes no rules and no cache entries, and
 *   discovery continues with the remaining sources.
 * - A file that vanishes between listing and stat/read (ENOENT from stat or
 *   read) is skipped silently — no rule, no error, absent from the next
 *   cache. A non-ENOENT read failure (permissions, wrong file type, …) is a
 *   genuine failure: it is collected as a `read-failure` error naming the
 *   file and cached alongside the mtime, reusing the parse-error cache
 *   semantics instead of conflating with vanished-skip.
 * - mtime cache keyed by absolute normalized path: an entry with an
 *   unchanged mtimeMs is reused (rule OR error) without a read; a changed
 *   mtime re-reads and re-parses; files no longer listed are dropped.
 * - Parse failures (`parseRule` Result err) are collected into `errors`,
 *   never thrown.
 */
import { lstat, readFile, stat } from "node:fs/promises";
import { glob } from "tinyglobby";
import { parseRule } from "../src/frontmatter.ts";
import type { GlobScanner } from "../src/match.ts";
import { normalizedPath, ruleId } from "../src/types.ts";
import type { NormalizedPath, Rule, RuleError, RuleSource } from "../src/types.ts";

/** Injected filesystem surface for discovery. */
export interface DiscoveryDeps {
	/** Lists rule-file names under a directory, relative to it (missing dir → []). */
	readonly listRuleFiles: (dir: string) => Promise<readonly string[]>;
	/** Stats one file; only the modification time is consumed. */
	readonly stat: (path: string) => Promise<{ readonly mtimeMs: number }>;
	/** Reads one file as UTF-8 text. */
	readonly readFile: (path: string) => Promise<string>;
}

/** Directories discovery reads from, plus the project trust gate. */
export interface DiscoveryOptions {
	readonly globalDir: string;
	readonly projectDir: string;
	readonly isProjectTrusted: boolean;
}

/** Cached outcome for one rule file, reused while its mtime is unchanged. */
export interface DiscoveryCacheEntry {
	readonly mtimeMs: number;
	readonly rule?: Rule;
	readonly error?: RuleError;
}

/** Immutable map from absolute normalized rule-file path to its cached outcome. */
export type DiscoveryCache = ReadonlyMap<NormalizedPath, DiscoveryCacheEntry>;

/** Everything one discover call produces; `cache` is the fresh next cache. */
export interface DiscoveryResult {
	readonly rules: readonly Rule[];
	readonly errors: readonly RuleError[];
	readonly cache: DiscoveryCache;
}

const RULE_SUFFIX = ".md";
const MAX_RULES_SCAN_DEPTH = 10;

/** True for files this pipeline treats as rule files. */
const isRuleFile = (path: string): boolean => path.endsWith(RULE_SUFFIX);

/** File stem of a normalized path: last segment minus the .md suffix. */
const fileStem = (path: string): string => {
	const base = path.slice(path.lastIndexOf("/") + 1);
	return base.endsWith(RULE_SUFFIX) ? base.slice(0, -RULE_SUFFIX.length) : base;
};

/** Joins a listed (relative) name onto its directory as an absolute normalized path. */
const resolveListed = (dir: string, listed: string): NormalizedPath => normalizedPath(`${dir}/${listed}`);

/**
 * Resolves unique rule ids across the whole merged discovery pass: the first
 * file with a given stem — in pass order (project source first, then global;
 * sorted-path order within each source) — keeps the bare stem; later files,
 * within their source or across sources, get the smallest free `<stem>-2`,
 * `<stem>-3`, … suffix, skipping any id already used in the pass (including
 * another file's bare stem). `used` is shared across the pass and advanced in
 * order, so on a cross-source collision the project rule keeps the bare stem
 * and the later-source rule suffixes — deterministic by source order, then
 * path. (The selection pipeline's content-tie dedupe still prefers project
 * rules for identical content.)
 */
const assignSourceIds = (paths: readonly NormalizedPath[], used: Set<string>): ReadonlyMap<NormalizedPath, string> => {
	const ids = new Map<NormalizedPath, string>();
	for (const abs of paths) {
		const stem = fileStem(abs);
		let id = stem;
		if (used.has(id)) {
			let n = 2;
			while (used.has(`${stem}-${String(n)}`)) {
				n += 1;
			}
			id = `${stem}-${String(n)}`;
		}
		used.add(id);
		ids.set(abs, id);
	}
	return ids;
};

/** True when a thrown cause is a missing-path error (production ENOENT adapter). */
const isEnoent = (cause: unknown): boolean =>
	typeof cause === "object" && cause !== null && "code" in cause && cause["code"] === "ENOENT";

/**
 * Outcome of loading one listed rule file: a rule, a collected parse error,
 * or a silent skip (the file vanished between listing and stat/read).
 */
type LoadedRule =
	| { readonly kind: "rule"; readonly rule: Rule }
	| { readonly kind: "error"; readonly error: RuleError }
	| { readonly kind: "skipped" };

/**
 * Loads one listed rule file: stat → cache check → (re)read → parse. On a
 * cache hit with an unchanged mtimeMs the cached rule or error is reused
 * (no read) and the same entry object carries into the next cache; a cached
 * rule whose resolved id changed (a colliding file appeared or vanished) is
 * refreshed onto a new entry with the new id. A stat ENOENT or a read ENOENT
 * means the file vanished mid-scan: skip silently. A non-ENOENT read failure
 * is returned as a `read-failure` error and cached alongside the mtime.
 * Parse failures are returned as errors and cached alongside the mtime.
 */
const loadRule = async (
	deps: DiscoveryDeps,
	cache: DiscoveryCache,
	nextCache: Map<NormalizedPath, DiscoveryCacheEntry>,
	abs: NormalizedPath,
	source: RuleSource,
	id: string,
): Promise<LoadedRule> => {
	let statResult: { readonly mtimeMs: number };
	try {
		statResult = await deps.stat(abs);
	} catch {
		return { kind: "skipped" };
	}
	const cached = cache.get(abs);
	if (cached !== undefined && cached.mtimeMs === statResult.mtimeMs) {
		if (cached.rule !== undefined) {
			if (cached.rule.id === ruleId(id)) {
				nextCache.set(abs, cached);
				return { kind: "rule", rule: cached.rule };
			}
			// The resolved id changed between passes (collision set changed):
			// refresh the rule and its cache entry, never the input cache.
			const rule: Rule = { ...cached.rule, id: ruleId(id) };
			nextCache.set(abs, { mtimeMs: statResult.mtimeMs, rule });
			return { kind: "rule", rule };
		}
		if (cached.error !== undefined) {
			nextCache.set(abs, cached);
			return { kind: "error", error: cached.error };
		}
		return { kind: "skipped" };
	}
	let raw: string;
	try {
		raw = await deps.readFile(abs);
	} catch (cause) {
		if (isEnoent(cause)) {
			return { kind: "skipped" };
		}
		// A genuine read failure is not absence: surface it like a parse error
		// instead of conflating it with a vanished file.
		const error: RuleError = {
			code: "read-failure",
			message: `failed to read rule file: ${cause instanceof Error ? cause.message : String(cause)}`,
			file: abs,
		};
		nextCache.set(abs, { mtimeMs: statResult.mtimeMs, error });
		return { kind: "error", error };
	}
	const parsed = parseRule(raw, { path: abs, source });
	if (!parsed.ok) {
		nextCache.set(abs, { mtimeMs: statResult.mtimeMs, error: parsed.error });
		return { kind: "error", error: parsed.error };
	}
	// Discovery finalizes the id to the (disambiguated) file stem (discovery
	// contract); the parser stays the sole owner of validation, defaults, and
	// content.
	const rule: Rule = { ...parsed.value, id: ruleId(id) };
	nextCache.set(abs, { mtimeMs: statResult.mtimeMs, rule });
	return { kind: "rule", rule };
};

/**
 * Discovers rules from the project (first, when trusted) and global
 * directories. Pure orchestration over the injected deps: the input cache
 * is never mutated, and the fresh next cache covers exactly the files still
 * listed. Callers start with an empty cache (`new Map()`).
 */
export const discover = async (
	deps: DiscoveryDeps,
	cache: DiscoveryCache,
	opts: DiscoveryOptions,
): Promise<DiscoveryResult> => {
	// Project first so the selection pipeline's content-tie dedupe prefers
	// project rules; the trust gate drops the project source entirely.
	const sources: ReadonlyArray<readonly [dir: string, source: RuleSource]> = opts.isProjectTrusted
		? [
				[opts.projectDir, "project"],
				[opts.globalDir, "global"],
			]
		: [[opts.globalDir, "global"]];

	const rules: Rule[] = [];
	const errors: RuleError[] = [];
	const nextCache = new Map<NormalizedPath, DiscoveryCacheEntry>();
	// Shared across the merged pass so ids stay unique project-wide + global-wide.
	const usedIds = new Set<string>();
	for (const [dir, source] of sources) {
		let listed: readonly string[];
		try {
			listed = await deps.listRuleFiles(dir);
		} catch (cause) {
			// Totality: one unreadable source never fails the pass — it
			// contributes nothing and the remaining sources continue.
			errors.push({
				code: "source-unreadable",
				message: `failed to list rules source: ${cause instanceof Error ? cause.message : String(cause)}`,
				file: dir,
			});
			continue;
		}
		const paths = listed.map((name) => resolveListed(dir, name)).filter(isRuleFile).sort();
		const ids = assignSourceIds(paths, usedIds);
		for (const abs of paths) {
			const id = ids.get(abs) ?? fileStem(abs);
			const loaded = await loadRule(deps, cache, nextCache, abs, source, id);
			if (loaded.kind === "rule") {
				rules.push(loaded.rule);
			} else if (loaded.kind === "error") {
				errors.push(loaded.error);
			}
		}
	}
	return { rules, errors, cache: nextCache };
};

/**
 * Production deps: node:fs/promises stat/read plus a tinyglobby listing
 * (recursive md glob, relative to the directory) that resolves a missing directory
 * (ENOENT) to an empty result — discovery then contributes nothing for that
 * source instead of failing.
 */
export const nodeDiscoveryDeps = (): DiscoveryDeps => ({
	listRuleFiles: async (dir) => {
		try {
			const listed = await glob(["**/*.md"], { cwd: dir, dot: false });
			const safe: string[] = [];
			for (const name of listed) {
				const segments = name.split("/");
				if (segments.length > MAX_RULES_SCAN_DEPTH) continue;
				let current = dir;
				let linked = false;
				for (const segment of segments) {
					current = `${current}/${segment}`;
					try {
						if ((await lstat(current)).isSymbolicLink()) {
							linked = true;
							break;
						}
					} catch (cause) {
						if (isEnoent(cause)) {
							linked = true;
							break;
						}
						throw cause;
					}
				}
				if (!linked) safe.push(name);
			}
			return safe;
		} catch (cause) {
			if (isEnoent(cause)) {
				return [];
			}
			throw cause;
		}
	},
	stat: async (path) => {
		const stats = await stat(path);
		return { mtimeMs: stats.mtimeMs };
	},
	readFile: (path) => readFile(path, "utf8"),
});

/**
 * Production scan adapter for the engine's exists-match pool: recursive scan
 * with the pinned ignore policy (VCS internals and dependency trees never
 * count as project files). Results stay relative to `cwd`; matching code
 * normalizes them.
 */
export const tinyglobbyScanner: GlobScanner = (patterns, cwd) =>
	glob(patterns, {
		cwd,
		dot: true,
		ignore: [".git/**", "**/.git/**", "node_modules/**", "**/node_modules/**"],
	});
