/**
 * Hand-rolled Result<T, E> — the error-handling backbone of the functional
 * core. The union is plain readonly data; core code pattern-matches on the
 * `ok` discriminant directly instead of calling combinators. No methods, no
 * classes.
 *
 * Conventions:
 * - `T` is the success value type, `E` the typed error value.
 */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** Wraps a success value into `Result<T, never>`. */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** Wraps an error value into `Result<never, E>`. */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
