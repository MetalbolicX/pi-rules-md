import { describe, expect, test } from "vitest";
import { compareSemver, fetchLatestVersion, isStale, parseSemver } from "./registry.ts";

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const fetchWith = (result: Response | Promise<Response>): typeof fetch => (async () => result) as typeof fetch;

describe("fetchLatestVersion", () => {
  test("returns the registry version from a successful response", async () => {
    await expect(fetchLatestVersion(fetchWith(response(200, { version: "1.2.3" })))).resolves.toBe("1.2.3");
  });

  test("returns null for a non-OK response", async () => {
    await expect(fetchLatestVersion(fetchWith(response(503, { version: "1.2.3" })))).resolves.toBeNull();
  });

  test("returns null for malformed body and missing version", async () => {
    await expect(fetchLatestVersion(fetchWith(response(200, null)))).resolves.toBeNull();
    await expect(fetchLatestVersion(fetchWith(response(200, {})))).resolves.toBeNull();
  });

  test("rejects build metadata but accepts prerelease versions", async () => {
    await expect(fetchLatestVersion(fetchWith(response(200, { version: "1.2.3+build.4" })))).resolves.toBeNull();
    await expect(fetchLatestVersion(fetchWith(response(200, { version: "1.2.3-rc.1" })))).resolves.toBe("1.2.3-rc.1");
  });

  test("times out a hanging fetch", async () => {
    const hanging = (() => new Promise<Response>(() => {})) as typeof fetch;
    await expect(fetchLatestVersion(hanging, 20)).resolves.toBeNull();
  });

  test("times out a hanging response body read", async () => {
    const hangingBody = { ok: true, json: () => new Promise<never>(() => {}) } as unknown as Response;
    await expect(fetchLatestVersion(fetchWith(hangingBody), 20)).resolves.toBeNull();
  });
});

describe("semver comparison", () => {
  test.each([
    ["1.2.3", { major: 1, minor: 2, patch: 3 }],
    ["0.0.0-alpha", { major: 0, minor: 0, patch: 0 }],
    ["01.2.3", null],
    ["1.2", null],
    ["1.2.3+build", null],
  ] as const)("parseSemver(%s)", (version, expected) => {
    expect(parseSemver(version)).toEqual(expected);
  });

  test.each([
    ["1.2.4", "1.2.3", 1],
    ["1.2.3", "1.2.4", -1],
    ["1.2.3-alpha", "1.2.3", 0],
    ["bad", "1.2.3", null],
  ] as const)("compareSemver(%s, %s)", (a, b, expected) => {
    expect(compareSemver(a, b)).toBe(expected);
  });

  test.each([
    ["1.2.4", "1.2.3", true],
    ["1.2.3", "1.2.3", false],
    ["invalid", "1.2.3", false],
    ["1.2.4", "invalid", false],
  ] as const)("isStale(%s, %s)", (latest, installed, expected) => {
    expect(isStale(installed, latest)).toBe(expected);
  });
});
