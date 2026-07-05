/**
 * FP5 — the contacts payload must not leak commercial fields (payment terms,
 * default deposit) to a caller without the grain. stripFinancials gates them by
 * name (EXPLICIT map); this pins the contacts boundary.
 */
import { describe, expect, it } from "vitest";
import { stripFinancials } from "../auth/strip-financials";
import { FIELDS } from "../auth/permissions";
import type { Resolved } from "../auth/rbac";

const resolved = (grains: string[], isOwner = false): Resolved => ({ isOwner, permissions: new Set(grains) } as Resolved);
const contact = { id: "p1", name: "Bartoccetti Moto", kind: "CUSTOMER", currency: "EUR", paymentTerms: "30 days", depositDefaultPct: 30, notes: "vip" };

describe("contacts grain strip", () => {
  it("hides terms + deposit from a caller with no grains", () => {
    const out = stripFinancials({ contact }, resolved([])) as { contact: Record<string, unknown> };
    expect(out.contact.name).toBe("Bartoccetti Moto");
    expect("paymentTerms" in out.contact).toBe(false);
    expect("depositDefaultPct" in out.contact).toBe(false);
  });

  it("shows terms with suppliers grain, deposit with prices grain", () => {
    const terms = stripFinancials({ contact }, resolved([FIELDS.suppliersView])) as { contact: Record<string, unknown> };
    expect(terms.contact.paymentTerms).toBe("30 days");
    expect("depositDefaultPct" in terms.contact).toBe(false); // still hidden — different grain

    const dep = stripFinancials({ contact }, resolved([FIELDS.pricesView])) as { contact: Record<string, unknown> };
    expect(dep.contact.depositDefaultPct).toBe(30);
    expect("paymentTerms" in dep.contact).toBe(false);
  });

  it("shows everything to the owner", () => {
    const out = stripFinancials({ contact }, resolved([], true)) as { contact: Record<string, unknown> };
    expect(out.contact.paymentTerms).toBe("30 days");
    expect(out.contact.depositDefaultPct).toBe(30);
  });
});
