/** FS3 — AsyncCombobox core: debounce, cursor paging, stale-drop, keyboard math. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSearchController, moveActive, type SearchPage, type SearchState } from "@/lib/virtual/async-search";

const page = (values: string[], nextCursor: string | null = null): SearchPage => ({
  options: values.map((v) => ({ value: v, label: v.toUpperCase() })),
  nextCursor,
});

describe("createSearchController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces: three fast keystrokes make ONE loader call with the last q", async () => {
    const loader = vi.fn(async () => page(["a"]));
    let state: SearchState | null = null;
    const c = createSearchController({ loader, onState: (s) => (state = s) });

    c.setQuery("g");
    c.setQuery("gi");
    c.setQuery("gia");
    expect(loader).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(199);
    expect(loader).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith("gia", null);
    await vi.runAllTimersAsync();
    expect(state!.options.map((o) => o.value)).toEqual(["a"]);
    expect(state!.loading).toBe(false);
    c.dispose();
  });

  it("respects a custom debounceMs", async () => {
    const loader = vi.fn(async () => page([]));
    const c = createSearchController({ loader, debounceMs: 50, onState: () => {} });
    c.setQuery("x");
    await vi.advanceTimersByTimeAsync(49);
    expect(loader).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(loader).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it("load() fires immediately and cancels a pending debounce", async () => {
    const loader = vi.fn(async () => page([]));
    const c = createSearchController({ loader, onState: () => {} });
    c.setQuery("abc");
    c.load();
    expect(loader).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(loader).toHaveBeenCalledTimes(1); // the debounced call never double-fires
    c.dispose();
  });

  it("pages: loadMore appends with the cursor, dedupes, and updates nextCursor", async () => {
    const loader = vi.fn(async (_q: string, cursor: string | null) =>
      cursor === null ? page(["a", "b"], "b") : page(["b", "c"], null));
    let state: SearchState | null = null;
    const c = createSearchController({ loader, onState: (s) => (state = s) });

    c.load();
    await vi.runAllTimersAsync();
    expect(state!.nextCursor).toBe("b");

    c.loadMore();
    await vi.runAllTimersAsync();
    expect(loader).toHaveBeenLastCalledWith("", "b");
    expect(state!.options.map((o) => o.value)).toEqual(["a", "b", "c"]); // "b" deduped
    expect(state!.nextCursor).toBeNull();

    c.loadMore(); // no cursor left — no extra call
    expect(loader).toHaveBeenCalledTimes(2);
    c.dispose();
  });

  it("drops a stale first page: slow old-query response never overwrites the new one", async () => {
    const resolvers: Array<(p: SearchPage) => void> = [];
    const loader = vi.fn(() => new Promise<SearchPage>((res) => resolvers.push(res)));
    let state: SearchState | null = null;
    const c = createSearchController({ loader, onState: (s) => (state = s) });

    c.setQuery("old");
    await vi.advanceTimersByTimeAsync(200);
    c.setQuery("new");
    await vi.advanceTimersByTimeAsync(200);
    expect(loader).toHaveBeenCalledTimes(2);

    resolvers[1](page(["new-hit"])); // the NEW query lands first…
    await vi.runAllTimersAsync();
    resolvers[0](page(["old-hit"])); // …then the stale one arrives
    await vi.runAllTimersAsync();

    expect(state!.options.map((o) => o.value)).toEqual(["new-hit"]);
    c.dispose();
  });

  it("drops a stale loadMore when the query changed mid-page", async () => {
    let resolveMore: ((p: SearchPage) => void) | null = null;
    const loader = vi.fn((q: string, cursor: string | null) => {
      if (cursor) return new Promise<SearchPage>((res) => (resolveMore = res));
      return Promise.resolve(q === "" ? page(["a"], "a") : page(["z"]));
    });
    let state: SearchState | null = null;
    const c = createSearchController({ loader, onState: (s) => (state = s) });

    c.load();
    await vi.runAllTimersAsync();
    c.loadMore(); // in flight…
    c.setQuery("z"); // …query changes
    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTimersAsync();
    resolveMore!(page(["stale"]));
    await vi.runAllTimersAsync();

    expect(state!.options.map((o) => o.value)).toEqual(["z"]);
    c.dispose();
  });

  it("surfaces loader failure as error and recovers on the next query", async () => {
    const loader = vi
      .fn<(q: string, cursor: string | null) => Promise<SearchPage>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(page(["ok"]));
    let state: SearchState | null = null;
    const c = createSearchController({ loader, onState: (s) => (state = s) });

    c.load();
    await vi.runAllTimersAsync();
    expect(state!.error).toBe("boom");

    c.setQuery("retry");
    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTimersAsync();
    expect(state!.error).toBeNull();
    expect(state!.options.map((o) => o.value)).toEqual(["ok"]);
    c.dispose();
  });

  it("dispose() silences pending work (no onState after unmount)", async () => {
    const loader = vi.fn(async () => page(["late"]));
    const onState = vi.fn();
    const c = createSearchController({ loader, onState });
    c.load();
    c.dispose();
    await vi.runAllTimersAsync();
    // the emit for loading:true happened pre-dispose; nothing lands after
    const callsAfterDispose = onState.mock.calls.filter(([s]) => (s as SearchState).options.length > 0);
    expect(callsAfterDispose).toHaveLength(0);
  });
});

describe("moveActive (keyboard math)", () => {
  it("moves down and up within bounds", () => {
    expect(moveActive(0, 1, 5)).toBe(1);
    expect(moveActive(3, -1, 5)).toBe(2);
  });
  it("clamps at both ends", () => {
    expect(moveActive(4, 1, 5)).toBe(4);
    expect(moveActive(0, -1, 5)).toBe(0);
  });
  it("entering from nowhere lands on first/last", () => {
    expect(moveActive(-1, 1, 5)).toBe(0);
    expect(moveActive(-1, -1, 5)).toBe(4);
  });
  it("empty list stays inactive", () => {
    expect(moveActive(-1, 1, 0)).toBe(-1);
    expect(moveActive(2, 1, 0)).toBe(-1);
  });
});
