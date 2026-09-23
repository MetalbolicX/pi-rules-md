/**
 * Generic boolean combinators over unary predicates.
 *
 * Pure and side-effect free: predicates are only called, never mutated, and
 * results derive solely from their inputs. They are generic over the input
 * type `A`, so the same combinators serve both `EvaluationContext` predicates
 * (predicates.ts) and path matchers (globMatcher consumers).
 *
 * Empty-list semantics are fixed and pinned by tests:
 * - `and([])` is true (vacuous truth — no predicate can fail),
 * - `anyOf([])` is false (no predicate can pass).
 */

/** A pure unary predicate over a value of type `A`. */
export type Predicate<A> = (a: A) => boolean;

/** True when every predicate passes; true for an empty list (vacuous truth). */
export const and = <A>(preds: readonly Predicate<A>[]): Predicate<A> => (a) => preds.every((pred) => pred(a));

/** True when at least one predicate passes; false for an empty list. */
export const anyOf = <A>(preds: readonly Predicate<A>[]): Predicate<A> => (a) => preds.some((pred) => pred(a));

/** Negation of a single predicate. */
export const not = <A>(pred: Predicate<A>): Predicate<A> => (a) => !pred(a);
