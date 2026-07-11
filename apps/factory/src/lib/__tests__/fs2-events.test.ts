/**
 * FS2 — event-hub delivery semantics: id-dedupe (local dispatch + shared
 * poller double delivery collapses), userId scoping (targeted events reach
 * only their user but still advance every connection's cursor), and outbox
 * row decoding (scope un-smuggled from the payload's reserved key).
 */
import { describe, expect, it } from "vitest";
import { rowToEvent, shouldDeliver, type FactoryEvent } from "../events";

const ev = (id: number, extra?: Partial<FactoryEvent>): FactoryEvent => ({
  id,
  type: "order.updated",
  ts: 1,
  ...extra,
});

describe("FS2 shouldDeliver", () => {
  it("dedupes ids at or below the connection cursor", () => {
    const conn = { userId: "u1", lastId: 10 };
    expect(shouldDeliver(conn, ev(10))).toBe("skip-dupe");
    expect(shouldDeliver(conn, ev(9))).toBe("skip-dupe");
    expect(shouldDeliver(conn, ev(11))).toBe("send");
  });

  it("id 0 (ping/resync) is never deduped", () => {
    expect(shouldDeliver({ userId: null, lastId: 999 }, ev(0, { type: "ping" }))).toBe("send");
  });

  it("scoped events reach only the target user", () => {
    const scoped = ev(11, { type: "notification.created", scope: { userId: "u2" } });
    expect(shouldDeliver({ userId: "u1", lastId: 10 }, scoped)).toBe("skip-scope");
    expect(shouldDeliver({ userId: "u2", lastId: 10 }, scoped)).toBe("send");
    expect(shouldDeliver({ userId: null, lastId: 10 }, scoped)).toBe("skip-scope");
  });

  it("unscoped events broadcast", () => {
    expect(shouldDeliver({ userId: "anyone", lastId: 0 }, ev(1))).toBe("send");
  });

  it("dupe check wins over scope check (cursor already advanced)", () => {
    const scoped = ev(5, { scope: { userId: "u2" } });
    expect(shouldDeliver({ userId: "u2", lastId: 5 }, scoped)).toBe("skip-dupe");
  });
});

describe("FS2 rowToEvent", () => {
  const at = new Date("2026-07-11T10:00:00.000Z");

  it("decodes a plain row", () => {
    const e = rowToEvent({ id: 7, type: "pricing.updated", payload: { quoteId: "q1" }, createdAt: at });
    expect(e).toEqual({ id: 7, type: "pricing.updated", ts: at.getTime(), payload: { quoteId: "q1" }, scope: undefined });
  });

  it("un-smuggles scope and strips the reserved key", () => {
    const e = rowToEvent({
      id: 8,
      type: "notification.created",
      payload: { userId: "u9", __scope: { userId: "u9" } },
      createdAt: at,
    });
    expect(e.scope).toEqual({ userId: "u9" });
    expect(e.payload).toEqual({ userId: "u9" });
    expect(Object.keys(e.payload!)).not.toContain("__scope");
  });

  it("null payload → undefined", () => {
    const e = rowToEvent({ id: 9, type: "ping", payload: null, createdAt: at });
    expect(e.payload).toBeUndefined();
  });
});
