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
 * - Monorepo walk-up (S10): the project source is the ordered `.pi/rules` list
 *   from `<cwd>/.pi/rules` up to the git root, one pass segment per directory,
 *   in that order — so cwd ordering/ids/bytes are exactly today's and ancestor
 *   rules append after them. All project directories share ONE id namespace,
 *   every project directory precedes global, and each rule's globs are relative
 *   to the directory owning its `.pi/` folder (rebased in shell/match.ts). The
 *   list is bounded by the caller; discovery never walks further, so a
 *   `.pi/rules` above the git root is never read.
 * - Trust gate: when the project is untrusted, NO project directory (cwd's or
 *   any ancestor's) is listed, stat-ed, or read.
 * - A missing directory contributes nothing and is not an error (the
 *   production `listRuleFiles` resolves ENOENT to []); a REJECTED
 *   `listRuleFiles` is collected as one `source-unreadable` error naming the
 *   directory — that source contributes no rules and no cache entries, and
 *   discovery continues with the remaining sources.
 * - A file that vanishes between listing and stat/read (ENOENT from stat or
 *   read) is skipped silently — no rule, no error, absent from the next
 *   cache. A non-ENOENT stat failure is collected as a `read-failure` error
 *   naming the file but is not cached because no mtime is known. A non-ENOENT
 *   read failure (permissions, wrong file type, …) is collected as a
 *   `read-failure` error naming the file and cached alongside the mtime,
 *   reusing the parse-error cache semantics instead of conflating with
 *   vanished-skip.
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
import { rebaseGlobs } from "./match.ts";

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
	/**
	 * Project rule directories in pass order: `<cwd>/.pi/rules` first, then one
	 * entry per ancestor up to and including the git root (see
	 * {@link projectRuleDirs}). The list is built by the composition root and is
	 * already bounded — discovery never extends it, so nothing above the git
	 * root can be read. Untrusted projects pass an empty list AND are gated
	 * below (defense in depth).
	 */
	readonly projectDirs: readonly ProjectRuleDir[];
	readonly isProjectTrusted: boolean;
	/** Working directory: the scale touched/existing paths are expressed on. */
	readonly cwd: string;
}

/**
 * One project rules directory plus the directory owning its `.pi` folder — the
 * rule base its globs are relative to (S10). `<cwd>/.pi/rules` has
 * `base === cwd`, which is exactly today's implicit base and therefore rebases
 * nothing.
 */
export interface ProjectRuleDir {
	/** Absolute normalized directory holding the rule files (the `.pi/rules` dir). */
	readonly dir: string;
	/** Absolute normalized directory the rules' globs are relative to. */
	readonly base: string;
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

/** The `.pi/rules` directory under one base, without doubling a filesystem-root separator. */
const rulesDirUnder = (base: string): NormalizedPath =>
	base === "/" ? normalizedPath("/.pi/rules") : normalizedPath(`${base}/.pi/rules`);

/** Parent directory of a normalized absolute path (`/a/b` → `/a`, `/a` → `/`). */
const parentOf = (path: string): string => {
	const cut = path.lastIndexOf("/");
	return cut <= 0 ? "/" : path.slice(0, cut);
};

/**
 * Builds the ordered project rules directory list for one cycle (S10 walk-up
 * half): `<cwd>/.pi/rules` FIRST — so cwd rules keep today's ordering, ids and
 * bytes — then one entry per ancestor, ending with the git root itself.
 *
 * Total and bounded by construction:
 * - no git root (not a repository, git unavailable, …) → exactly today's single
 *   project directory, i.e. today's behavior byte for byte;
 * - cwd outside the reported root (a stale answer, a symlinked layout) → the
 *   single cwd directory, because walking up would read directories the bound
 *   does not cover;
 * - cwd IS the root → one entry.
 *
 * Nothing above the git root is ever produced, so no file above it can be read.
 */
export const projectRuleDirs = (cwd: string, gitRoot: string | undefined): readonly ProjectRuleDir[] => {
	const start = normalizedPath(cwd).replace(/\/+$/, "") || "/";
	if (gitRoot === undefined) {
		return [{ dir: rulesDirUnder(start), base: start }];
	}
	const root = normalizedPath(gitRoot).replace(/\/+$/, "") || "/";
	const insideRoot = start === root || start.startsWith(root === "/" ? "/" : `${root}/`);
	if (!insideRoot) {
		return [{ dir: rulesDirUnder(start), base: start }];
	}
	const dirs: ProjectRuleDir[] = [];
	let current = start;
	// Bounded: each step moves one segment closer to the root, the containment
	// check stops the walk the moment a step would leave the root, and a
	// filesystem root is its own parent.
	for (;;) {
		dirs.push({ dir: rulesDirUnder(current), base: current });
		if (current === root) {
			return dirs;
		}
		const parent = parentOf(current);
		if (parent === current) {
			return dirs;
		}
		current = parent;
		if (!(current === root || current.startsWith(root === "/" ? "/" : `${root}/`))) {
			return dirs;
		}
	}
};

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
 * Applies the monorepo rule-base contract to one freshly loaded project rule
 * (S10). Two adjustments, and ONLY for rules whose base is not cwd:
 *
 * - `globs` are rebased from the rule base onto the cwd/absolute scales
 *   (shell/match.ts) so an ancestor rule matches the paths the evaluation pools
 *   actually carry. A cwd rule (`base === cwd`) is NOT touched — `rebaseGlobs`
 *   returns the identical array, and the whole rule object is returned as-is.
 * - `relativePath` is derived from the rule's OWN rules directory. The pipeline
 *   can only derive it for `<cwd>/.pi/rules` (it knows just cwd's rules root),
 *   so an ancestor on-demand rule would otherwise be indexed with no fetchable
 *   reference and `read_rule` would answer "Unknown rule". Cwd rules keep
 *   today's shape: absent here, derived by the pipeline exactly as before, so
 *   their bytes do not move.
 */
const finalizeProjectRule = (rule: Rule, entry: ProjectRuleDir, cwd: string): Rule => {
	if (normalizedPath(entry.base) === normalizedPath(cwd) && rule.relativePath === undefined) {
		return rule;
	}
	const globs = rule.globs === undefined ? undefined : rebaseGlobs(rule.globs, entry.base, cwd);
	const prefix = `${entry.dir}/`;
	const derived = rule.relativePath ?? (rule.path.startsWith(prefix) ? normalizedPath(rule.path.slice(prefix.length)) : undefined);
	if (globs === rule.globs && derived === rule.relativePath) {
		return rule;
	}
	return {
		...rule,
		...(globs === undefined ? {} : { globs }),
		...(derived === undefined ? {} : { relativePath: derived }),
	};
};

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
 * means the file vanished mid-scan: skip silently. A non-ENOENT stat failure
 * is returned as a `read-failure` error without caching (no mtime is known).
 * A non-ENOENT read failure is returned as a `read-failure` error and cached
 * alongside the mtime. Parse failures are returned as errors and cached
 * alongside the mtime.
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
	} catch (cause) {
		if (isEnoent(cause)) {
			return { kind: "skipped" };
		}
		const error: RuleError = {
			code: "read-failure",
			message: `failed to stat rule file: ${cause instanceof Error ? cause.message : String(cause)}`,
			file: abs,
		};
		return { kind: "error", error };
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
 *
 * Monorepo walk-up (S10): every project directory in `opts.projectDirs` is one
 * pass segment, in the caller's order (cwd first, then ancestors up to the git
 * root). All of them contribute `source: "project"`, all of them share ONE id
 * namespace (so the stem+suffix contract holds across directories), and all of
 * them come before global. Ancestor rules have their globs rebased onto the
 * cwd scale (shell/match.ts) and get the rules-dir-relative `relativePath` the
 * pipeline can only derive for cwd rules; a rule whose base IS cwd is returned
 * untouched, so today's single-directory output is byte-identical.
 */
export const discover = async (
	deps: DiscoveryDeps,
	cache: DiscoveryCache,
	opts: DiscoveryOptions,
): Promise<DiscoveryResult> => {
	// Project first so the selection pipeline's content-tie dedupe prefers
	// project rules; the trust gate drops every project source at once.
	const projectDirs: readonly ProjectRuleDir[] = opts.isProjectTrusted ? opts.projectDirs : [];

	const rules: Rule[] = [];
	const errors: RuleError[] = [];
	const nextCache = new Map<NormalizedPath, DiscoveryCacheEntry>();
	// Shared across the merged pass so ids stay unique project-wide + global-wide.
	const usedIds = new Set<string>();
	const loadSource = async (dir: string, source: RuleSource, entry: ProjectRuleDir | undefined): Promise<void> => {
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
			return;
		}
		const paths = listed.map((name) => resolveListed(dir, name)).filter(isRuleFile).sort();
		const ids = assignSourceIds(paths, usedIds);
		for (const abs of paths) {
			const id = ids.get(abs) ?? fileStem(abs);
			const loaded = await loadRule(deps, cache, nextCache, abs, source, id);
			if (loaded.kind === "rule") {
				rules.push(entry === undefined ? loaded.rule : finalizeProjectRule(loaded.rule, entry, opts.cwd));
			} else if (loaded.kind === "error") {
				errors.push(loaded.error);
			}
		}
	};
	for (const entry of projectDirs) {
		await loadSource(entry.dir, "project", entry);
	}
	await loadSource(opts.globalDir, "global", undefined);
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
