import { PACKAGE_NAME } from "./constants.js";

export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export async function fetchLatestVersion(fetchImpl: typeof fetch = fetch, timeoutMs = 3000): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const request = (async (): Promise<string | null> => {
    const response = await fetchImpl(REGISTRY_LATEST_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const { version } = body as { version?: unknown };
    return typeof version === "string" && VERSION_PATTERN.test(version) ? version : null;
  })();
  try {
    return await Promise.race([request.catch(() => null), timeout]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface SemverCore {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(version: string): SemverCore | null {
  if (!VERSION_PATTERN.test(version)) return null;
  const [core] = version.split("-");
  const parts = core?.split(".").map(Number);
  if (!parts || parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part))) return null;
  return { major: parts[0]!, minor: parts[1]!, patch: parts[2]! };
}

export function compareSemver(a: string | null | undefined, b: string | null | undefined): number | null {
  if (a == null || b == null) return null;
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function isStale(installed: string | null | undefined, latest: string | null | undefined): boolean {
  const comparison = compareSemver(latest, installed);
  return comparison !== null && comparison > 0;
}
