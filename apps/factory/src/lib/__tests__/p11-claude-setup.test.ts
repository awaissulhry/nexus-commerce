/**
 * P11 — the command Settings › Integrations › Claude tells a person to paste (src/lib/claude/setup.ts). It ran
 * `npx tsx apps/factory/mcp/server.ts` from the repository folder, where tsx read the ROOT tsconfig, so the factory's
 * `@/` paths did not resolve and the server stopped with "Cannot find package '@/generated'". It now runs the factory's
 * own npm script (tsx in apps/factory, with the factory's tsconfig), silently: npm's own lines would land on stdout,
 * which belongs to the MCP protocol.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FACTORY_MCP_COMMAND, FACTORY_MCP_COMMAND_LINE, claudeServerConfig } from "../claude/setup";

const APP = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(APP, file), "utf8");

describe("the Claude configuration the factory shows", () => {
  it("runs the factory's own mcp script, silently, with the token and enforced permissions", () => {
    expect(JSON.parse(claudeServerConfig("fct_test-token"))).toEqual({
      mcpServers: {
        "nexus-factory": {
          command: "npm",
          args: ["run", "--silent", "mcp", "-w", "@nexus/factory"],
          env: { FACTORY_MCP_TOKEN: "fct_test-token", FACTORY_RBAC_MODE: "enforce" },
        },
      },
    });
    expect(FACTORY_MCP_COMMAND_LINE).toBe("npm run --silent mcp -w @nexus/factory");
  });

  it("names a script the factory has, which starts the stdio server from the factory folder", () => {
    const pkg = JSON.parse(read("package.json")) as { name: string; scripts: Record<string, string> };
    expect(pkg.name).toBe(FACTORY_MCP_COMMAND.args[FACTORY_MCP_COMMAND.args.indexOf("-w") + 1]);
    expect(pkg.scripts.mcp).toBe("tsx mcp/server.ts");
  });

  it("is the one the settings page and the server's own header show", () => {
    const page = read("src/app/(app)/settings/integrations/ClaudeConnections.tsx");
    expect(page).toContain("claudeServerConfig(");
    expect(page).not.toContain("apps/factory/mcp/server.ts");
    expect(read("mcp/server.ts")).toContain(FACTORY_MCP_COMMAND_LINE);
    expect(read("mcp/server.ts")).not.toMatch(/npx tsx apps\/factory\/mcp\/server\.ts/);
  });
});
