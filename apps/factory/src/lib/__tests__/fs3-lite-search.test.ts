/** FS3 — users-lite/parties-lite q+cursor grammar: param parsing + page slicing. */
import { describe, expect, it } from "vitest";
import { LITE_TAKE, pageSlice, parseLiteParams } from "@/lib/lite-search";

const sp = (qs: string) => new URLSearchParams(qs);

describe("parseLiteParams", () => {
  it("bare request keeps the legacy shape (not paged)", () => {
    expect(parseLiteParams(sp(""))).toEqual({ q: null, cursor: null, paged: false });
  });

  it("q opts into paging and is trimmed", () => {
    expect(parseLiteParams(sp("q=%20giulia%20"))).toEqual({ q: "giulia", cursor: null, paged: true });
  });

  it("an explicit blank q still pages (picker browsing page 1)", () => {
    expect(parseLiteParams(sp("q="))).toEqual({ q: null, cursor: null, paged: true });
    expect(parseLiteParams(sp("q=%20%20"))).toEqual({ q: null, cursor: null, paged: true });
  });

  it("cursor alone opts into paging", () => {
    expect(parseLiteParams(sp("cursor=abc123"))).toEqual({ q: null, cursor: "abc123", paged: true });
  });

  it("q + cursor both parse", () => {
    expect(parseLiteParams(sp("q=rossi&cursor=p42"))).toEqual({ q: "rossi", cursor: "p42", paged: true });
  });

  it("blank cursor is treated as absent (but still paged — it was explicit)", () => {
    expect(parseLiteParams(sp("cursor="))).toEqual({ q: null, cursor: null, paged: true });
  });
});

describe("pageSlice (take+1 → nextCursor)", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id${i}` }));

  it("a short page has no next cursor", () => {
    const { items, nextCursor } = pageSlice(rows(5), 30, (r) => r.id);
    expect(items).toHaveLength(5);
    expect(nextCursor).toBeNull();
  });

  it("exactly `take` rows has no next cursor", () => {
    const { items, nextCursor } = pageSlice(rows(30), 30, (r) => r.id);
    expect(items).toHaveLength(30);
    expect(nextCursor).toBeNull();
  });

  it("take+1 rows: surplus row is dropped and the LAST KEPT id becomes the cursor", () => {
    const { items, nextCursor } = pageSlice(rows(31), 30, (r) => r.id);
    expect(items).toHaveLength(30);
    expect(items[items.length - 1].id).toBe("id29");
    expect(nextCursor).toBe("id29");
  });

  it("empty result", () => {
    expect(pageSlice([], 30, (r: { id: string }) => r.id)).toEqual({ items: [], nextCursor: null });
  });

  it("LITE_TAKE is the contract page size", () => {
    expect(LITE_TAKE).toBe(30);
  });
});
