/**
 * EPQ.1 — the quote lifecycle is the money mouth's backbone; every legal and
 * illegal edge is pinned here so a refactor can't silently reopen S2 (the
 * write-any-state PATCH). Also pins the supersede token selection and the
 * expiry-sweep boundary.
 */
import { describe, expect, it } from "vitest";
import {
  canTransition,
  legalTargets,
  lostReasonAllowed,
  isQuoteLapsed,
  isSupersededToken,
  SEND_EDGE,
  type QuoteState,
} from "../quotes/transitions";

const ALL: QuoteState[] = ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"];

describe("canTransition (quote state machine)", () => {
  it("routes DRAFT→SENT through Send (not a generic edge)", () => {
    const r = canTransition("DRAFT", "SENT");
    expect(r.ok).toBe(false);
    expect(r.useSend).toBe(true);
    expect(SEND_EDGE).toEqual({ from: "DRAFT", to: "SENT" });
  });

  it("allows every decision out of SENT, plus revise", () => {
    expect(canTransition("SENT", "ACCEPTED").ok).toBe(true);
    expect(canTransition("SENT", "REJECTED").ok).toBe(true);
    expect(canTransition("SENT", "EXPIRED").ok).toBe(true);
    expect(canTransition("SENT", "DRAFT").ok).toBe(true); // revise
  });

  it("allows revise out of the dead ends", () => {
    expect(canTransition("REJECTED", "DRAFT").ok).toBe(true);
    expect(canTransition("EXPIRED", "DRAFT").ok).toBe(true);
  });

  it("treats ACCEPTED as terminal (convert-only) with a pointed reason", () => {
    for (const to of ALL) {
      const r = canTransition("ACCEPTED", to);
      expect(r.ok).toBe(false);
    }
    expect(canTransition("ACCEPTED", "DRAFT").reason).toMatch(/convert/i);
  });

  it("rejects a no-op transition", () => {
    for (const s of ALL) expect(canTransition(s, s).ok).toBe(false);
  });

  it("rejects the illegal jumps, with a reason", () => {
    expect(canTransition("DRAFT", "ACCEPTED").ok).toBe(false);
    expect(canTransition("DRAFT", "REJECTED").ok).toBe(false);
    expect(canTransition("DRAFT", "EXPIRED").ok).toBe(false);
    expect(canTransition("REJECTED", "SENT").ok).toBe(false);
    expect(canTransition("REJECTED", "ACCEPTED").ok).toBe(false);
    expect(canTransition("REJECTED", "EXPIRED").ok).toBe(false);
    expect(canTransition("EXPIRED", "SENT").ok).toBe(false);
    expect(canTransition("EXPIRED", "ACCEPTED").ok).toBe(false);
    expect(canTransition("EXPIRED", "REJECTED").ok).toBe(false);
    expect(canTransition("DRAFT", "ACCEPTED").reason).toMatch(/can't move/i);
  });

  it("never lets an illegal edge slip through the full matrix", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const ok = canTransition(from, to).ok;
        if (ok) expect(legalTargets(from)).toContain(to);
      }
    }
    // and the exact count of PATCH-legal edges is pinned: 4 from SENT + 2 revises
    const legal = ALL.flatMap((f) => ALL.filter((t) => canTransition(f, t).ok).map((t) => `${f}>${t}`));
    expect(legal.sort()).toEqual(["EXPIRED>DRAFT", "REJECTED>DRAFT", "SENT>ACCEPTED", "SENT>DRAFT", "SENT>EXPIRED", "SENT>REJECTED"]);
  });
});

describe("field guards", () => {
  it("lostReason only lands on a lost outcome", () => {
    expect(lostReasonAllowed("REJECTED")).toBe(true);
    expect(lostReasonAllowed("EXPIRED")).toBe(true);
    expect(lostReasonAllowed("DRAFT")).toBe(false);
    expect(lostReasonAllowed("SENT")).toBe(false);
    expect(lostReasonAllowed("ACCEPTED")).toBe(false);
  });
});

describe("expiry sweep boundary", () => {
  const now = new Date("2026-07-11T12:00:00.000Z");
  it("lapses strictly AFTER validUntilAt (equal instant is still valid)", () => {
    expect(isQuoteLapsed(new Date(now.getTime() - 1), now)).toBe(true);
    expect(isQuoteLapsed(new Date(now.getTime()), now)).toBe(false);
    expect(isQuoteLapsed(new Date(now.getTime() + 1), now)).toBe(false);
  });
  it("no validity means it never lapses", () => {
    expect(isQuoteLapsed(null, now)).toBe(false);
  });
});

describe("supersede token selection", () => {
  it("an older version's token is superseded; the latest keeps working", () => {
    expect(isSupersededToken(1, 2)).toBe(true);
    expect(isSupersededToken(1, 3)).toBe(true);
    expect(isSupersededToken(2, 2)).toBe(false);
    expect(isSupersededToken(1, 1)).toBe(false); // single send — its token IS the latest
  });
});
