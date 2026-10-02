/**
 * P11 (MCP full control, decision P-1 = A) — the factory's own MCP server, over stdio, on the factory machine only.
 * Claude Code or Claude Desktop starts it as a local process (no network surface); it reads the factory's SQLite file
 * through the factory's own code, as the person its token runs as.
 *
 *   npm run --silent mcp -w @nexus/factory    from the repository folder (src/lib/claude/setup.ts; the factory's tsconfig
 *                                             resolves its `@/` paths; --silent keeps npm's lines off stdout)
 *                                             env: FACTORY_MCP_TOKEN=<token from Settings › Integrations › Claude>
 *                                                  FACTORY_RBAC_MODE=enforce (or in apps/factory/.env)
 *
 * It refuses to start unless FACTORY_RBAC_MODE=enforce (in shadow mode every permission check allows), the database
 * is verified in WAL mode (a third process on a non-WAL file risks corruption) and the token is usable. Each call is
 * checked again in mcp/door.ts. Reads first (P11); the drafts (P12) need a `read,draft` token. Nothing leaves the
 * factory from here: sending, converting, labels, invoices and payments stay the Owner's click in the factory app.
 */
import "./bootstrap";
import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { prisma, verifiedJournalMode } from "../src/lib/db";
import { resolvePermissions } from "../src/lib/auth/rbac";
import { offeredTools } from "../src/lib/claude/catalog";
import { startRefusal } from "../src/lib/claude/core";
import { resolveAccessToken } from "../src/lib/claude/tokens";
import { callFactoryTool } from "./door";
import { ALL_TOOLS } from "./tools";
import type { FactoryTool } from "./tools/types";

/** The journal mode as db.ts verified it at open (it sets WAL), or as the file reports when that did not finish. */
async function journalMode(): Promise<string | null> {
  for (let waited = 0; waited < 5000 && verifiedJournalMode() === null; waited += 50) await new Promise((r) => setTimeout(r, 50));
  const verified = verifiedJournalMode();
  if (verified) return verified;
  const rows = (await prisma.$queryRawUnsafe("PRAGMA journal_mode;")) as { journal_mode?: string }[];
  return rows?.[0]?.journal_mode ? String(rows[0].journal_mode).toLowerCase() : null;
}

/** The tool's own schema, as the MCP SDK takes it: JSON Schema for Claude; the door parses the arguments itself. */
function schemaOf(tool: FactoryTool): StandardSchemaWithJSON<Record<string, unknown>> {
  const json = z.toJSONSchema(tool.input) as Record<string, unknown>;
  return {
    "~standard": {
      version: 1,
      vendor: "nexus-factory",
      validate: (value) => ({ value: (value ?? {}) as Record<string, unknown> }),
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}

async function main() {
  const token = process.env.FACTORY_MCP_TOKEN;
  const refusal = startRefusal({ rbacMode: process.env.FACTORY_RBAC_MODE, journalMode: await journalMode(), token });
  if (refusal) throw new Error(refusal);
  const access = await resolveAccessToken(token);
  if (!access.ok) throw new Error(`Refusing to start: ${access.error}`);
  const resolved = await resolvePermissions(access.user);
  const offered = new Set(offeredTools(access.scopes, resolved));

  const server = new McpServer(
    { name: "nexus-factory", title: "Nexus Factory", version: "1.0.0" },
    {
      capabilities: offered.size ? { tools: { listChanged: false } } : {},
      instructions:
        `Nexus Factory: orders, quotes, production, materials, shipping, the inbox and the money of the factory. This connection acts as ${access.user.displayName} `
        + "and sees what that person may see (money only with their permission). "
        + (access.scopes.has("draft")
          ? "Drafts stay drafts: a quote or purchase order is created as DRAFT, a comment is internal, a work order moves one stage; the Owner sends, converts, invoices and pays in the factory app."
          : "This connection only reads."),
    },
  );
  for (const tool of ALL_TOOLS.filter((t) => offered.has(t.name))) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: schemaOf(tool),
        annotations: { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false, idempotentHint: tool.readOnly },
      },
      async (args) => {
        const answer = await callFactoryTool(tool, token, args);
        return answer.ok
          ? { content: [{ type: "text" as const, text: JSON.stringify(answer.data) }] }
          : { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: answer.error }) }] };
      },
    );
  }
  await server.connect(new StdioServerTransport());
  console.error(`[factory-mcp] serving ${offered.size} tool(s) for "${access.label}" as ${access.user.displayName}`);
}

main().catch(async (error) => {
  console.error(`[factory-mcp] ${error instanceof Error ? error.message : String(error)}`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
