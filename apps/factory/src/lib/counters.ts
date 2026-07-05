/**
 * FP3 — human document numbers (Q-1, ORD-1) from per-kind counters in
 * AppSetting. Single-writer SQLite under WAL + a transaction keeps two
 * concurrent creates from colliding.
 */
import { prisma } from "@/lib/db";

const PREFIX: Record<string, string> = { quote: "Q-", order: "ORD-", po: "PO-", invoice: "INV-" };

export async function nextNumber(kind: "quote" | "order" | "po" | "invoice"): Promise<string> {
  const key = `counter.${kind}`;
  const n = await prisma.$transaction(async (tx) => {
    const row = await tx.appSetting.findUnique({ where: { key } });
    const next = (((row?.value as { n?: number })?.n ?? 0) as number) + 1;
    await tx.appSetting.upsert({ where: { key }, create: { key, value: { n: next } }, update: { value: { n: next } } });
    return next;
  });
  return `${PREFIX[kind]}${n}`;
}
