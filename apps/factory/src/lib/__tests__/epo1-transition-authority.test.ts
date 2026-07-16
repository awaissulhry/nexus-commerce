/**
 * EPO1.1 — the extended transition authority: system-only edges, action-owned
 * edges, and the guarantee that every driver's `via` maps to a legal edge.
 * (The db-bound service wrapper is exercised by the :3199 smoke; these tests
 * pin the pure decision core so no route or driver can reintroduce a bypass.)
 */
import { describe, expect, it } from "vitest";
import {
  BOARD_LANES,
  canTransition,
  canTransitionVia,
  legalTargets,
  requiresReason,
  type OrderState,
  type TransitionVia,
} from "@/lib/orders/transitions";

describe("canTransitionVia — action-owned edges", () => {
  it("CONFIRMED→IN_PRODUCTION refused as manual, with the start-production pointer", () => {
    const chk = canTransitionVia("CONFIRMED", "IN_PRODUCTION", "manual");
    expect(chk.ok).toBe(false);
    expect(chk.useStartProduction).toBe(true);
  });
  it("CONFIRMED→IN_PRODUCTION legal via start-production", () => {
    expect(canTransitionVia("CONFIRMED", "IN_PRODUCTION", "start-production").ok).toBe(true);
  });
  it("start-production does not legalize any other edge", () => {
    expect(canTransitionVia("READY", "SHIPPED", "start-production").ok).toBe(true); // normal edge, unaffected
    expect(canTransitionVia("SHIPPED", "READY", "start-production").ok).toBe(false); // system edge, wrong via
    expect(canTransitionVia("CONFIRMED", "READY", "start-production").ok).toBe(false); // not an edge at all
  });
});

describe("canTransitionVia — system-only edges", () => {
  it("SHIPPED→READY refused as manual (not in menus either)", () => {
    expect(canTransitionVia("SHIPPED", "READY", "manual").ok).toBe(false);
    expect(legalTargets("SHIPPED")).not.toContain("READY");
  });
  it("SHIPPED→READY legal only via label-voided", () => {
    expect(canTransitionVia("SHIPPED", "READY", "label-voided").ok).toBe(true);
    expect(canTransitionVia("SHIPPED", "READY", "tracking").ok).toBe(false);
    expect(canTransitionVia("SHIPPED", "READY", "cancel").ok).toBe(false);
  });
});

describe("canTransitionVia — every live driver rides a legal edge", () => {
  const DRIVER_EDGES: [OrderState, OrderState, TransitionVia][] = [
    ["IN_PRODUCTION", "READY", "all-wos-done"], // FP6: last WO done
    ["READY", "SHIPPED", "label-purchased"], // FP8: buy-and-print
    ["SHIPPED", "DELIVERED", "tracking"], // FP8: carrier poll
    ["SHIPPED", "READY", "label-voided"], // FP8: void pre-dispatch
    ["CONFIRMED", "IN_PRODUCTION", "start-production"],
    ["CANCELLED", "CONFIRMED", "reopen"],
  ];
  for (const [from, to, via] of DRIVER_EDGES) {
    it(`${from} → ${to} via ${via}`, () => {
      expect(canTransitionVia(from, to, via).ok).toBe(true);
    });
  }
});

describe("canTransitionVia — defers to canTransition everywhere else", () => {
  it("same-state and unknown edges stay refused for every via", () => {
    const vias: TransitionVia[] = ["manual", "cancel", "reopen", "tracking", "label-purchased", "all-wos-done"];
    for (const via of vias) {
      expect(canTransitionVia("READY", "READY", via).ok).toBe(false);
      expect(canTransitionVia("DELIVERED", "CONFIRMED", via).ok).toBe(false);
      expect(canTransitionVia("CLOSED", "SHIPPED", via).ok).toBe(false);
    }
  });
  it("plain edges keep working via manual", () => {
    expect(canTransitionVia("READY", "SHIPPED", "manual").ok).toBe(true);
    expect(canTransitionVia("SHIPPED", "DELIVERED", "manual").ok).toBe(true);
    expect(canTransitionVia("DELIVERED", "CLOSED", "manual").ok).toBe(true);
    expect(canTransitionVia("READY", "IN_PRODUCTION", "manual").ok).toBe(true); // rework
  });
  it("agrees with canTransition on the plain graph", () => {
    const STATES: OrderState[] = ["CONFIRMED", "IN_PRODUCTION", "READY", "SHIPPED", "DELIVERED", "CLOSED", "CANCELLED"];
    for (const from of STATES) {
      for (const to of STATES) {
        if (from === "SHIPPED" && to === "READY") continue; // the system edge — intentionally differs
        expect(canTransitionVia(from, to, "manual").ok).toBe(canTransition(from, to).ok);
      }
    }
  });
});

describe("guards the service composes on top", () => {
  it("CANCELLED requires a reason; nothing else does", () => {
    expect(requiresReason("CANCELLED")).toBe(true);
    for (const s of BOARD_LANES) expect(requiresReason(s)).toBe(false);
  });
});
