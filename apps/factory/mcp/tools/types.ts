/**
 * P11/P12 — one factory tool as the stdio MCP server offers it. Its entry in src/lib/claude/catalog.ts says what it
 * needs (scope, permissions); this says what it is and does. `run` gets arguments its own schema has already parsed
 * and the person it runs as; what it returns is stripped of every money field that person may not see before Claude
 * sees it (mcp/door.ts), so a tool returns its rows as they are.
 */
import type { z } from "zod/v4";
import type { Resolved } from "../../src/lib/auth/rbac";
import type { SessionUser } from "../../src/lib/auth/session";
import type { ClaudeToolName } from "../../src/lib/claude/catalog";

export interface FactoryToolContext {
  user: SessionUser;
  resolved: Resolved;
  tokenId: string;
  now: Date;
}

export interface FactoryTool {
  name: ClaudeToolName;
  title: string;
  description: string;
  readOnly: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool's own object schema
  input: z.ZodObject<any>;
  run(args: Record<string, unknown>, ctx: FactoryToolContext): Promise<unknown>;
}

/** A refusal a person can read ("Order not found", "Only a DRAFT quote can …"): returned to Claude as an error. */
export class ToolRefusal extends Error {}
