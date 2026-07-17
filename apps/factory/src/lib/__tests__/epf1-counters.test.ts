/**
 * EPF1 (D-05/D-17) — year-keyed atomic invoice numbering. The mint composes
 * inside the CALLER's transaction: these tests drive `nextNumberTx` against an
 * in-memory AppSetting store with real rollback semantics, proving (1) the
 * INV-2026-001 format + per-year restart, (2) that a failure mid-transaction
 * burns no number, and (3) that legacy un-yeared counters are untouched.
 */
import { describe, expect, it } from "vitest";
import { counterKey, formatDocNumber, nextNumberTx, type CounterStore } from "../counters";

/** In-memory AppSetting store with snapshot/rollback — a faithful stand-in for a SQLite tx. */
function makeStore() {
  const rows = new Map<string, { value: unknown }>();
  const store: CounterStore = {
    appSetting: {
      findUnique: async ({ where }) => rows.get(where.key) ?? null,
      upsert: async ({ where, create, update }) => {
        rows.set(where.key, { value: rows.has(where.key) ? update.value : create.value });
        return {};
      },
    },
  };
  const transaction = async <T>(fn: (tx: CounterStore) => Promise<T>): Promise<T> => {
    const snapshot = new Map([...rows.entries()].map(([k, v]) => [k, { ...v }]));
    try {
      return await fn(store);
    } catch (err) {
      rows.clear();
      for (const [k, v] of snapshot) rows.set(k, v);
      throw err;
    }
  };
  return { rows, store, transaction };
}

describe("counterKey / formatDocNumber", () => {
  it("year-scoped keys and zero-padded year numbers", () => {
    expect(counterKey("invoice", 2026)).toBe("counter.invoice.2026");
    expect(counterKey("order")).toBe("counter.order");
    expect(formatDocNumber("invoice", 1, 2026)).toBe("INV-2026-001");
    expect(formatDocNumber("invoice", 42, 2026)).toBe("INV-2026-042");
    expect(formatDocNumber("invoice", 1234, 2026)).toBe("INV-2026-1234"); // pads to 3, never truncates
    expect(formatDocNumber("order", 7)).toBe("ORD-7"); // legacy format untouched
  });
});

describe("nextNumberTx", () => {
  it("mints a per-year sequence and restarts at the year boundary", async () => {
    const { store } = makeStore();
    expect(await nextNumberTx(store, "invoice", 2026)).toBe("INV-2026-001");
    expect(await nextNumberTx(store, "invoice", 2026)).toBe("INV-2026-002");
    expect(await nextNumberTx(store, "invoice", 2027)).toBe("INV-2027-001"); // new year, new sequence
    expect(await nextNumberTx(store, "invoice", 2026)).toBe("INV-2026-003"); // 2026 unaffected
  });
  it("a failure mid-transaction burns NOTHING (D-05 atomicity)", async () => {
    const { store, transaction } = makeStore();
    await transaction(async (tx) => nextNumberTx(tx, "invoice", 2026)); // INV-2026-001 committed
    await expect(
      transaction(async (tx) => {
        await nextNumberTx(tx, "invoice", 2026); // would be 002…
        throw new Error("invoice create failed");
      }),
    ).rejects.toThrow("invoice create failed");
    // …but the rollback returned the counter — the next mint is 002, not 003
    expect(await transaction(async (tx) => nextNumberTx(tx, "invoice", 2026))).toBe("INV-2026-002");
  });
  it("the year-keyed counter never touches the legacy `counter.invoice` row", async () => {
    const { rows, store } = makeStore();
    rows.set("counter.invoice", { value: { n: 9 } }); // pre-existing INV-9 world
    await nextNumberTx(store, "invoice", 2026);
    expect((rows.get("counter.invoice")?.value as { n: number }).n).toBe(9);
    expect((rows.get("counter.invoice.2026")?.value as { n: number }).n).toBe(1);
  });
  it("un-yeared kinds keep the plain format through the same code path", async () => {
    const { store } = makeStore();
    expect(await nextNumberTx(store, "order")).toBe("ORD-1");
    expect(await nextNumberTx(store, "order")).toBe("ORD-2");
  });
});
