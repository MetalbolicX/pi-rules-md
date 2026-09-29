import type { Rule } from "./types.ts";

const LEXICON: readonly (readonly [string, string])[] = [
	["python", "*.py"], ["pytest", "*.py"], ["rust", "*.rs"], ["typescript", "*.ts"],
	["javascript", "*.js"], ["golang", "*.go"], ["kotlin", "*.kt"], ["java", "*.java"],
	["csharp", "*.cs"], ["ruby", "*.rb"],
];

const hasWholeWord = (text: string, word: string): boolean => {
	const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|\\W)${escaped}(?:$|\\W)`, "i").test(text);
};

/** Infers preload globs from language words and matching rule keyword donations. */
export const detectIntentGlobs = (prompt: string, rules: readonly Rule[]): readonly string[] => {
	if (prompt.length === 0) return [];
	const found = new Set<string>();
	for (const [word, glob] of LEXICON) if (hasWholeWord(prompt, word)) found.add(glob);
	for (const rule of rules) {
		if ((rule.keywords ?? []).some((keyword) => hasWholeWord(prompt, keyword))) {
			for (const glob of rule.globs ?? []) if (!glob.startsWith("!")) found.add(glob);
		}
	}
	return [...found];
};
