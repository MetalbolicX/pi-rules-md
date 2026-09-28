import { describe, expect, it } from "vitest";
import { detectIntentGlobs } from "./intent.ts";
import { normalizedPath, ruleId } from "./types.ts";
import type { Rule } from "./types.ts";

const rule = (keywords?: string[], globs?: string[]): Rule => ({
 id: ruleId("r"), path: normalizedPath("r.md"), source: "project", description: "r",
 ...(keywords === undefined ? {} : { keywords }), ...(globs === undefined ? {} : { globs }),
 match: "both", priority: 0, enforcement: "inform", alwaysApply: false, version: 1, content: "",
});

describe("detectIntentGlobs", () => {
 it("detects language globs from prompt words, case-insensitive, whole-word", () => {
  expect(detectIntentGlobs("Python pytest RUST TypeScript JavaScript golang Kotlin Java CSharp Ruby", [])).toEqual(["*.py", "*.rs", "*.ts", "*.js", "*.go", "*.kt", "*.java", "*.cs", "*.rb"]);
 });
 it("does not match bare 'go'", () => { expect(detectIntentGlobs("go", [])).toEqual([]); });
 it("does not match substrings inside words", () => { expect(detectIntentGlobs("gone python3", [])).toEqual([]); });
 it("donates a rule's globs when its keywords match the prompt", () => { expect(detectIntentGlobs("Use MY TOOL", [rule(["my tool"], ["docs/*.md"])] )).toEqual(["docs/*.md"]); });
 it("empty prompt yields no intent globs", () => { expect(detectIntentGlobs("", [rule(["python"], ["*.md"])] )).toEqual([]); });
});
