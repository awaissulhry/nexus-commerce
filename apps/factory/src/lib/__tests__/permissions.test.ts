/** F1 — the registry is the security contract; its invariants are tested. */
import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  FIELDS,
  PAGES,
  SYSTEM_ROLES,
  expandPermissions,
  isValidPermission,
  permissionCatalog,
} from "../auth/permissions";

describe("registry", () => {
  it("has no duplicate permission strings", () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });
  it("covers the 11 F0-IA pages + the Owner-approved 12th (/chat, FC1)", () => {
    expect(Object.keys(PAGES)).toHaveLength(12);
  });
  it("validates membership", () => {
    expect(isValidPermission("pages.inbox")).toBe(true);
    expect(isValidPermission("pages.nonsense")).toBe(false);
  });
});

describe("expandPermissions", () => {
  it("master financial grant implies every grain", () => {
    const set = expandPermissions([FIELDS.financialsView]);
    expect(set.has(FIELDS.costsView)).toBe(true);
    expect(set.has(FIELDS.marginsView)).toBe(true);
    expect(set.has(FIELDS.pricesView)).toBe(true);
    expect(set.has(FIELDS.suppliersView)).toBe(true);
  });
  it("single grains do not imply the master", () => {
    const set = expandPermissions([FIELDS.costsView]);
    expect(set.has(FIELDS.financialsView)).toBe(false);
    expect(set.has(FIELDS.marginsView)).toBe(false);
  });
});

describe("system roles (FD9)", () => {
  it("OWNER is implicit-all (empty list)", () => {
    expect(SYSTEM_ROLES.OWNER.permissions).toHaveLength(0);
  });
  it("WORKER holds ZERO financial grains and no Quotes/Products/Financials pages", () => {
    const worker = new Set(SYSTEM_ROLES.WORKER.permissions);
    for (const grain of Object.values(FIELDS)) expect(worker.has(grain)).toBe(false);
    expect(worker.has(PAGES.quotes)).toBe(false);
    expect(worker.has(PAGES.products)).toBe(false);
    expect(worker.has(PAGES.financials)).toBe(false);
    expect(worker.has(PAGES.production)).toBe(true);
    expect(worker.has(PAGES.materials)).toBe(true);
  });
  it("WORKER may consume materials but never manage the catalog (FP2 distinction)", () => {
    const worker = new Set(SYSTEM_ROLES.WORKER.permissions);
    expect(worker.has("materials.consume")).toBe(true);
    expect(worker.has("materials.manage")).toBe(false);
    expect(worker.has("products.manage")).toBe(false);
    expect(worker.has("pricelists.manage")).toBe(false);
  });
  it("every role permission exists in the registry", () => {
    for (const role of Object.values(SYSTEM_ROLES)) {
      for (const p of role.permissions) expect(isValidPermission(p)).toBe(true);
    }
  });
});

describe("catalog", () => {
  it("groups the full registry for the FP11 role editor", () => {
    const total = permissionCatalog().reduce((n, g) => n + g.items.length, 0);
    expect(total).toBe(ALL_PERMISSIONS.length);
  });
});
