import { describe, expect, test } from "vitest";
import { sandboxRefusal } from "./interlock.ts";
import { installFlow } from "./install.ts";
import { uninstallFlow } from "./uninstall.ts";

describe("sandboxRefusal", () => {
  test("mutation flows exit 3 and report refusal without an explicit test sandbox", async () => {
    const io = { env: { VITEST: "true" }, stdout: [] as string[], stderr: [] as string[] };
    expect(await installFlow({ dryRun: false, io })).toBe(3);
    expect(io.stderr).toEqual(["refusing to mutate Pi settings without an explicit agent directory under a test runtime; pass --agent-dir or set PI_RULES_AGENT_DIR"]);
    io.stderr.length = 0;
    expect(await uninstallFlow({ dryRun: false, io })).toBe(3);
    expect(io.stderr).toEqual(["refusing to mutate Pi settings without an explicit agent directory under a test runtime; pass --agent-dir or set PI_RULES_AGENT_DIR"]);
  });

  test("refuses mutation in a test runtime without an explicit agent directory", () => {
    expect(sandboxRefusal({ agentDir: undefined, env: { VITEST: "true" } })).toBe(
      "refusing to mutate Pi settings without an explicit agent directory under a test runtime; pass --agent-dir or set PI_RULES_AGENT_DIR",
    );
  });

  test("allows a test runtime with an explicit agent directory", () => {
    expect(sandboxRefusal({ agentDir: "/sandbox/agent", env: { VITEST: "true" } })).toBeNull();
  });

  test("does not refuse outside a test runtime", () => {
    expect(sandboxRefusal({ agentDir: undefined, env: {} })).toBeNull();
  });
});
