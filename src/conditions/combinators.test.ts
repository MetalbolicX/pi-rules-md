import { describe, expect, it } from "vitest";
import { and, anyOf, not } from "./combinators.ts";
import type { Predicate } from "./combinators.ts";

const value = "x";
const yes: Predicate<string> = () => true;
const no: Predicate<string> = () => false;

describe("and", () => {
	it("returns true for an empty predicate list (vacuous truth)", () => {
		expect(and<string>([])(value)).toBe(true);
	});

	it("returns true when every predicate passes", () => {
		expect(and([yes, yes, yes])(value)).toBe(true);
	});

	it("returns false when any predicate fails", () => {
		expect(and([yes, no, yes])(value)).toBe(false);
	});

	it("returns false for a single failing predicate", () => {
		expect(and([no])(value)).toBe(false);
	});
});

describe("anyOf", () => {
	it("returns false for an empty predicate list", () => {
		expect(anyOf<string>([])(value)).toBe(false);
	});

	it("returns true when at least one predicate passes", () => {
		expect(anyOf([no, yes])(value)).toBe(true);
	});

	it("returns false when every predicate fails", () => {
		expect(anyOf([no, no])(value)).toBe(false);
	});
});

describe("not", () => {
	it("negates its predicate", () => {
		expect(not(yes)(value)).toBe(false);
		expect(not(no)(value)).toBe(true);
	});
});

describe("composition law: not(and([p1, p2])) truth table", () => {
	const cases: readonly (readonly [Predicate<string>, Predicate<string>, boolean])[] = [
		[yes, yes, false],
		[yes, no, true],
		[no, yes, true],
		[no, no, true],
	];
	for (const [p1, p2, expected] of cases) {
		const name1 = p1 === yes ? "yes" : "no";
		const name2 = p2 === yes ? "yes" : "no";
		it(`not(and([${name1}, ${name2}])) is ${String(expected)}`, () => {
			expect(not(and([p1, p2]))(value)).toBe(expected);
		});
	}
});

describe("generic input", () => {
	it("composes predicates over a non-string input type", () => {
		const positive: Predicate<number> = (n) => n > 0;
		const underTen: Predicate<number> = (n) => n < 10;
		expect(and([positive, underTen])(5)).toBe(true);
		expect(and([positive, underTen])(50)).toBe(false);
		expect(anyOf([positive, underTen])(50)).toBe(true);
		expect(not(positive)(-1)).toBe(true);
	});
});
