/**
 * Property tests for section rendering (rule format v1).
 *
 * Byte-stability invariants over generated render entries, 200 cases, fixed
 * seeds:
 * - equal input renders byte-identical content (twice-rendered entries are
 *   string-identical, hashes included);
 * - contentHash equals iff content equals (observed both directions: same
 *   input → same hash; genuinely different content → different hash);
 * - the empty entry list renders undefined; a non-empty render carries the
 *   fixed section id, the `# Rules` header, and exactly one trailing newline.
 *
 * Deterministic via the seeded harness; no I/O, no clocks.
 */
import { describe, expect, it } from "vitest";
import { renderSection, sectionId } from "../../src/render.ts";
import type { RenderEntry } from "../../src/render.ts";
import { randomReasons, randomRule, times } from "./support/generators.ts";
import { createSeeded } from "./support/seeded.ts";

const CASES = 200;

describe("renderSection — byte stability (property)", () => {
	it(`renders equal input byte-identically across ${CASES} generated entry lists`, () => {
		const rng = createSeeded(0x52454e44);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const entries: readonly RenderEntry[] = times(rng.int(0, 5), (index) => ({
				rule: randomRule(rng, index),
				reasons: randomReasons(rng),
			}));
			const first = renderSection(entries);
			const second = renderSection(entries);
			const context = `case ${caseIndex}`;

			if (entries.length === 0) {
				expect(first, `${context}: empty input renders nothing`).toBeUndefined();
				expect(second).toBeUndefined();
				continue;
			}
			expect(first, context).toBeDefined();
			expect(second, context).toBeDefined();
			if (first === undefined || second === undefined) {
				continue;
			}
			expect(first.sectionId, context).toBe(sectionId);
			expect(first.content, `${context}: byte-identical content`).toBe(second.content);
			expect(first.contentHash, `${context}: identical hash for identical content`).toBe(second.contentHash);
			expect(first.content.startsWith("# Rules\n\n"), context).toBe(true);
			expect(first.content.endsWith("\n"), `${context}: exactly one trailing newline`).toBe(true);
			expect(first.content.endsWith("\n\n"), context).toBe(false);
		}
	});

	it(`keeps contentHash equal iff content is equal across ${CASES} generated pairs`, () => {
		const rng = createSeeded(0x48415348);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const buildEntries = (): readonly RenderEntry[] =>
				times(rng.int(1, 5), (index) => ({
					rule: randomRule(rng, index),
					reasons: randomReasons(rng),
				}));
			const firstBlock = renderSection(buildEntries());
			const secondBlock = renderSection(buildEntries());
			const context = `case ${caseIndex}`;
			expect(firstBlock, context).toBeDefined();
			expect(secondBlock, context).toBeDefined();
			if (firstBlock === undefined || secondBlock === undefined) {
				continue;
			}
			const contentEqual = firstBlock.content === secondBlock.content;
			const hashEqual = firstBlock.contentHash === secondBlock.contentHash;
			// Equal content must hash equal (deterministic hashing); different
			// content must hash differently (no observed collisions).
			if (contentEqual) {
				expect(hashEqual, context).toBe(true);
			} else {
				expect(hashEqual, `${context}: distinct content, distinct hash`).toBe(false);
			}
		}
	});
});
