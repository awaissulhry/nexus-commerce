/**
 * P11 — how Claude Code or Claude Desktop starts the factory's MCP server on this machine (Settings › Integrations ›
 * Claude shows it with the token). Pure: no Node module, so the settings page can import it.
 *
 * The server runs through the factory's own npm script (`"mcp": "tsx mcp/server.ts"` in apps/factory/package.json), from
 * the repository folder: npm runs it in apps/factory, so tsx reads the factory's tsconfig and its `@/` paths resolve.
 * `npx tsx apps/factory/mcp/server.ts` from the repository folder read the root tsconfig instead and stopped with
 * "Cannot find package '@/generated'". `--silent` keeps npm's own "> @nexus/factory mcp" lines off stdout, which belongs
 * to the MCP protocol (one stray line breaks the connection).
 */

/** The command Claude runs, from the repository folder. */
export const FACTORY_MCP_COMMAND = { command: "npm", args: ["run", "--silent", "mcp", "-w", "@nexus/factory"] } as const;

/** The same command as one line, for a terminal. */
export const FACTORY_MCP_COMMAND_LINE = [FACTORY_MCP_COMMAND.command, ...FACTORY_MCP_COMMAND.args].join(" ");

/** The snippet a person pastes into the Claude configuration on this machine. */
export function claudeServerConfig(token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "nexus-factory": {
          command: FACTORY_MCP_COMMAND.command,
          args: [...FACTORY_MCP_COMMAND.args],
          env: { FACTORY_MCP_TOKEN: token, FACTORY_RBAC_MODE: "enforce" },
        },
      },
    },
    null,
    2,
  );
}
