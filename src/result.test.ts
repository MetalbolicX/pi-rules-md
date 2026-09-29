import { describe, expect, expectTypeOf, it } from "vitest";
import { err, ok, type Result } from "./result.ts";

describe("constructors", () => {
	it("ok wraps a value", () => {
		expect(ok(42)).toEqual({ ok: true, value: 42 });
	});

	it("err wraps an error", () => {
		expect(err("boom")).toEqual({ ok: false, error: "boom" });
	});

	it("data stays plain (no methods, no class instances)", () => {
		const r: Result<number, string> = ok(1);
		expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
	});

	it("the union narrows on the ok discriminant", () => {
		const r: Result<number, string> = err("boom");
		if (!r.ok) {
			expectTypeOf(r.error).toEqualTypeOf<string>();
			expect(r.error).toBe("boom");
		} else {
			throw new Error("expected err");
		}
	});
});
