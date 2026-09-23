/**
 * Hand-rolled Result<T, E> — the error-handling backbone of the functional
 * core. The union is plain readonly data; all behavior lives in pure module
 * functions. No methods, no classes.
 *
 * Conventions:
 * - `T` is the success value type, `E` the typed error value.
 * - Combinators short-circuit: `map`/`andThen` skip on err, `orElse` skips on ok.
 * - `unwrapOrThrow` is a test/edge convenience; core code pattern-matches instead.
 */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** Wraps a success value into `Result<T, never>`. */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** Wraps an error value into `Result<never, E>`. */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Type-narrowing guard for the ok variant. */
export const isOk = <T, E>(result: Result<T, E>): result is { readonly ok: true; readonly value: T } => result.ok;

/** Type-narrowing guard for the err variant. */
export const isErr = <T, E>(result: Result<T, E>): result is { readonly ok: false; readonly error: E } => !result.ok;

/** Transforms the success value; passes an err through untouched. */
export const map = <T, U, E>(result: Result<T, E>, f: (value: T) => U): Result<U, E> =>
	result.ok ? ok(f(result.value)) : result;

/** Transforms the error value; passes an ok through untouched. */
export const mapErr = <T, E, F>(result: Result<T, E>, f: (error: E) => F): Result<T, F> =>
	result.ok ? result : err(f(result.error));

/** Flat-map: chains a fallible step onto the success value; short-circuits on err. */
export const andThen = <T, U, E, F>(result: Result<T, E>, f: (value: T) => Result<U, F>): Result<U, E | F> =>
	result.ok ? f(result.value) : result;

/** Flat-map on the error side: attempts recovery; short-circuits on ok. */
export const orElse = <T, E, F, U>(result: Result<T, E>, f: (error: E) => Result<U, F>): Result<T | U, F> =>
	result.ok ? result : f(result.error);

/** Extracts the success value, returning `fallback` when the result is err. */
export const unwrapOr = <T, E>(result: Result<T, E>, fallback: T): T => (result.ok ? result.value : fallback);

/** Exhaustive pattern match with an arm per variant. */
export const match = <T, E, A>(result: Result<T, E>, arms: { ok: (value: T) => A; err: (error: E) => A }): A =>
	result.ok ? arms.ok(result.value) : arms.err(result.error);

const toErrorValue = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/**
 * Extracts the success value or throws. Intended for tests and shell edges;
 * core code uses `match`/`unwrapOr` instead. `toError` maps a typed err value
 * onto a thrown `Error` (defaults to wrapping non-Error values).
 */
export const unwrapOrThrow = <T, E>(result: Result<T, E>, toError: (error: E) => Error = toErrorValue): T => {
	if (result.ok) {
		return result.value;
	}
	throw toError(result.error);
};
