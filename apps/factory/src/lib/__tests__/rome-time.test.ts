/**
 * EPF1 (D-13) — Europe/Rome calendar math must survive month boundaries and
 * BOTH DST transitions: Rome is +01:00 (CET) in winter and +02:00 (CEST) in
 * summer, so late-evening UTC instants belong to the NEXT Rome day/month.
 */
import { describe, expect, it } from "vitest";
import { romeMonthKey, romeDayKey, romeYear, romeOffsetMinutes, romeDayStartUtc, romeDayEndUtc, romeDayWindowUtc, romeMonthWindowUtc } from "../financials/rome-time";

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
  // EPF2 — the picker windows must survive BOTH DST transitions and the year edge
  it("spring-forward day (29 Mar 2026, 23h long): opens CET 23:00Z, closes CEST 21:59:59.999Z", () => {
    const w = romeDayWindowUtc("2026-03-29", "2026-03-29")!;
    expect(w.gte?.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(w.lte?.toISOString()).toBe("2026-03-29T21:59:59.999Z");
  });
  it("fall-back day (25 Oct 2026, 25h long): opens CEST 22:00Z, closes CET 22:59:59.999Z", () => {
    const w = romeDayWindowUtc("2026-10-25", "2026-10-25")!;
    expect(w.gte?.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(w.lte?.toISOString()).toBe("2026-10-25T22:59:59.999Z");
  });
  it("year boundary window (31 Dec → 1 Jan) spans Rome midnight, CET both sides", () => {
    const w = romeDayWindowUtc("2025-12-31", "2026-01-01")!;
    expect(w.gte?.toISOString()).toBe("2025-12-30T23:00:00.000Z");
    expect(w.lte?.toISOString()).toBe("2026-01-01T22:59:59.999Z");
  });
});

describe("romeMonthWindowUtc (EPF1 hot-path tiles)", () => {
  it("summer month: [last-day-of-prev 22:00Z, last-day 22:00Z)", () => {
    const w = romeMonthWindowUtc("2026-07")!;
    expect(w.gte.toISOString()).toBe("2026-06-30T22:00:00.000Z");
    expect(w.lt.toISOString()).toBe("2026-07-31T22:00:00.000Z");
  });
  it("winter month + December→January year rollover (CET 23:00Z)", () => {
    const jan = romeMonthWindowUtc("2026-01")!;
    expect(jan.gte.toISOString()).toBe("2025-12-31T23:00:00.000Z");
    expect(jan.lt.toISOString()).toBe("2026-01-31T23:00:00.000Z");
    const dec = romeMonthWindowUtc("2026-12")!;
    expect(dec.lt.toISOString()).toBe("2026-12-31T23:00:00.000Z"); // = Rome midnight 2027-01-01
  });
  it("DST-straddling months: March starts CET (+1) and ends CEST (+2); October the reverse", () => {
    const mar = romeMonthWindowUtc("2026-03")!;
    expect(mar.gte.toISOString()).toBe("2026-02-28T23:00:00.000Z");
    expect(mar.lt.toISOString()).toBe("2026-03-31T22:00:00.000Z");
    const oct = romeMonthWindowUtc("2026-10")!;
    expect(oct.gte.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(oct.lt.toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });
  it("malformed keys ⇒ null", () => {
    expect(romeMonthWindowUtc("2026-13")).toBeNull();
    expect(romeMonthWindowUtc("2026-00")).toBeNull();
    expect(romeMonthWindowUtc("garbage")).toBeNull();
  });
  it("PROPERTY: t ∈ [gte, lt) ⟺ romeMonthKey(t) === monthKey (boundary ± instants, both DST regimes)", () => {
    for (const monthKey of ["2026-01", "2026-03", "2026-07", "2026-10", "2026-12", "2027-01"]) {
      const w = romeMonthWindowUtc(monthKey)!;
      for (const edge of [w.gte.getTime(), w.lt.getTime()]) {
        for (const delta of [-3600_001, -1, 0, 1, 3600_001]) {
          const t = edge + delta;
          const inside = t >= w.gte.getTime() && t < w.lt.getTime();
          expect(`${monthKey}@${t}:${romeMonthKey(new Date(t).toISOString()) === monthKey}`).toBe(`${monthKey}@${t}:${inside}`);
        }
      }
    }
  });
});
