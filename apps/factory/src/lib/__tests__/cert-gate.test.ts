/** FP6 — the EN 17092 cert gate (FD14): the QC→Packing block, decided purely. */
import { describe, expect, it } from "vitest";
import { certStatus } from "../production/cert-gate";

const NOW = new Date("2026-07-05").getTime();

describe("certStatus", () => {
  it("missing when nothing covers the template", () => {
    expect(certStatus([], NOW)).toBe("missing");
  });
  it("ok when a covering cert has no expiry or a future expiry", () => {
    expect(certStatus([{ expiresAt: null }], NOW)).toBe("ok");
    expect(certStatus([{ expiresAt: new Date("2027-01-01") }], NOW)).toBe("ok");
  });
  it("expired when every covering cert is past its expiry", () => {
    expect(certStatus([{ expiresAt: new Date("2025-01-01") }], NOW)).toBe("expired");
    expect(certStatus([{ expiresAt: new Date("2024-06-01") }, { expiresAt: new Date("2025-12-31") }], NOW)).toBe("expired");
  });
  it("ok if at least one covering cert is still valid", () => {
    expect(certStatus([{ expiresAt: new Date("2024-01-01") }, { expiresAt: new Date("2027-01-01") }], NOW)).toBe("ok");
  });
  it("expiry exactly now still counts as valid (>=)", () => {
    expect(certStatus([{ expiresAt: new Date(NOW) }], NOW)).toBe("ok");
  });
});
