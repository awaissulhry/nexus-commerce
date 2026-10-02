/**
 * P11/P12 — the factory tools Claude may be offered, and what each needs (plan section 09 §5). Pure: the stdio server
 * (apps/factory/mcp) builds its tools from these entries and offers a person only the ones their token's scopes and
 * their roles allow; every call is checked again (the roles may have changed since the list was made).
 *
 * Reads need a `read` token; drafts a `read,draft` token. A draft never leaves the factory: a DRAFT quote or purchase
 * order, an internal comment, one work-order stage forward or back. Sending, converting, buying or voiding labels,
 * invoices, payments, users, roles, RBAC, integrations, settings and backups stay the Owner's click in the factory app
 * (09 §2): no tool may need one of those permissions (NEVER_FOR_CLAUDE, held by p11-claude-catalog.test.ts).
 */
import { FEATURES, FIELDS, PAGES } from "../auth/permissions";
import type { Resolved } from "../auth/rbac";
import type { ClaudeScope } from "./core";

export interface ClaudeToolEntry {
  scope: ClaudeScope;
  /** Every one is needed (an OWNER holds all). */
  permissions: string[];
}

export const CLAUDE_TOOLS = {
  // P11 — reads
  "factory-overview": { scope: "read", permissions: [] }, // each counter is shown only with its page permission
  "factory-orders": { scope: "read", permissions: [PAGES.orders] },
  "factory-order": { scope: "read", permissions: [PAGES.orders] },
  "factory-quotes": { scope: "read", permissions: [PAGES.quotes] },
  "factory-production": { scope: "read", permissions: [PAGES.production] },
  "factory-materials": { scope: "read", permissions: [PAGES.materials] },
  "factory-shipments": { scope: "read", permissions: [PAGES.shipping] },
  "factory-inbox": { scope: "read", permissions: [PAGES.inbox] },
  "factory-financials": { scope: "read", permissions: [PAGES.financials, FIELDS.financialsView] },
  "factory-analytics": { scope: "read", permissions: [PAGES.analytics] },
  // P12 — drafts
  "factory-draft-quote": { scope: "draft", permissions: [FEATURES.quotesCreate] },
  "factory-draft-purchase-order": { scope: "draft", permissions: [FEATURES.materialsManage] },
  "factory-add-comment": { scope: "draft", permissions: [FEATURES.commentsCreate] },
  "factory-advance-work-order": { scope: "draft", permissions: [FEATURES.workordersAdvance] },
} satisfies Record<string, ClaudeToolEntry>;

export type ClaudeToolName = keyof typeof CLAUDE_TOOLS;

/** What no Claude tool may need: the Owner's own clicks (09 §2, Factory row). */
export const NEVER_FOR_CLAUDE: string[] = [
  FEATURES.usersManage,
  FEATURES.rolesManage,
  FEATURES.integrationsManage,
  FEATURES.settingsManage,
  FEATURES.quotesSend,
  FEATURES.quotesConvert,
  FEATURES.inboxSend,
  FEATURES.labelsPurchase,
  FEATURES.labelsVoid,
  FEATURES.invoicesManage,
  FEATURES.paymentsRecord,
  FEATURES.importsRun,
  FEATURES.ordersCancel,
];

/** rbac.ts's rule, here without its database import (this file stays pure): an OWNER holds every permission. */
const holds = (resolved: Resolved, permission: string): boolean => resolved.isOwner || resolved.permissions.has(permission);

const isTool = (name: string): name is ClaudeToolName => Object.prototype.hasOwnProperty.call(CLAUDE_TOOLS, name);

/** Why this token and person may not use the tool, in a sentence; null when they may. */
export function toolRefusal(name: string, scopes: Set<ClaudeScope>, resolved: Resolved): string | null {
  if (!isTool(name)) return `unknown tool: ${name}`;
  const tool: ClaudeToolEntry = CLAUDE_TOOLS[name];
  if (!scopes.has(tool.scope)) {
    return tool.scope === "draft"
      ? `${name} makes drafts, and this Claude connection may only read. The Owner can create a connection that drafts in Settings › Integrations › Claude.`
      : `${name} needs a connection that reads.`;
  }
  const missing = tool.permissions.filter((permission) => !holds(resolved, permission));
  return missing.length ? `${name} needs the ${missing.join(" and ")} permission${missing.length > 1 ? "s" : ""}.` : null;
}

/** The tools this token and person are offered. */
export function offeredTools(scopes: Set<ClaudeScope>, resolved: Resolved): ClaudeToolName[] {
  return (Object.keys(CLAUDE_TOOLS) as ClaudeToolName[]).filter((name) => toolRefusal(name, scopes, resolved) === null);
}
