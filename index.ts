/**
 * pi-rules-md — conditional markdown rules for the pi system prompt.
 *
 * Scaffold stub: a valid, load-safe extension factory. The engine (functional
 * core) and shell wiring land with the tracked tasks in odd/tasks/pi-rules-md.md.
 *
 * Load safety note: pi treats extension load errors as FATAL in
 * non-interactive mode (pi -p / subagent children). This entry must never
 * throw during registration.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piRulesMd(_pi: ExtensionAPI): void {
	// Intentionally empty until shell wiring (task 13) lands.
}
