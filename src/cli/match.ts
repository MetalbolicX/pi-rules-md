import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PACKAGE_NAME } from "./constants.js";
import type { PackageEntry } from "./settings.js";

export interface MatchingEntry {
  entry: PackageEntry;
  source: string;
  kind: "npm" | "npm-pinned" | "git" | "local";
  version?: string;
  canonicalPath?: string;
}

export interface MatchResult {
  matches: MatchingEntry[];
  unmatchedLocal: PackageEntry[];
  duplicates: Map<string, MatchingEntry[]>;
}

export async function findMatchingEntries(
  packages: PackageEntry[],
  opts: { settingsDir: string },
): Promise<MatchResult> {
  const matches: MatchingEntry[] = [];
  const unmatchedLocal: PackageEntry[] = [];

  for (const entry of packages) {
    if (entry.kind === "malformed") continue;
    const { source } = entry;
    if (source.startsWith("npm:")) {
      const spec = source.slice("npm:".length);
      if (spec === PACKAGE_NAME) {
        matches.push({ entry, source, kind: "npm" });
      } else if (spec.startsWith(`${PACKAGE_NAME}@`) && isVersion(spec.slice(PACKAGE_NAME.length + 1))) {
        matches.push({ entry, source, kind: "npm-pinned", version: spec.slice(PACKAGE_NAME.length + 1) });
      }
      continue;
    }
    if (source.startsWith("git:")) {
      const repo = source.slice("git:".length).split(/[?#]/, 1)[0] ?? "";
      const basename = path.posix.basename(repo.replace(/\\/g, "/")).replace(/\.git$/i, "");
      if (basename === PACKAGE_NAME) matches.push({ entry, source, kind: "git" });
      continue;
    }

    const expanded = source.startsWith("~")
      ? path.join(homedir(), source.slice(1).replace(/^[/\\]/, ""))
      : source;
    const target = path.resolve(path.isAbsolute(expanded) ? expanded : path.join(opts.settingsDir, expanded));
    try {
      const canonicalPath = await realpath(target);
      const metadata: unknown = JSON.parse(await readFile(path.join(canonicalPath, "package.json"), "utf8"));
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata)
        && (metadata as { name?: unknown }).name === PACKAGE_NAME) {
        matches.push({ entry, source, kind: "local", canonicalPath });
      } else {
        unmatchedLocal.push(entry);
      }
    } catch {
      unmatchedLocal.push(entry);
    }
  }

  const groups = new Map<string, MatchingEntry[]>();
  for (const match of matches) {
    if (!match.canonicalPath) continue;
    groups.set(match.canonicalPath, [...(groups.get(match.canonicalPath) ?? []), match]);
  }
  const duplicates = new Map([...groups].filter(([, group]) => group.length > 1));
  return { matches, unmatchedLocal, duplicates };
}

function isVersion(version: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}
