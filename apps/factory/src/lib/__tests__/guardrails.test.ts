/** F1 — Owner-supremacy guardrails (pure predicates, S-series pattern). */
import { describe, expect, it } from "vitest";
import {
  GuardrailError,
  assertKnownPermissions,
  assertNotLastOwner,
  assertNotSystemRole,
  assertOwnerGrant,
  assertRoleUnused,
} from "../auth/guardrails";

describe("guardrails", () => {
  it("only an OWNER grants OWNER", () => {
    expect(() => assertOwnerGrant(false, "OWNER")).toThrow(GuardrailError);
    expect(() => assertOwnerGrant(true, "OWNER")).not.toThrow();
    expect(() => assertOwnerGrant(false, "WORKER")).not.toThrow();
  });
  it("the last owner is untouchable", () => {
    expect(() => assertNotLastOwner(0)).toThrow(/last owner/i);
    expect(() => assertNotLastOwner(1)).not.toThrow();
  });
  it("system roles are immutable", () => {
    expect(() => assertNotSystemRole(true)).toThrow(GuardrailError);
    expect(() => assertNotSystemRole(false)).not.toThrow();
  });
  it("roles in use cannot be deleted", () => {
    expect(() => assertRoleUnused(2)).toThrow(/2 member/);
    expect(() => assertRoleUnused(0)).not.toThrow();
  });
  it("unknown permissions are rejected with their names", () => {
    expect(() => assertKnownPermissions(["pages.inbox", "pages.bogus"])).toThrow(/pages\.bogus/);
    expect(() => assertKnownPermissions(["pages.inbox"])).not.toThrow();
  });
});
