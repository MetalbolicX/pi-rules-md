/**
 * Rule discovery (imperative shell): finds markdown rule files in the global
 * and project rules directories (plus importer-owned formats, S11), parses them
 * through the pure frontmatter parser — or the owning importer's lenient adapter
 * — and maintains an mtime-keyed cache across calls so unchanged files are
 * never re-read.
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
 *   rules append after them. The list is bounded by the caller; discovery never
 *   walks further, so a `.pi/rules` above the git root is never read.
 * - Nested descendants (S10): discovery ENUMERATES `.pi/rules` dirs below cwd
 *   through the injected `listNestedRuleDirs` seam and appends them to the same
 *   pass — after cwd and the ancestors, before global, ordered shallow-first
 *   then lexicographically (see `nestedProjectRuleDirs`). The enumeration is
 *   bounded by `MAX_NESTED_RULES_DIR_DEPTH`, never accepts a dir outside cwd,
 *   and never accepts one under `.git` or `node_modules` — checked again in the
 *   pure filter, so a wrong adapter cannot widen the read set. Their globs are
 *   rebased the other way round (prefix PREPENDED, shell/match.ts).
 * - All project directories (cwd, ancestors, nested) share ONE id namespace,
 *   and every project directory precedes global; each rule's globs are relative
 *   to the directory owning its `.pi/` folder (rebased in shell/match.ts).
 * - Trust gate: when the project is untrusted, NO project directory (cwd's, an
 *   ancestor's, or a nested one) is listed, enumerated, stat-ed, or read.
 * - A missing directory contributes nothing and is not an error (the
 *   production `listRuleFiles` resolves ENOENT to []); a REJECTED
 *   `listRuleFiles` is collected as one `source-unreadable` error naming the
 *   directory — that source contributes no files and no file cache entries,
 *   and discovery continues with the remaining sources. The failed outcome
 *   itself is CACHED (S13), keyed by the directory's own path, so later passes
 *   re-report the same error without re-listing the directory; see
 *   `sourceCacheStale` for the invalidation rule.
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
 * - Importers (S11): when the project is trusted, every configured importer's
 *   root (`<cwd>/<importer.dir>`) is listed through the SAME `listRuleFiles`
 *   seam and filtered to `importer.fileSuffix`; each file is adapted by the
 *   importer's own LENIENT adapter (shell/importers), never by `parseRule`.
 *   Imported rules enter the pass AFTER the nested dirs and BEFORE global, in
 *   ONE shared id namespace, with `source: "project"` and the fixed importer
 *   contract (version 1, touched, pinned, inform). Their globs are authored
 *   against cwd, so the rule base IS cwd and nothing is rebased; their
 *   `relativePath` is relative to the importer's OWN root. An untrusted project
 *   lists no importer root, and no configured importer means zero listing.
 */
import { lstat, readFile, stat } from "node:fs/promises";
import { glob } from "tinyglobby";
import { parseRule } from "../src/frontmatter.ts";
import type { GlobScanner } from "../src/match.ts";
import { ok } from "../src/result.ts";
import type { Result } from "../src/result.ts";
import { normalizedPath, ruleId } from "../src/types.ts";
import type { NormalizedPath, Rule, RuleError, RuleSource } from "../src/types.ts";
import { fileNameOf, importerFileStem, importerRootDir, materializeImportedRule } from "./importers/seam.ts";
import type { Importer } from "./importers/seam.ts";
import { rebaseRuleGlobs } from "./match.ts";

/** Injected filesystem surface for discovery. */
export interface DiscoveryDeps {
	/** Lists rule-file names under a directory, relative to it (missing dir → []). */
	readonly listRuleFiles: (dir: string) => Promise<readonly string[]>;
	/** Stats one file; only the modification time is consumed. */
	readonly stat: (path: string) => Promise<{ readonly mtimeMs: number }>;
	/** Reads one file as UTF-8 text. */
	readonly readFile: (path: string) => Promise<string>;
	/**
	 * Enumerates the `.pi/rules` directories BELOW `cwd` (S10 nested half), as
	 * absolute normalized paths. Called only for a trusted project — never for an
	 * untrusted one — and re-validated by `nestedProjectRuleDirs` (depth bound,
	 * containment, `.git`/`node_modules`), so this adapter can only ever narrow
	 * the read set, never widen it. A missing `cwd` resolves to `[]`.
	 */
	readonly listNestedRuleDirs: (cwd: string) => Promise<readonly string[]>;
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
	/**
	 * Imported rule formats (S11). Each importer lists its own root below cwd
	 * (`<cwd>/<importer.dir>`) and adapts its files leniently. Enumerated ONLY for
	 * a trusted project — after the `.pi/rules` walk-up/nested dirs, before global
	 * — into the same project id namespace. `undefined` or empty means no importer
	 * root is listed at all, which is the composition-root shape of
	 * `PI_RULES_IMPORT=none`.
	 */
	readonly importers?: readonly Importer[];
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
	/**
	 * Set only on a SOURCE entry (S13): the `source-unreadable` error a rejected
	 * `listRuleFiles` produced. Such entries are keyed by the unreadable
	 * directory's own path and carry no rule and no file error; `mtimeMs` is the
	 * directory's mtime at the failure, or {@link UNKNOWN_SOURCE_MTIME} when the
	 * directory could not be stat-ed either. `loadRule` never sees one: a listed
	 * file path is always `<dir>/<name>`, so it can never equal a directory key.
	 */
	readonly sourceUnreadable?: RuleError;
}

/**
 * Directory mtime stand-in for an unreadable source that could not be stat-ed,
 * so no baseline exists to compare against (see `sourceCacheStale`).
 */
const UNKNOWN_SOURCE_MTIME = -1;

/**
 * Immutable map from absolute normalized rule-file path to its cached outcome.
 * It also holds the S13 source entries, keyed by the unreadable DIRECTORY's
 * path (see `DiscoveryCacheEntry.sourceUnreadable`).
 */
export type DiscoveryCache = ReadonlyMap<NormalizedPath, DiscoveryCacheEntry>;

/** Everything one discover call produces; `cache` is the fresh next cache. */
export interface DiscoveryResult {
	readonly rules: readonly Rule[];
	readonly errors: readonly RuleError[];
	readonly cache: DiscoveryCache;
}

const RULE_SUFFIX = ".md";
const MAX_RULES_SCAN_DEPTH = 10;
/**
 * Deepest nested rule base discovery accepts (S10 nested half), counted as the
 * number of directory segments between cwd and the directory owning the `.pi/`
 * folder: `packages/b/.pi/rules` is depth 2 (precedent: `MAX_RULES_SCAN_DEPTH`).
 * Bounds both the enumeration glob (`deep`, in the production adapter) and the
 * pure filter, so neither a wrong adapter nor a deep tree can widen the scan.
 */
export const MAX_NESTED_RULES_DIR_DEPTH = 6;
/** Suffix every enumerated entry must carry: the `.pi/rules` dir itself. */
const NESTED_RULES_SUFFIX = "/.pi/rules";
/** Directory names never walked into while looking for rule dirs. */
const IGNORED_DIR_SEGMENTS: ReadonlySet<string> = new Set([".git", "node_modules"]);

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

/** Non-empty path segments; a leading `/` or `C:` survives as a segment. */
const segmentsOf = (value: string): readonly string[] => normalizedPath(value).split("/").filter((segment) => segment !== "");

/**
 * Directory segments of `path` relative to `from`, or `undefined` when `path` is
 * not STRICTLY inside `from` (equal paths included). Separator-normalized;
 * `C:` survives as a segment, which is what git reports on Windows.
 */
const segmentsInside = (from: string, path: string): readonly string[] | undefined => {
	const outer = segmentsOf(from);
	const inner = segmentsOf(path);
	if (inner.length <= outer.length) {
		return undefined;
	}
	for (const [index, segment] of outer.entries()) {
		if (inner[index] !== segment) {
			return undefined;
		}
	}
	return inner.slice(outer.length);
};

/** Nested-dir order: shallow-first, then lexicographic by base path. */
const byDepthThenPath = (
	a: { readonly entry: ProjectRuleDir; readonly depth: number },
	b: { readonly entry: ProjectRuleDir; readonly depth: number },
): number => {
	if (a.depth !== b.depth) {
		return a.depth - b.depth;
	}
	return a.entry.base < b.entry.base ? -1 : a.entry.base > b.entry.base ? 1 : 0;
};

/**
 * The nested project rules directories discovery appends to the pass (S10
 * nested half), derived from the adapter's raw enumeration.
 *
 * Deterministic by contract:
 * - only entries that ARE a `.pi/rules` directory count (`<base>/.pi/rules`);
 * - the rule base (`base`) must be STRICTLY below cwd, so a nested dir can never
 *   be cwd's own `.pi/rules` (that dir is already first in the walk-up list) nor
 *   anything above or beside cwd — this is the no-escape pin;
 * - `base` must be at most `MAX_NESTED_RULES_DIR_DEPTH` segments below cwd;
 * - no segment of the relative path may be `.git` or `node_modules` — an ignored
 *   tree is never a rule base, whatever the adapter reports;
 * - duplicates collapse to the first occurrence, and the result is ordered
 *   SHALLOW-FIRST and then lexicographically by base path. Nearest-first matches
 *   the walk-up's spirit (cwd, then outward), so a nearer nested `.pi/rules` wins
 *   the bare id stem on a collision, and the order never depends on adapter
 *   output order.
 *
 * Pure and total: an unparsable or hostile entry is simply dropped.
 */
export const nestedProjectRuleDirs = (cwd: string, listed: readonly string[]): readonly ProjectRuleDir[] => {
	const found: Array<{ readonly entry: ProjectRuleDir; readonly depth: number }> = [];
	const seen = new Set<string>();
	for (const listedDir of listed) {
		const dir = normalizedPath(listedDir).replace(/\/+$/, "");
		if (!dir.endsWith(NESTED_RULES_SUFFIX)) {
			continue;
		}
		const rawBase = dir.slice(0, -NESTED_RULES_SUFFIX.length);
		const base = normalizedPath(rawBase === "" ? "/" : rawBase);
		const relative = segmentsInside(cwd, base);
		if (relative === undefined || relative.length > MAX_NESTED_RULES_DIR_DEPTH) {
			continue;
		}
		if (relative.some((segment) => IGNORED_DIR_SEGMENTS.has(segment))) {
			continue;
		}
		if (seen.has(base)) {
			continue;
		}
		seen.add(base);
		found.push({ entry: { dir: normalizedPath(dir), base }, depth: relative.length });
	}
	return found.sort(byDepthThenPath).map((item) => item.entry);
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
 *
 * `stemOf` is the per-segment stem contract: native rules use the file stem
 * (`a.md` → `a`), an importer's files use the stem its own format defines
 * (`typescript.instructions.md` → `typescript`), so imported ids compete in the
 * SAME namespace instead of leaking a format suffix into the id.
 */
const assignSourceIds = (
	paths: readonly NormalizedPath[],
	used: Set<string>,
	stemOf: (abs: NormalizedPath) => string = fileStem,
): ReadonlyMap<NormalizedPath, string> => {
	const ids = new Map<NormalizedPath, string>();
	for (const abs of paths) {
		const stem = stemOf(abs);
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
 *   (shell/match.ts) so the rule matches the paths the evaluation pools actually
 *   carry — consuming the prefix for an ANCESTOR base, prepending it for a
 *   NESTED one. A cwd rule (`base === cwd`) is NOT touched — the rebase returns
 *   the identical array, and the whole rule object is returned as-is.
 * - `relativePath` is derived from the rule's OWN rules directory. The pipeline
 *   can only derive it for `<cwd>/.pi/rules` (it knows just cwd's rules root),
 *   so an ancestor or nested on-demand rule would otherwise be indexed with no
 *   fetchable reference and `read_rule` would answer "Unknown rule". Cwd rules
 *   keep today's shape: absent here, derived by the pipeline exactly as before,
 *   so their bytes do not move.
 */
const finalizeProjectRule = (rule: Rule, entry: ProjectRuleDir, cwd: string): Rule => {
	if (normalizedPath(entry.base) === normalizedPath(cwd) && rule.relativePath === undefined) {
		return rule;
	}
	const globs = rule.globs === undefined ? undefined : rebaseRuleGlobs(rule.globs, entry.base, cwd);
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
 * Rule parser seam: raw text plus the discovery-resolved identity in, a {@link Rule}
 * out. Native rules parse through `src/frontmatter.ts` (strict, source-carrying);
 * imported rules adapt through their format's LENIENT adapter and materialize the
 * fixed importer contract (shell/importers). The id is always the one discovery
 * resolved in the shared namespace — never the parser's own idea of identity.
 */
type RuleParser = (raw: string, abs: NormalizedPath, id: string) => Result<Rule, RuleError>;

/** Strict native parser for one source: `parseRule` plus discovery's resolved id. */
const nativeRuleParser = (source: RuleSource): RuleParser => (raw, abs, id) => {
	const parsed = parseRule(raw, { path: abs, source });
	return parsed.ok ? ok({ ...parsed.value, id: ruleId(id) }) : parsed;
};

/**
 * Lenient importer parser for one (importer, root) pair: the adapter owns every
 * format decision, and the materialized rule carries the importer-root-relative
 * reference path (`foo.instructions.md`) plus the shared-namespace id.
 */
const importedRuleParser =
	(importer: Importer, dir: NormalizedPath): RuleParser =>
	(raw, abs, id) => {
		const adapted = importer.adapter({ path: abs, text: raw });
		if (!adapted.ok) {
			return adapted;
		}
		const prefix = `${dir}/`;
		const relative = abs.startsWith(prefix) ? abs.slice(prefix.length) : fileNameOf(abs);
		return ok(
			materializeImportedRule(adapted.value, { path: abs, id: ruleId(id), relativePath: normalizedPath(relative) }),
		);
	};

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
 *
 * The `parse` seam is what keeps native and imported rules on one caching path:
 * both produce a {@link Rule} (or a typed error) with discovery's resolved id,
 * so importer files get exactly the same mtime reuse, id-refresh, and
 * vanished-file semantics as `.pi/rules` files.
 */
const loadRule = async (
	deps: DiscoveryDeps,
	cache: DiscoveryCache,
	nextCache: Map<NormalizedPath, DiscoveryCacheEntry>,
	abs: NormalizedPath,
	id: string,
	parse: RuleParser,
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
	const parsed = parse(raw, abs, id);
	if (!parsed.ok) {
		nextCache.set(abs, { mtimeMs: statResult.mtimeMs, error: parsed.error });
		return { kind: "error", error: parsed.error };
	}
	// Discovery owns the id (disambiguation namespace); the parser seam already
	// materialized it, so the rule is stored as produced.
	const rule: Rule = parsed.value;
	nextCache.set(abs, { mtimeMs: statResult.mtimeMs, rule });
	return { kind: "rule", rule };
};

/**
 * Runs the nested-directory enumeration, converting a rejection into one
 * `source-unreadable` error naming cwd (S10 nested half). Total: a broken
 * enumeration loses the nested sources for that pass but never the walk-up
 * sources, the global source, or the session — and it is honest, because a
 * failed enumeration is not evidence that no nested rules exist.
 *
 * Not cached (S13 caches `listRuleFiles` failures only): the enumeration result
 * feeds the walk-up list itself, so a cached failure would have to cache a
 * directory list too, and the seam is one bounded glob per pass.
 */
const enumerateNested = async (
	deps: DiscoveryDeps,
	cwd: string,
	errors: RuleError[],
): Promise<readonly string[]> => {
	try {
		return await deps.listNestedRuleDirs(cwd);
	} catch (cause) {
		errors.push({
			code: "source-unreadable",
			message: `failed to enumerate nested rules sources: ${cause instanceof Error ? cause.message : String(cause)}`,
			file: normalizedPath(cwd),
		});
		return [];
	}
};

/**
 * Directory mtime for the unreadable-source cache, or `undefined` when the
 * directory cannot be stat-ed (permissions, race, wrong type) — the same
 * ENOENT-agnostic total read the file path uses for its baseline.
 */
const sourceMtime = async (deps: DiscoveryDeps, dir: NormalizedPath): Promise<number | undefined> => {
	try {
		return (await deps.stat(dir)).mtimeMs;
	} catch {
		return undefined;
	}
};

/**
 * Whether a cached unreadable-source outcome must be re-attempted (S13). A
 * directory has no file mtime to key on, so it is keyed on its OWN mtime:
 *
 * - a KNOWN baseline (the directory was stat-able at the failure) is stale only
 *   when the directory's mtime changed — recovery is observed on the next pass
 *   after the directory changes, and a directory that never changes is never
 *   listed again;
 * - no baseline (`UNKNOWN_SOURCE_MTIME`) is stale as soon as the directory
 *   becomes stat-able at all: a stat that starts working IS the evidence of
 *   change, so the source is re-attempted and then keeps the new baseline;
 * - a directory that cannot be stat-ed now keeps the cached outcome: a failed
 *   stat is not evidence of recovery.
 *
 * No TTL and no retry counter: the invalidation signal is the directory's own
 * mtime, and the cost of a wrong guess is one extra listing, never a lost rule.
 */
const sourceCacheStale = (cachedMtimeMs: number, currentMtimeMs: number | undefined): boolean => {
	if (cachedMtimeMs === UNKNOWN_SOURCE_MTIME) {
		return currentMtimeMs !== undefined;
	}
	if (currentMtimeMs === undefined) {
		return false;
	}
	return currentMtimeMs !== cachedMtimeMs;
};

/**
 * Discovers rules from the project (first, when trusted) and global
 * directories. Pure orchestration over the injected deps: the input cache
 * is never mutated, and the fresh next cache covers exactly the files still
 * listed. Callers start with an empty cache (`new Map()`).
 *
 * Monorepo (S10): every project directory in `opts.projectDirs` is one pass
 * segment, in the caller's order (cwd first, then ancestors up to the git
 * root). All of them contribute `source: "project"`, all of them share ONE id
 * namespace (so the stem+suffix contract holds across directories), and all of
 * them come before global. Rebased rules (ancestor or nested) have their globs
 * re-expressed onto the cwd/absolute scales (shell/match.ts) and get the
 * rules-dir-relative `relativePath` the pipeline can only derive for cwd rules;
 * a rule whose base IS cwd is returned untouched, so today's single-directory
 * output is byte-identical.
 *
 * Nested half: when the project is trusted, discovery ENUMERATES `.pi/rules`
 * dirs below cwd (`deps.listNestedRuleDirs`) and appends the filtered, sorted
 * result after the walk-up list and before global. An untrusted project is
 * never enumerated at all, and a project with no nested rules pays only the
 * enumeration glob — the pass itself is unchanged.
 *
 * Importer half (S11): for a trusted project, each configured importer lists
 * `<cwd>/<importer.dir>` and adapts the files carrying its suffix. The segment
 * runs after the nested dirs and before global, joins the SAME id namespace,
 * and materializes the importer contract (version 1, touched matching, pinned
 * loading, inform enforcement, project source). No configured importer means no
 * importer root is listed at all.
 */
export const discover = async (
	deps: DiscoveryDeps,
	cache: DiscoveryCache,
	opts: DiscoveryOptions,
): Promise<DiscoveryResult> => {
	const rules: Rule[] = [];
	const errors: RuleError[] = [];
	const nextCache = new Map<NormalizedPath, DiscoveryCacheEntry>();
	// Project first so the selection pipeline's content-tie dedupe prefers
	// project rules; the trust gate drops every project source at once AND skips
	// the nested enumeration, so an untrusted tree is never even globbed.
	const projectDirs: readonly ProjectRuleDir[] = opts.isProjectTrusted
		? [...opts.projectDirs, ...nestedProjectRuleDirs(opts.cwd, await enumerateNested(deps, opts.cwd, errors))]
		: [];
	// Shared across the merged pass so ids stay unique project-wide + global-wide.
	const usedIds = new Set<string>();

	/**
	 * Loads one pass segment: list → filter → sort → assign shared ids → load
	 * each file through its parser seam (stat/cache/read live in `loadRule`).
	 * A rejected listing contributes one `source-unreadable` error and nothing
	 * else, exactly like the pre-importer sources.
	 *
	 * Unreadable-source cache (S13): a directory whose listing rejected is cached
	 * as ONE directory entry holding that error. A later pass re-reports the
	 * cached error (so `/rules` output is unchanged) WITHOUT calling
	 * `listRuleFiles` again, until `sourceCacheStale` says the directory may have
	 * changed. Sources are keyed independently, so an unreadable project never
	 * affects the global source (or any other importer/walk-up segment). A
	 * successful listing leaves no directory entry behind — only file entries,
	 * exactly as before.
	 */
	const loadSegment = async (
		dir: string,
		entry: ProjectRuleDir | undefined,
		accept: (abs: NormalizedPath) => boolean,
		stemOf: (abs: NormalizedPath) => string,
		parserOf: (abs: NormalizedPath) => RuleParser,
	): Promise<void> => {
		const sourceKey = normalizedPath(dir);
		// One directory stat per segment at most: the re-attempt path needs the
		// mtime both to decide and (on another failure) to re-baseline.
		let probedMtime: { readonly value: number | undefined } | undefined;
		const probeMtime = async (): Promise<number | undefined> => {
			probedMtime ??= { value: await sourceMtime(deps, sourceKey) };
			return probedMtime.value;
		};
		const cachedEntry = cache.get(sourceKey);
		const cachedSource = cachedEntry?.sourceUnreadable;
		if (cachedEntry !== undefined && cachedSource !== undefined) {
			// A previous pass could not read this directory. Only the directory's own
			// mtime (or a stat that starts working) says it is worth a second look.
			if (!sourceCacheStale(cachedEntry.mtimeMs, await probeMtime())) {
				errors.push(cachedSource);
				nextCache.set(sourceKey, cachedEntry);
				return;
			}
		}
		let listed: readonly string[];
		try {
			listed = await deps.listRuleFiles(dir);
		} catch (cause) {
			// Totality: one unreadable source never fails the pass — it
			// contributes nothing and the remaining sources continue.
			const error: RuleError = {
				code: "source-unreadable",
				message: `failed to list rules source: ${cause instanceof Error ? cause.message : String(cause)}`,
				file: dir,
			};
			const dirMtime = await probeMtime();
			nextCache.set(sourceKey, { mtimeMs: dirMtime ?? UNKNOWN_SOURCE_MTIME, sourceUnreadable: error });
			errors.push(error);
			return;
		}
		const paths = listed.map((name) => resolveListed(dir, name)).filter(accept).sort();
		const ids = assignSourceIds(paths, usedIds, stemOf);
		for (const abs of paths) {
			const id = ids.get(abs) ?? stemOf(abs);
			const loaded = await loadRule(deps, cache, nextCache, abs, id, parserOf(abs));
			if (loaded.kind === "rule") {
				rules.push(entry === undefined ? loaded.rule : finalizeProjectRule(loaded.rule, entry, opts.cwd));
			} else if (loaded.kind === "error") {
				errors.push(loaded.error);
			}
		}
	};

	for (const entry of projectDirs) {
		await loadSegment(entry.dir, entry, isRuleFile, fileStem, () => nativeRuleParser("project"));
	}
	// Importers (S11): AFTER the nested dirs, BEFORE global, behind the same
	// trust gate (an untrusted project lists no importer root at all). The rule
	// base is cwd — imports author their globs against the project root — so the
	// rebase is the identity and nothing is prepended for a root below cwd.
	if (opts.isProjectTrusted) {
		for (const importer of opts.importers ?? []) {
			const dir = importerRootDir(opts.cwd, importer);
			if (dir === undefined) {
				continue;
			}
			await loadSegment(
				dir,
				{ dir, base: opts.cwd },
				(abs) => importerFileStem(abs, importer) !== undefined,
				(abs) => importerFileStem(abs, importer) ?? fileStem(abs),
				() => importedRuleParser(importer, dir),
			);
		}
	}
	await loadSegment(opts.globalDir, undefined, isRuleFile, fileStem, () => nativeRuleParser("global"));
	return { rules, errors, cache: nextCache };
};

/**
 * Production deps: node:fs/promises stat/read, a tinyglobby listing (recursive
 * md glob, relative to the directory) that resolves a missing directory (ENOENT)
 * to an empty result — discovery then contributes nothing for that source
 * instead of failing — and the nested-directory enumeration.
 *
 * The enumeration is one bounded glob for `**\/.pi\/rules` below cwd:
 * - `dot: true` so `.pi` is visible at all; `onlyDirectories` so only rule
 *   directories come back (with a trailing separator, stripped here);
 * - `deep: MAX_NESTED_RULES_DIR_DEPTH + 1`: a rule base `d` segments below cwd
 *   sits at depth `d + 2` (its `.pi` and `rules` dirs) and tinyglobby admits an
 *   entry when `deep` is at least one less than its depth, so this crawls
 *   exactly to the documented bound and one level deeper is never enumerated;
 * - `.git/**` and `node_modules/**` ignored at EVERY depth (both the bare and
 *   the `**\/` form, matching `tinyglobbyScanner`'s pinned ignore policy);
 * - `followSymbolicLinks: false`, so a symlinked subtree is never crawled: a
 *   link pointing outside the project must not become a rule source;
 * - a missing cwd (ENOENT) resolves to `[]`, like a missing rules dir.
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
	listNestedRuleDirs: async (cwd) => {
		let found: readonly string[];
		try {
			found = await glob(["**/.pi/rules"], {
				cwd,
				dot: true,
				onlyDirectories: true,
				onlyFiles: false,
				deep: MAX_NESTED_RULES_DIR_DEPTH + 1,
				followSymbolicLinks: false,
				ignore: [".git/**", "**/.git/**", "node_modules/**", "**/node_modules/**"],
			});
		} catch (cause) {
			if (isEnoent(cause)) {
				return [];
			}
			throw cause;
		}
		// Results are relative to cwd with a trailing separator; discovery filters
		// them again (`nestedProjectRuleDirs`), so nothing here can widen the read set.
		const root = normalizedPath(cwd).replace(/\/+$/, "");
		return found.map((name) => normalizedPath(`${root}/${name.replace(/\/+$/, "")}`));
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
