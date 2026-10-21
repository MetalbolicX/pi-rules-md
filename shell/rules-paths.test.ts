import { describe, expect, it } from "vitest";
import { globalRulesDir, projectRulesDir, resolveAttach, resolveBudget } from "./rules-paths.ts";

describe("rules paths", () => {
	it("normalizes global rules directories on Windows", () => {
		expect(globalRulesDir("C:\\Users\\x")).toBe("C:/Users/x/.pi/agent/rules");
	});

	it("builds global rules directories on POSIX", () => {
		expect(globalRulesDir("/home/x")).toBe("/home/x/.pi/agent/rules");
	});

	it("builds project rules directories", () => {
		expect(projectRulesDir("/proj")).toBe("/proj/.pi/rules");
	});

	it.each([
		["3000", 2000, 3000],
		[undefined, 2000, 2000],
		["abc", 2000, 2000],
		["-5", 2000, 2000],
		["0", 2000, 2000],
	])("resolves budget %s", (raw, fallback, expected) => {
		expect(resolveBudget(raw, fallback)).toBe(expected);
	});
});

describe("resolveAttach", () => {
	// S9/D3: mid-run attachment is ON unless the value is exactly `off`.
	// Mirroring resolveBudget, an absent or unrecognized value keeps the default.
	it.each([
		["off", false],
		["OFF", false],
		[" off ", false],
		[undefined, true],
		["", true],
		["on", true],
		["true", true],
		["false", true],
		["0", true],
		["disable", true],
	])("resolves attachment toggle %s", (raw, expected) => {
		expect(resolveAttach(raw)).toBe(expected);
	});
});
