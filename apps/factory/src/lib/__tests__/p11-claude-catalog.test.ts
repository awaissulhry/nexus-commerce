/**
 * P11/P12 — which factory tools Claude is offered (src/lib/claude/catalog.ts): reads with a `read` token, drafts only
 * with a `read,draft` token, each only for a person who holds its permissions — and no tool, ever, for what stays the
 * Owner's click (09 §2): users, roles, RBAC, integrations, sending, converting, labels, invoices, payments, backups.
 */
import { describe, expect, it } from "vitest";
import { FEATURES, FIELDS, PAGES, SYSTEM_ROLES, expandPermissions, isValidPermission } from "../auth/permissions";
import type { Resolved } from "../auth/rbac";
import { CLAUDE_TOOLS, NEVER_FOR_CLAUDE, offeredTools, toolRefusal } from "../claude/catalog";
import { parseScopes } from "../claude/core";

const owner: Resolved = { isOwner: true, permissions: new Set() };
const worker: Resolved = { isOwner: false, permissions: expandPermissions(SYSTEM_ROLES.WORKER.permissions) };
const READ = parseScopes("read");
const DRAFT = parseScopes("read,draft");

const READS = [
  "factory-analytics", "factory-financials", "factory-inbox", "factory-materials", "factory-order", "factory-orders",
  "factory-overview", "factory-production", "factory-quotes", "factory-shipments",
];
const DRAFTS = ["factory-add-comment", "factory-advance-work-order", "factory-draft-purchase-order", "factory-draft-quote"];

describe("the factory tools Claude may be offered", () => {
  it("are exactly the reads and drafts of section 09 §5, each needing real permissions", () => {
    expect(Object.keys(CLAUDE_TOOLS).sort()).toEqual([...READS, ...DRAFTS].sort());
    for (const [name, tool] of Object.entries(CLAUDE_TOOLS)) {
      expect(tool.permissions.every(isValidPermission), name).toBe(true);
      expect(tool.scope, name).toBe(DRAFTS.includes(name) ? "draft" : "read");
    }
    expect(CLAUDE_TOOLS["factory-financials"].permissions).toContain(FIELDS.financialsView);
  });

  it("never need what stays the Owner's click", () => {
    expect(NEVER_FOR_CLAUDE).toEqual(expect.arrayContaining([
      FEATURES.usersManage, FEATURES.rolesManage, FEATURES.integrationsManage, FEATURES.settingsManage,
      FEATURES.quotesSend, FEATURES.quotesConvert, FEATURES.inboxSend, FEATURES.labelsPurchase, FEATURES.labelsVoid,
      FEATURES.invoicesManage, FEATURES.paymentsRecord,
    ]));
    for (const [name, tool] of Object.entries(CLAUDE_TOOLS)) {
      expect(tool.permissions.filter((p) => NEVER_FOR_CLAUDE.includes(p)), name).toEqual([]);
    }
  });

  it("a read token is offered the reads only; a draft token the drafts too", () => {
    expect(offeredTools(READ, owner).sort()).toEqual([...READS].sort());
    expect(offeredTools(DRAFT, owner).sort()).toEqual([...READS, ...DRAFTS].sort());
  });

  it("a worker is offered only what their role allows: production, materials, no money", () => {
    expect(offeredTools(DRAFT, worker).sort()).toEqual([
      "factory-add-comment", "factory-advance-work-order", "factory-materials", "factory-overview", "factory-production",
    ]);
    expect(toolRefusal("factory-financials", DRAFT, worker)).toMatch(/pages\.financials/);
    expect(toolRefusal("factory-draft-quote", READ, owner)).toMatch(/drafts/);
    expect(toolRefusal("factory-unknown", DRAFT, owner)).toMatch(/unknown/);
    expect(toolRefusal("factory-orders", READ, owner)).toBeNull();
    expect(CLAUDE_TOOLS["factory-production"].permissions).toEqual([PAGES.production]);
  });
});
