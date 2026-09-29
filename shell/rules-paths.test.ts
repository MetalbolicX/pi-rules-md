import { describe, expect, it } from "vitest";
import { globalRulesDir, projectRulesDir, resolveBudget } from "./rules-paths.ts";

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
