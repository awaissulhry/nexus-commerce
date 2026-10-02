/**
 * P11 — the one door every factory tool call goes through (plan section 09 §5 outline 2). Per call, in order:
 *
 *   1. the token, hashed and looked up NOW: unknown, revoked, expired or a deactivated person is refused;
 *   2. the per-minute rate of that token;
 *   3. the person's permissions NOW (resolvePermissions, as the app's route guard) and the token's scopes: a tool
 *      the person may not use, or a draft with a read-only token, is refused;
 *   4. a draft: the daily cap of the token (100);
 *   5. the arguments, parsed by the tool's own schema;
 *   6. the tool;
 *   7. every money field the person may not see, stripped (stripFinancials, as every route and exporter);
 *   8. one audit row: who (the person), which connection, which tool, and whether it ran.
 *
 * Nothing here trusts what Claude says about who it is: the token and the factory's own rows decide.
 */
import { audit } from "../src/lib/audit";
import { resolvePermissions } from "../src/lib/auth/rbac";
import { stripFinancials } from "../src/lib/auth/strip-financials";
import { CLAUDE_TOOLS, toolRefusal } from "../src/lib/claude/catalog";
import { MinuteRate, auditAction, draftCapRefusal } from "../src/lib/claude/core";
import { draftsToday, resolveAccessToken } from "../src/lib/claude/tokens";
import { ToolRefusal, type FactoryTool } from "./tools/types";

export type DoorAnswer = { ok: true; data: unknown } | { ok: false; error: string };

const rate = new MinuteRate();

/** The arguments as Claude may see them again in the audit: short values only. */
function auditArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {}).slice(0, 12)) {
    out[key] = typeof value === "string" ? value.slice(0, 120) : typeof value === "object" && value !== null ? "[…]" : value;
  }
  return out;
}

export async function callFactoryTool(tool: FactoryTool, rawToken: string | undefined, args: unknown, now = new Date()): Promise<DoorAnswer> {
  const access = await resolveAccessToken(rawToken, now);
  if (!access.ok) return { ok: false, error: access.error };
  const refuse = async (error: string): Promise<DoorAnswer> => {
    await audit({ actorId: access.user.id, entityType: "claude", entityId: access.tokenId, action: `${auditAction(tool.name)}.refused`, after: { error } });
    return { ok: false, error };
  };
  if (!rate.take(access.tokenId, now.getTime())) return refuse("Too many calls from this Claude connection in the last minute. Wait a moment and ask again.");

  const resolved = await resolvePermissions(access.user);
  const refusal = toolRefusal(tool.name, access.scopes, resolved);
  if (refusal) return refuse(refusal);
  if (CLAUDE_TOOLS[tool.name].scope === "draft") {
    const capped = draftCapRefusal(await draftsToday(access.tokenId, now));
    if (capped) return refuse(capped);
  }

  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ");
    return refuse(`${tool.name} was called wrongly — ${problems}`);
  }

  let data: unknown;
  try {
    data = await tool.run(parsed.data as Record<string, unknown>, { user: access.user, resolved, tokenId: access.tokenId, now });
  } catch (error) {
    if (error instanceof ToolRefusal) return refuse(error.message);
    throw error;
  }
  await audit({
    actorId: access.user.id,
    entityType: "claude",
    entityId: access.tokenId,
    action: auditAction(tool.name),
    after: { args: auditArgs(parsed.data as Record<string, unknown>) },
  });
  return { ok: true, data: stripFinancials(data, resolved) };
}
