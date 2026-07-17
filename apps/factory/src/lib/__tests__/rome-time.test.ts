/**
 * EPF1 (D-13) — Europe/Rome calendar math must survive month boundaries and
 * BOTH DST transitions: Rome is +01:00 (CET) in winter and +02:00 (CEST) in
 * summer, so late-evening UTC instants belong to the NEXT Rome day/month.
 */
import { describe, expect, it } from "vitest";
import { romeMonthKey, romeDayKey, romeYear, romeOffsetMinutes, romeDayStartUtc, romeDayEndUtc, romeDayWindowUtc } from "../financials/rome-time";

describe("romeMonthKey", () => {
  it("year boundary: 31 Dec 23:30Z is already January in Rome (CET +1)", () => {
    expect(romeMonthKey("2026-12-31T23:30:00.000Z")).toBe("2027-01");
  });
  it("summer month boundary: 30 Jun 23:30Z is July in Rome (CEST +2)", () => {
    expect(romeMonthKey("2026-06-30T23:30:00.000Z")).toBe("2026-07");
  });
  it("winter 23:30Z on 31 Jan flips; 22:30Z does not (offset is +1, not +2)", () => {
    expect(romeMonthKey("2026-01-31T23:30:00.000Z")).toBe("2026-02");
    expect(romeMonthKey("2026-01-31T22:30:00.000Z")).toBe("2026-01");
  });
  it("summer 22:30Z on 31 Jul flips (offset +2)", () => {
    expect(romeMonthKey("2026-07-31T22:30:00.000Z")).toBe("2026-08");
  });
  it("plain instants stay in their month; unparseable input falls back to its prefix", () => {
    expect(romeMonthKey("2026-03-15T12:00:00.000Z")).toBe("2026-03");
    expect(romeMonthKey("2026-05")).toBe("2026-05");
  });
  it("DST transition days keep their Rome date (29 Mar 2026 starts CEST; 25 Oct ends it)", () => {
    expect(romeMonthKey("2026-03-29T01:30:00.000Z")).toBe("2026-03");
    expect(romeMonthKey("2026-10-25T01:30:00.000Z")).toBe("2026-10");
  });
});

describe("romeDayKey / romeYear / romeOffsetMinutes", () => {
  it("day flips with the Rome offset", () => {
    expect(romeDayKey("2026-07-14T22:30:00.000Z")).toBe("2026-07-15");
    expect(romeDayKey("2026-01-14T22:30:00.000Z")).toBe("2026-01-14");
  });
  it("year is the Rome year (invoice counters key on it)", () => {
    expect(romeYear("2026-12-31T23:30:00.000Z")).toBe(2027);
    expect(romeYear("2026-06-01T00:00:00.000Z")).toBe(2026);
  });
  it("offset is +60 in winter, +120 in summer", () => {
    expect(romeOffsetMinutes(Date.parse("2026-01-15T12:00:00Z"))).toBe(60);
    expect(romeOffsetMinutes(Date.parse("2026-07-15T12:00:00Z"))).toBe(120);
  });
});

describe("romeDayWindowUtc", () => {
  it("July midnight Rome = 22:00Z the day before (CEST)", () => {
    expect(romeDayStartUtc("2026-07-15")?.toISOString()).toBe("2026-07-14T22:00:00.000Z");
    expect(romeDayEndUtc("2026-07-15")?.toISOString()).toBe("2026-07-15T21:59:59.999Z");
  });
  it("January midnight Rome = 23:00Z the day before (CET)", () => {
    expect(romeDayStartUtc("2026-01-15")?.toISOString()).toBe("2026-01-14T23:00:00.000Z");
  });
  it("builds partial windows and tolerates long ISO inputs; none ⇒ undefined", () => {
    const w = romeDayWindowUtc("2026-07-01T00:00:00.000Z", null);
    expect(w?.gte?.toISOString()).toBe("2026-06-30T22:00:00.000Z");
    expect(w?.lte).toBeUndefined();
    expect(romeDayWindowUtc(null, null)).toBeUndefined();
    expect(romeDayWindowUtc("garbage", "junk")).toBeUndefined();
  });
});
