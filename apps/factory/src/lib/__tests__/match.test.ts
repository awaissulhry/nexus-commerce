/** FP1.1 — sender→party matching (the golden flow's first hop). */
import { describe, expect, it } from "vitest";
import { domainOf, matchPartyId } from "../google/match";

const rows = [
  { email: "mario.rossi@example.com", partyId: "p-mario" },
  { email: "orders@brand.it", partyId: "p-brand", matchDomain: true },
  { email: "sales@other.it", partyId: "p-other", matchDomain: false },
];

describe("matchPartyId", () => {
  it("exact email wins (case-insensitive)", () => {
    expect(matchPartyId("Mario.Rossi@Example.com", rows)).toBe("p-mario");
  });
  it("domain rows match any sender at that domain", () => {
    expect(matchPartyId("luca.bianchi@brand.it", rows)).toBe("p-brand");
    expect(matchPartyId("ORDERS@BRAND.IT", rows)).toBe("p-brand");
  });
  it("non-domain rows do NOT match by domain", () => {
    expect(matchPartyId("someone@other.it", rows)).toBeNull();
  });
  it("exact beats domain when both could apply", () => {
    const both = [
      { email: "vip@brand.it", partyId: "p-vip" },
      { email: "orders@brand.it", partyId: "p-brand", matchDomain: true },
    ];
    expect(matchPartyId("vip@brand.it", both)).toBe("p-vip");
  });
  it("unknown senders return null", () => {
    expect(matchPartyId("stranger@nowhere.dev", rows)).toBeNull();
  });
});

describe("domainOf", () => {
  it("extracts and lowercases", () => {
    expect(domainOf("A@B.It")).toBe("b.it");
    expect(domainOf("not-an-email")).toBeNull();
  });
});
