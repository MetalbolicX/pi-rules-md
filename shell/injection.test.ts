/**
 * Tests for the injection layer: the pure `injectionDecision` core (full
 * 4-quadrant decision table, determinism, purity) and the imperative
 * application helpers that mutate pi's system-prompt `sections` record in
 * place — the only sanctioned pi mutation.
 *
 * All section fixtures are plain local records mirroring the REAL pi shape
 * (`systemPromptOptions.sections: Record<string, string>` on
 * `before_agent_start`, pi 1.3.0) — no pi runtime, no I/O, no disk.
 */
import { describe, expect, it } from "vitest";
import { applyInjection, injectionDecision, removeInjection } from "./injection.ts";
import type { InjectionDecision, PromptSections } from "./injection.ts";
import { sectionId } from "../src/render.ts";
import { initialState, transition } from "../src/state.ts";
import type { SessionState } from "../src/state.ts";
import type { InjectionBlock } from "../src/types.ts";

/** Recursively freezes an object/array graph in place so mutations become detectable. */
const deepFreeze = <T>(value: T): T => {
	if (Array.isArray(value)) {
		for (const item of value) {
			deepFreeze(item);
		}
		Object.freeze(value);
	} else if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) {
			deepFreeze(item);
		}
		Object.freeze(value);
	}
	return value;
};

/** A block fixture with a controllable hash and content. */
const blockFixture = (contentHash: string, content = "rendered rules"): InjectionBlock => ({
	sectionId,
	content,
	contentHash,
});

describe("injectionDecision — decision table", () => {
	it("patches when a block exists and its hash differs from the last injected one", () => {
		expect(injectionDecision(blockFixture("hash-2"), "hash-1")).toEqual({ action: "patch" });
	});

	it("patches even when a block exists and its hash equals the last injected one (pi rebuilds sections every turn)", () => {
		// THE FIX (T14 dogfood defect): pi rebuilds systemPromptOptions.sections
		// from its base EVERY turn, so an equal hash must NOT skip the write —
		// the section would silently drop from the live system prompt. The
		// decision always re-applies; identical content means pi's section diff
		// emits nothing (content stability), and applyInjection keeps the
		// section live on an unchanged turn.
		expect(injectionDecision(blockFixture("hash-1"), "hash-1")).toEqual({ action: "patch" });
		const sections: PromptSections = {};
		applyInjection(sections, blockFixture("hash-1", "content-1"));
		expect(sections[sectionId]).toBe("content-1");
	});

	it("removes when the block is gone but a section was injected before", () => {
		expect(injectionDecision(undefined, "hash-1")).toEqual({ action: "remove" });
	});

	it("does nothing when there is no block and nothing was ever injected", () => {
		expect(injectionDecision(undefined, undefined)).toEqual({ action: "none" });
	});
});

describe("injectionDecision — determinism and purity", () => {
	it("returns equal decisions for equal inputs and never touches its arguments", () => {
		const block = blockFixture("hash-1");
		deepFreeze(block);
		const first: InjectionDecision = injectionDecision(block, "hash-2");
		const second = injectionDecision(block, "hash-2");
		expect(first).toEqual({ action: "patch" });
		expect(second).toEqual(first);
		expect(block).toEqual(blockFixture("hash-1"));
	});
});

describe("applyInjection", () => {
	it("appends our section when it is absent, leaving other sections untouched", () => {
		const sections: PromptSections = { preamble: "hello" };
		applyInjection(sections, blockFixture("hash-1", "content-1"));
		expect(sections).toEqual({ preamble: "hello", [sectionId]: "content-1" });
	});

	it("replaces our section's content in place, keeping the key and its position", () => {
		const sections: PromptSections = { preamble: "hello", [sectionId]: "old-content", tail: "bye" };
		applyInjection(sections, blockFixture("hash-2", "new-content"));
		expect(Object.keys(sections)).toEqual(["preamble", sectionId, "tail"]);
		expect(sections[sectionId]).toBe("new-content");
		expect(sections.preamble).toBe("hello");
		expect(sections.tail).toBe("bye");
	});

	it("keys the section by the render.ts sectionId, not by the block's own field", () => {
		const sections: PromptSections = {};
		const block: InjectionBlock = { sectionId: "some-other-id", content: "content-1", contentHash: "hash-1" };
		applyInjection(sections, block);
		expect(Object.keys(sections)).toEqual([sectionId]);
		expect(sections[sectionId]).toBe("content-1");
	});
});

describe("removeInjection", () => {
	it("removes only our section, leaving others untouched", () => {
		const sections: PromptSections = { preamble: "hello", [sectionId]: "ours", tail: "bye" };
		removeInjection(sections);
		expect(sections).toEqual({ preamble: "hello", tail: "bye" });
		expect(sectionId in sections).toBe(false);
	});

	it("is a no-op when our section is absent", () => {
		const sections: PromptSections = { preamble: "hello" };
		removeInjection(sections);
		expect(sections).toEqual({ preamble: "hello" });
	});
});

describe("hash hysteresis — reducer + decision end to end", () => {
	it("injects, keeps re-applying the identical block every turn, then re-patches after a compact", () => {
		const block = blockFixture("hash-1");
		let state: SessionState = initialState;

		expect(injectionDecision(block, state.lastInjectedHash)).toEqual({ action: "patch" });
		state = transition(state, { type: "block_injected", contentHash: block.contentHash });

		// Unchanged active set: still patch — pi rebuilds sections per turn, so
		// the write must happen again (identical content → empty section diff).
		expect(injectionDecision(block, state.lastInjectedHash)).toEqual({ action: "patch" });

		state = transition(state, { type: "session_compact" });
		expect(injectionDecision(block, state.lastInjectedHash)).toEqual({ action: "patch" });
	});

	it("removes when the block disappears, and the same content re-injects after removal", () => {
		const block = blockFixture("hash-1");
		let state: SessionState = initialState;
		state = transition(state, { type: "block_injected", contentHash: block.contentHash });

		expect(injectionDecision(undefined, state.lastInjectedHash)).toEqual({ action: "remove" });

		// block_removed clears the hash: a later no-block turn then decides
		// "none" instead of repeating a removal.
		state = transition(state, { type: "block_removed" });
		expect(injectionDecision(block, state.lastInjectedHash)).toEqual({ action: "patch" });
	});

	it("applies and removes over a real sections record, then re-applies", () => {
		const sections: PromptSections = { preamble: "hello" };
		const block = blockFixture("hash-1", "content-1");

		applyInjection(sections, block);
		expect(sections[sectionId]).toBe("content-1");

		removeInjection(sections);
		expect(sectionId in sections).toBe(false);

		applyInjection(sections, block);
		expect(sections[sectionId]).toBe("content-1");
		expect(sections.preamble).toBe("hello");
	});
});
