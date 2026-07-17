/**
 * FP3 — human document numbers (Q-1, ORD-1) from per-kind counters in
 * AppSetting. Single-writer SQLite under WAL + a transaction keeps two
 * concurrent creates from colliding.
 *
 * EPF1.1 (D-05/D-17) — `nextNumberTx` composes INSIDE a caller's transaction,
 * so mint + document create + audit commit or roll back together: a failure
 * mid-transaction burns no number and a concurrent mint can't collide (the
 * counter row write serializes on SQLite's single writer). Invoices are
 * year-keyed (`counter.invoice.2026` → `INV-2026-001`, zero-padded to 3);
 * pre-existing `INV-n` documents are untouched — the formats never collide.
 */
import { prisma } from "@/lib/db";

const PREFIX: Record<string, string> = { quote: "Q-", order: "ORD-", po: "PO-", invoice: "INV-" };

export type CounterKind = "quote" | "order" | "po" | "invoice";

/** AppSetting key for a counter — year-scoped when a year is given. */
export function counterKey(kind: CounterKind, year?: number): string {
  return year != null ? `counter.${kind}.${year}` : `counter.${kind}`;
}

/** Render the human number: plain (`ORD-7`) or year-segmented (`INV-2026-001`). */
export function formatDocNumber(kind: CounterKind, n: number, year?: number): string {
  return year != null ? `${PREFIX[kind]}${year}-${String(n).padStart(3, "0")}` : `${PREFIX[kind]}${n}`;
}

/** The slice of a transaction client (or a test fake) the mint needs. */
export type CounterStore = {
  appSetting: {
    findUnique(args: { where: { key: string } }): Promise<{ value: unknown } | null>;
    upsert(args: {
      where: { key: string };
      create: { key: string; value: object };
      update: { value: object };
    }): Promise<unknown>;
  };
};

/**
 * Mint the next number INSIDE the caller's transaction. All reads/writes go
 * through `tx`, so rolling the transaction back leaves the counter untouched
 * (no burned numbers — the D-05 atomicity fix).
 */
export async function nextNumberTx(tx: CounterStore, kind: CounterKind, year?: number): Promise<string> {
  const key = counterKey(kind, year);
  const row = await tx.appSetting.findUnique({ where: { key } });
  const next = (((row?.value as { n?: number })?.n ?? 0) as number) + 1;
  await tx.appSetting.upsert({ where: { key }, create: { key, value: { n: next } }, update: { value: { n: next } } });
  return formatDocNumber(kind, next, year);
}

/** Standalone mint in its own transaction (quotes/orders/POs — unchanged callers). */
export async function nextNumber(kind: CounterKind): Promise<string> {
  // structural cast: Prisma's generic delegates don't satisfy the narrow
  // CounterStore signature nominally, but the call shapes are identical
  return prisma.$transaction((tx) => nextNumberTx(tx as unknown as CounterStore, kind));
}
