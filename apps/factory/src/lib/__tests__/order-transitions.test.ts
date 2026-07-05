/**
 * FP4 — the order lifecycle is the operational backbone; every legal/illegal
 * edge is pinned here so a refactor can't silently open an invalid transition.
 */
import { describe, expect, it } from "vitest";
import {
  canTransition,
  legalTargets,
  requiresReason,
  isStopgap,
  BOARD_LANES,
  type OrderState,
} from "../orders/transitions";

const ALL: OrderState[] = ["CONFIRMED", "IN_PRODUCTION", "READY", "SHIPPED", "DELIVERED", "CLOSED", "CANCELLED"];

describe("canTransition", () => {
  it("allows the forward happy path (minus the start-production edge)", () => {
    expect(canTransition("IN_PRODUCTION", "READY").ok).toBe(true);
    expect(canTransition("READY", "SHIPPED").ok).toBe(true);
    expect(canTransition("SHIPPED", "DELIVERED").ok).toBe(true);
    expect(canTransition("DELIVERED", "CLOSED").ok).toBe(true);
  });

  it("routes CONFIRMED→IN_PRODUCTION through Start production (not a generic edge)", () => {
    const r = canTransition("CONFIRMED", "IN_PRODUCTION");
    expect(r.ok).toBe(false);
    expect(r.useStartProduction).toBe(true);
  });

  it("allows cancel from the working states and reopen from cancelled", () => {
    expect(canTransition("CONFIRMED", "CANCELLED").ok).toBe(true);
    expect(canTransition("IN_PRODUCTION", "CANCELLED").ok).toBe(true);
    expect(canTransition("READY", "CANCELLED").ok).toBe(true);
    expect(canTransition("CANCELLED", "CONFIRMED").ok).toBe(true); // reopen
  });

  it("allows READY→IN_PRODUCTION rework", () => {
    expect(canTransition("READY", "IN_PRODUCTION").ok).toBe(true);
  });

  it("rejects a no-op transition", () => {
    expect(canTransition("READY", "READY").ok).toBe(false);
  });

  it("rejects skipping stages and illegal jumps, with a reason", () => {
    expect(canTransition("CONFIRMED", "READY").ok).toBe(false);
    expect(canTransition("CONFIRMED", "SHIPPED").ok).toBe(false);
    expect(canTransition("READY", "DELIVERED").ok).toBe(false);
    expect(canTransition("SHIPPED", "CANCELLED").ok).toBe(false);
    expect(canTransition("CONFIRMED", "SHIPPED").reason).toMatch(/can't move/i);
  });

  it("treats CLOSED as terminal", () => {
    for (const to of ALL) expect(canTransition("CLOSED", to).ok).toBe(false);
  });

  it("never lets an illegal edge slip through the full matrix", () => {
    // every ok edge must be one the adjacency explicitly lists via legalTargets
    for (const from of ALL) {
      for (const to of ALL) {
        const ok = canTransition(from, to).ok;
        if (ok) expect(legalTargets(from)).toContain(to);
      }
    }
  });
});

describe("guards & helpers", () => {
  it("requires a reason only for cancel", () => {
    expect(requiresReason("CANCELLED")).toBe(true);
    expect(requiresReason("READY")).toBe(false);
    expect(requiresReason("SHIPPED")).toBe(false);
  });

  it("flags the FP6/FP8 stopgap edges", () => {
    expect(isStopgap("IN_PRODUCTION", "READY")).toBe(true);
    expect(isStopgap("READY", "SHIPPED")).toBe(true);
    expect(isStopgap("CONFIRMED", "CANCELLED")).toBe(false);
  });

  it("board lanes are the five live states in flow order", () => {
    expect(BOARD_LANES).toEqual(["CONFIRMED", "IN_PRODUCTION", "READY", "SHIPPED", "DELIVERED"]);
    expect(BOARD_LANES).not.toContain("CANCELLED");
    expect(BOARD_LANES).not.toContain("CLOSED");
  });
});
