export function sandboxRefusal(opts: { agentDir: string | undefined; env: NodeJS.ProcessEnv }): string | null {
  if ((opts.env.VITEST === "true" || opts.env.NODE_ENV === "test") && opts.agentDir === undefined) {
    return "refusing to mutate Pi settings without an explicit agent directory under a test runtime; pass --agent-dir or set PI_RULES_AGENT_DIR";
  }
  return null;
}
