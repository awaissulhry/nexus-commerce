/** FC2 — the /chat shell's pure cores: run grouping, day dividers, rail math, URL law, window merge. */
import { describe, expect, it } from "vitest";
import {
  buildStream,
  chatUrl,
  clampMove,
  dayLabel,
  entityHref,
  filterSpaces,
  formatUnread,
  initialsOf,
  avatarHue,
  mergeNewestWindow,
  metaChip,
  railSnippet,
  relTime,
  RUN_GAP_MS,
  sortSpacesByActivity,
  spaceActivityAt,
  timeOfDay,
  type StreamMessage,
} from "@/lib/chat/ui";

// noon local time keeps every local-date assertion away from midnight edges
const NOW = new Date(2026, 6, 17, 12, 0, 0).getTime(); // 17 Jul 2026
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const msg = (over: Partial<StreamMessage>): StreamMessage => ({
  id: "m1",
  authorId: "u1",
  authorName: "Marco Rossi",
  kind: "MESSAGE",
  body: "hello",
  createdAt: at(0),
  ...over,
});

describe("buildStream — author runs + day dividers (the Google-Chat anatomy)", () => {
  it("groups consecutive same-author messages within the gap into one run", () => {
    const rows = buildStream(
      [
        msg({ id: "a", createdAt: at(-10 * 60_000) }),
        msg({ id: "b", createdAt: at(-9 * 60_000) }),
        msg({ id: "c", createdAt: at(-8 * 60_000) }),
      ],
      NOW,
    );
    // divider + 3 messages, only the first starts the run
    expect(rows.map((r) => r.kind)).toEqual(["divider", "message", "message", "message"]);
    expect(rows.filter((r) => r.kind === "message").map((r) => (r.kind === "message" ? r.runStart : null))).toEqual([true, false, false]);
  });

  it("a different author starts a new run", () => {
    const rows = buildStream([msg({ id: "a" }), msg({ id: "b", authorId: "u2", createdAt: at(60_000) })], NOW);
    const runs = rows.filter((r) => r.kind === "message").map((r) => (r.kind === "message" ? r.runStart : null));
    expect(runs).toEqual([true, true]);
  });

  it("a silence longer than RUN_GAP_MS starts a new run", () => {
    const rows = buildStream([msg({ id: "a" }), msg({ id: "b", createdAt: at(RUN_GAP_MS + 60_000) })], NOW);
    const runs = rows.filter((r) => r.kind === "message").map((r) => (r.kind === "message" ? r.runStart : null));
    expect(runs).toEqual([true, true]);
  });

  it("SYSTEM messages stand alone and break the surrounding run", () => {
    const rows = buildStream(
      [
        msg({ id: "a" }),
        msg({ id: "s", kind: "SYSTEM", authorId: null, body: "Deposit recorded", createdAt: at(30_000) }),
        msg({ id: "b", createdAt: at(60_000) }),
      ],
      NOW,
    );
    const runs = rows.filter((r) => r.kind === "message").map((r) => (r.kind === "message" ? r.runStart : null));
    expect(runs).toEqual([true, true, true]);
  });

  it("inserts a divider whenever the local day changes, and the divider breaks the run", () => {
    const rows = buildStream([msg({ id: "a", createdAt: at(-25 * 3_600_000) }), msg({ id: "b", createdAt: at(0) })], NOW);
    expect(rows.map((r) => r.kind)).toEqual(["divider", "message", "divider", "message"]);
    const second = rows[3];
    expect(second.kind === "message" && second.runStart).toBe(true);
    expect(rows[0].kind === "divider" && rows[0].label).toBe("Yesterday");
    expect(rows[2].kind === "divider" && rows[2].label).toBe("Today");
  });

  it("an empty stream renders no rows", () => {
    expect(buildStream([], NOW)).toEqual([]);
  });
});

describe("day + time labels", () => {
  it("Today / Yesterday / same-year / other-year", () => {
    expect(dayLabel(NOW, NOW)).toBe("Today");
    expect(dayLabel(NOW - 86_400_000, NOW)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 6, 14).getTime(), NOW)).toBe("Tue 14 Jul");
    expect(dayLabel(new Date(2025, 11, 31).getTime(), NOW)).toBe("31 Dec 2025");
  });

  it("relTime: now → minutes → same-day hours → Yesterday → dates", () => {
    expect(relTime(at(-30_000), NOW)).toBe("now");
    expect(relTime(at(-12 * 60_000), NOW)).toBe("12m");
    expect(relTime(at(-3 * 3_600_000), NOW)).toBe("3h");
    expect(relTime(at(-26 * 3_600_000), NOW)).toBe("Yesterday");
    expect(relTime(new Date(2026, 5, 2, 9, 0).toISOString(), NOW)).toBe("2 Jun");
    expect(relTime(new Date(2025, 0, 5, 9, 0).toISOString(), NOW)).toBe("5 Jan 2025");
  });

  it("timeOfDay is 24h zero-padded", () => {
    expect(timeOfDay(new Date(2026, 6, 17, 9, 5).toISOString())).toBe("09:05");
    expect(timeOfDay(new Date(2026, 6, 17, 14, 30).toISOString())).toBe("14:30");
  });
});

describe("mergeNewestWindow — the optimistic-composer reconcile", () => {
  it("server copies replace stale rows; unseen rows join in order", () => {
    const a = msg({ id: "a", createdAt: at(-3_000) });
    const b = msg({ id: "b", body: "old words", createdAt: at(-2_000) });
    const b2 = { ...b, body: "edited words", editedAt: at(-1_000) };
    const c = msg({ id: "c", createdAt: at(-500) });
    const merged = mergeNewestWindow([a, b], [b2, c]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged[1].body).toBe("edited words");
  });

  it("a pending optimistic row vanishes once its server copy arrives", () => {
    const pending = msg({ id: "tmp-1", body: "ciao", pending: true, createdAt: at(-2_000) });
    const server = msg({ id: "real-1", body: "ciao", createdAt: at(-1_500) });
    const merged = mergeNewestWindow([pending], [server]);
    expect(merged.map((m) => m.id)).toEqual(["real-1"]);
  });

  it("a pending row with no server copy survives the merge", () => {
    const pending = msg({ id: "tmp-2", body: "still sending", pending: true, createdAt: at(0) });
    const other = msg({ id: "x", authorId: "u2", body: "unrelated", createdAt: at(-1_000) });
    const merged = mergeNewestWindow([pending], [other]);
    expect(merged.map((m) => m.id)).toEqual(["x", "tmp-2"]);
  });

  it("result stays ascending by createdAt", () => {
    const m1 = msg({ id: "m1", createdAt: at(-5_000) });
    const m2 = msg({ id: "m2", createdAt: at(-1_000) });
    const m3 = msg({ id: "m3", createdAt: at(-3_000) });
    expect(mergeNewestWindow([m1, m2], [m3]).map((m) => m.id)).toEqual(["m1", "m3", "m2"]);
  });
});

describe("system deep links (house URL conventions)", () => {
  it("order → /orders?o= · quote → /quotes?q= · conversation → /inbox?focus=", () => {
    expect(entityHref("order", "o1")).toBe("/orders?o=o1");
    expect(entityHref("quote", "q1")).toBe("/quotes?q=q1");
    expect(entityHref("conversation", "c1")).toBe("/inbox?focus=c1");
    expect(entityHref("material", "m1")).toBeNull();
  });

  it("metaChip only renders for well-formed meta with a known convention (no dead links)", () => {
    expect(metaChip({ entityType: "order", entityId: "o1", event: "stage.advanced" })).toEqual({ href: "/orders?o=o1", label: "Open order" });
    expect(metaChip({ entityType: "material", entityId: "m1" })).toBeNull();
    expect(metaChip({ entityType: "order" })).toBeNull();
    expect(metaChip(null)).toBeNull();
    expect(metaChip("junk")).toBeNull();
  });

  it("chatUrl composes the ?space= deep link", () => {
    expect(chatUrl("s1")).toBe("/chat?space=s1");
    expect(chatUrl(null)).toBe("/chat");
  });
});

describe("rail math", () => {
  const space = (over: Record<string, unknown>) => ({
    name: "ORD-1 · Rossi",
    updatedAt: at(-10_000),
    lastMessage: null,
    ...over,
  });

  it("activity = latest message, falling back to the space row", () => {
    const withMsg = space({ lastMessage: { kind: "MESSAGE", body: "x", createdAt: at(-1_000) } });
    expect(spaceActivityAt(withMsg as never)).toBe(new Date(at(-1_000)).getTime());
    expect(spaceActivityAt(space({}) as never)).toBe(new Date(at(-10_000)).getTime());
  });

  it("sortSpacesByActivity puts the most recent first and does not mutate", () => {
    const a = space({ name: "A", lastMessage: { kind: "MESSAGE", body: "x", createdAt: at(-5_000) } });
    const b = space({ name: "B", lastMessage: { kind: "MESSAGE", body: "x", createdAt: at(-1_000) } });
    const input = [a, b];
    const sorted = sortSpacesByActivity(input as never[]);
    expect(sorted.map((s) => (s as { name: string }).name)).toEqual(["B", "A"]);
    expect((input[0] as { name: string }).name).toBe("A");
  });

  it("filterSpaces matches by name, case-insensitive; blank query passes through", () => {
    const list = [space({ name: "ORD-12 · Bertet" }), space({ name: "Cutting room" })] as never[];
    expect(filterSpaces(list, "bert").length).toBe(1);
    expect(filterSpaces(list, "  ").length).toBe(2);
    expect(filterSpaces(list, "zzz").length).toBe(0);
  });

  it("railSnippet: author-prefixed · system plain · tombstone · empty space", () => {
    expect(railSnippet({ kind: "MESSAGE", body: "the sleeves fit", authorName: "Marco Rossi", createdAt: at(0) })).toBe("Marco: the sleeves fit");
    expect(railSnippet({ kind: "SYSTEM", body: "Deposit recorded", createdAt: at(0) })).toBe("Deposit recorded");
    expect(railSnippet({ kind: "MESSAGE", body: "gone", deletedAt: at(0), createdAt: at(0) })).toBe("Message deleted");
    expect(railSnippet(null)).toBe("No messages yet");
  });

  it("formatUnread: empty at zero, capped at 99+", () => {
    expect(formatUnread(0)).toBe("");
    expect(formatUnread(7)).toBe("7");
    expect(formatUnread(99)).toBe("99");
    expect(formatUnread(1500)).toBe("99+");
  });

  it("clampMove never wraps and handles the empty list", () => {
    expect(clampMove(0, -1, 5)).toBe(0);
    expect(clampMove(4, 1, 5)).toBe(4);
    expect(clampMove(2, 1, 5)).toBe(3);
    expect(clampMove(0, 1, 0)).toBe(-1);
  });
});

describe("avatars", () => {
  it("initials: first + last word, uppercased; degenerate names survive", () => {
    expect(initialsOf("Marco Rossi")).toBe("MR");
    expect(initialsOf("Anna Maria Bianchi")).toBe("AB");
    expect(initialsOf("marco")).toBe("M");
    expect(initialsOf("  ")).toBe("?");
  });

  it("avatarHue is deterministic and in range", () => {
    expect(avatarHue("u1")).toBe(avatarHue("u1"));
    for (const id of ["u1", "u2", "su0", "cku8x"]) {
      const h = avatarHue(id);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});
