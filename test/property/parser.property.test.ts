/**
 * Property tests for the strict frontmatter parser (rule format v1).
 *
 * Two families over generated documents, 200 cases each, fixed seeds:
 * - VALID documents parse ok and roundtrip every key field (description,
 *   optional lists/scalars, materialized defaults, verbatim body).
 * - INVALID documents (exactly one injected defect) are rejected with the
 *   PINNED error code, and rejection is stable: parsing the same text twice
 *   yields deep-equal errors — same input, same code, same message.
 *
 * Deterministic: the seeded harness drives all generation; no clocks, no
 * Math.random, no shrink (see ./support/seeded.ts for that decision).
 */
import { describe, expect, it } from "vitest";
import { parseRule } from "../../src/frontmatter.ts";
import type { RuleMeta } from "../../src/frontmatter.ts";
import { normalizedPath } from "../../src/types.ts";
import { emitDoc, generateInvalidDoc, generateValidDoc } from "./support/generators.ts";
import { createSeeded } from "./support/seeded.ts";

const META: RuleMeta = { path: normalizedPath("rules/generated.md"), source: "project" };
const CASES = 200;

describe("parseRule — generated valid documents (property)", () => {
	it(`parses and roundtrips key fields for ${CASES} generated valid documents`, () => {
		const rng = createSeeded(0x50415253);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const doc = generateValidDoc(rng);
			const result = parseRule(emitDoc(doc), META);
			const context = `case ${caseIndex}`;
			expect(result.ok, `${context}: should parse\n${emitDoc(doc)}`).toBe(true);
			if (!result.ok) {
				continue;
			}
			const rule = result.value;
			expect(rule.id, context).toBe(`project:${META.path}`);
			expect(rule.description, context).toBe(doc.description);
			expect(rule.version, context).toBe(1);
			expect(rule.priority, context).toBe(doc.priority);
			expect(rule.enforcement, context).toBe(doc.enforcement);
			expect(rule.match, context).toBe(doc.match);
			expect(rule.alwaysApply, context).toBe(doc.alwaysApply);
			if (doc.globs === undefined) {
				expect(rule.globs, context).toBeUndefined();
			} else {
				expect(rule.globs, context).toEqual(doc.globs);
			}
			if (doc.tools === undefined) {
				expect(rule.tools, context).toBeUndefined();
			} else {
				expect(rule.tools, context).toEqual(doc.tools);
			}
			if (doc.branch === undefined) {
				expect(rule.branch, context).toBeUndefined();
			} else {
				expect(rule.branch, context).toBe(doc.branch);
			}
			if (doc.model === undefined) {
				expect(rule.model, context).toBeUndefined();
			} else {
				expect(rule.model, context).toBe(doc.model);
			}
			// Body roundtrips verbatim: generated bodies have no blank edges,
			// so the parser's edge-trim is a no-op on them.
			expect(rule.content, context).toBe(doc.body);
		}
	});
});

describe("parseRule — generated invalid documents (property)", () => {
	it(`rejects ${CASES} single-defect documents with the pinned error code, stably`, () => {
		const rng = createSeeded(0x52454a31);
		for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
			const defect = generateInvalidDoc(rng);
			const first = parseRule(defect.raw, META);
			const second = parseRule(defect.raw, META);
			const context = `case ${caseIndex} (${defect.expectedCode})`;
			expect(first.ok, `${context}: should reject\n${defect.raw}`).toBe(false);
			expect(second.ok, `${context}: should reject (replay)\n${defect.raw}`).toBe(false);
			if (first.ok || second.ok) {
				continue;
			}
			expect(first.error.code, context).toBe(defect.expectedCode);
			// Rejection stability: the parser is pure, so the same text twice
			// must produce the very same typed error.
			expect(first.error, context).toEqual(second.error);
		}
	});
});
