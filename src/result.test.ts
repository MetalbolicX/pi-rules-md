import { describe, expect, expectTypeOf, it } from "vitest";
import {
	andThen,
	err,
	isErr,
	isOk,
	map,
	mapErr,
	match,
	ok,
	orElse,
	unwrapOr,
	unwrapOrThrow,
	type Result,
} from "./result.ts";

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
});

describe("guards", () => {
	it("isOk narrows to the ok variant", () => {
		const r: Result<number, string> = ok(1);
		if (isOk(r)) {
			expectTypeOf(r.value).toEqualTypeOf<number>();
			expect(r.value).toBe(1);
		} else {
			throw new Error("expected ok");
		}
	});

	it("isErr narrows to the err variant", () => {
		const r: Result<number, string> = err("nope");
		if (isErr(r)) {
			expectTypeOf(r.error).toEqualTypeOf<string>();
			expect(r.error).toBe("nope");
		} else {
			throw new Error("expected err");
		}
	});
});

describe("map", () => {
	it("transforms the value of ok", () => {
		expect(map(ok(2), (n) => n * 10)).toEqual({ ok: true, value: 20 });
	});

	it("passes err through untouched", () => {
		expect(map(err("e"), (n: number) => n * 10)).toEqual({ ok: false, error: "e" });
	});

	it("changes only the value type", () => {
		const r: Result<number, string> = ok(1);
		expectTypeOf(map(r, (n) => `${n}`)).toEqualTypeOf<Result<string, string>>();
	});
});

describe("mapErr", () => {
	it("transforms the error of err", () => {
		expect(mapErr(err("e"), (e) => new Error(e))).toEqual({
			ok: false,
			error: new Error("e"),
		});
	});

	it("passes ok through untouched", () => {
		expect(mapErr(ok(3), (e: string) => new Error(e))).toEqual({ ok: true, value: 3 });
	});
});

describe("andThen", () => {
	const parsePositive = (s: string): Result<number, string> => {
		const n = Number(s);
		return Number.isFinite(n) && n > 0 ? ok(n) : err(`not positive: ${s}`);
	};

	it("chains ok into ok", () => {
		expect(andThen(ok("3"), parsePositive)).toEqual({ ok: true, value: 3 });
	});

	it("short-circuits when the chain produces err", () => {
		expect(andThen(ok("-1"), parsePositive)).toEqual({ ok: false, error: "not positive: -1" });
	});

	it("short-circuits on an already-err input without calling the function", () => {
		let called = false;
		const result = andThen(err("early") as Result<string, string>, (s) => {
			called = true;
			return parsePositive(s);
		});
		expect(result).toEqual({ ok: false, error: "early" });
		expect(called).toBe(false);
	});
});

describe("orElse", () => {
	const recover = (e: string): Result<number, string> => (e === "retry" ? ok(7) : err(e));

	it("recovers an err into ok", () => {
		expect(orElse(err("retry"), recover)).toEqual({ ok: true, value: 7 });
	});

	it("propagates a failed recovery", () => {
		expect(orElse(err("fatal"), recover)).toEqual({ ok: false, error: "fatal" });
	});

	it("leaves ok untouched", () => {
		expect(orElse(ok(1) as Result<number, string>, recover)).toEqual({ ok: true, value: 1 });
	});
});

describe("match", () => {
	it("runs the ok arm", () => {
		const r: Result<number, string> = ok(2);
		expect(
			match(r, {
				ok: (v) => `value ${v}`,
				err: (e) => `error ${e}`,
			}),
		).toBe("value 2");
	});

	it("runs the err arm", () => {
		const r: Result<number, string> = err("bad");
		expect(
			match(r, {
				ok: (v) => `value ${v}`,
				err: (e) => `error ${e}`,
			}),
		).toBe("error bad");
	});
});

describe("unwrapOr", () => {
	it("returns the value for ok", () => {
		expect(unwrapOr(ok(5), 0)).toBe(5);
	});

	it("returns the fallback for err", () => {
		expect(unwrapOr(err("e") as Result<number, string>, 0)).toBe(0);
	});
});

describe("unwrapOrThrow", () => {
	it("returns the value for ok", () => {
		expect(unwrapOrThrow(ok(9))).toBe(9);
	});

	it("throws an Error wrapping a non-Error err value", () => {
		expect(() => unwrapOrThrow(err("boom"))).toThrowError("boom");
	});

	it("throws the mapped error when a mapper is given", () => {
		const custom = new RangeError("custom");
		expect(() => unwrapOrThrow(err("boom"), () => custom)).toThrowError(custom);
	});
});
