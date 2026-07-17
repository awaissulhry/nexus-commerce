/**
 * EPF1.6 (D-10/D-15) — the bank-import APPLY core, run inside ONE transaction
 * by the route. Per row: sha256 importKey dedupe (the same statement line can
 * never land twice — re-importing a CSV is a no-op), amount ≤ live balance
 * validation (errored, not applied), bank date → receivedAt, awaited audit,
 * and the SAME deposit-gate the FP4 payments route runs (unblock parity).
 * Structural db type so the exact production logic is unit-testable against
 * an in-memory fake; the real caller passes a Prisma transaction client.
 */
import { createHash } from "node:crypto";
import { orderTotals } from "../orders/money";
import { applyDepositGate, type DepositGateDb } from "../orders/deposit-gate";
import { parseBankDate } from "./bank-match";

/** Statement-row identity: same date + amount + description = the same bank movement. */
export function bankImportKey(row: { date: string; amountCents: number; description: string }): string {
  return createHash("sha256").update(`${row.date}|${row.amountCents}|${row.description}`).digest("hex");
}

export type BankApplyRow = {
  orderId: string;
  amountCents: number;
  date: string;
  description: string;
  note?: string;
};

export type BankApplyRowResult =
  | { index: number; status: "created"; orderId: string; orderNumber: string; paymentId: string; amountCents: number; unblocked: number }
  | { index: number; status: "skipped"; orderId: string; reason: "duplicate" }
  | { index: number; status: "error"; orderId: string; reason: string };

export type BankApplyDb = DepositGateDb & {
  payment: {
    findUnique(args: { where: { importKey: string }; select: { id: true } }): Promise<{ id: string } | null>;
    create(args: {
      data: {
        orderId: string;
        kind: "BALANCE";
        amountCents: number;
        method: string;
        notes: string | null;
        importKey: string;
        receivedAt: Date;
      };
      select: { id: true };
    }): Promise<{ id: string }>;
  };
  order: {
    findUnique(args: {
      where: { id: string };
      select: {
        id: true;
        number: true;
        lines: { select: { netPriceCents: true; costCents: true; qty: true } };
        payments: { select: { kind: true; amountCents: true } };
        bornFromQuote: { select: { depositPct: true } };
        workOrders: { select: { id: true; number: true; state: true } };
      };
    }): Promise<{
      id: string;
      number: string;
      lines: { netPriceCents: number; costCents: number; qty: number }[];
      payments: { kind: string; amountCents: number }[];
      bornFromQuote: { depositPct: number | null } | null;
      workOrders: { id: string; number: string; state: string }[];
    } | null>;
  };
};

export async function applyBankRows(
  db: BankApplyDb,
  rows: BankApplyRow[],
  actorId: string | null,
): Promise<BankApplyRowResult[]> {
  const results: BankApplyRowResult[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const importKey = bankImportKey(row);

    // idempotency: the same statement line (this run or any earlier run) is skipped
    const dupe = await db.payment.findUnique({ where: { importKey }, select: { id: true } });
    if (dupe) {
      results.push({ index, status: "skipped", orderId: row.orderId, reason: "duplicate" });
      continue;
    }

    const order = await db.order.findUnique({
      where: { id: row.orderId },
      select: {
        id: true,
        number: true,
        lines: { select: { netPriceCents: true, costCents: true, qty: true } },
        payments: { select: { kind: true, amountCents: true } },
        bornFromQuote: { select: { depositPct: true } },
        workOrders: { select: { id: true, number: true, state: true } },
      },
    });
    if (!order) {
      results.push({ index, status: "error", orderId: row.orderId, reason: "order not found" });
      continue;
    }

    // amount ≤ LIVE balance (recomputed inside the transaction — earlier rows
    // of this very import already count). Errored, not applied; the manual
    // payments route with allowOverpay is the deliberate escape hatch.
    const netCents = orderTotals(order.lines).netCents;
    const paidCents = order.payments.reduce((s, p) => s + (p.amountCents ?? 0), 0);
    const balanceCents = netCents - paidCents;
    if (row.amountCents > balanceCents) {
      results.push({
        index,
        status: "error",
        orderId: row.orderId,
        reason: `amount exceeds ${order.number}'s open balance (€${(Math.max(0, balanceCents) / 100).toFixed(2)})`,
      });
      continue;
    }

    const bankDate = parseBankDate(row.date);
    const payment = await db.payment.create({
      data: {
        orderId: order.id,
        kind: "BALANCE",
        amountCents: row.amountCents,
        method: "bank import",
        notes: row.note ?? (row.description || null),
        importKey,
        receivedAt: bankDate ?? new Date(),
      },
      select: { id: true },
    });
    await db.auditLog.create({
      data: {
        actorId,
        entityType: "payment",
        entityId: payment.id,
        action: "recorded",
        after: { orderId: order.id, kind: "BALANCE", via: "bank-import", amountCents: row.amountCents, importKey, bankDate: bankDate ? bankDate.toISOString().slice(0, 10) : null },
      },
    });

    // unblock parity (D-10): the SAME gate the FP4 payments route runs
    const gate = await applyDepositGate(
      db,
      {
        id: order.id,
        lines: order.lines,
        payments: [...order.payments, { kind: "BALANCE", amountCents: row.amountCents }],
        depositPct: order.bornFromQuote?.depositPct,
        workOrders: order.workOrders,
      },
      actorId,
    );

    results.push({ index, status: "created", orderId: order.id, orderNumber: order.number, paymentId: payment.id, amountCents: row.amountCents, unblocked: gate.unblocked });
  }
  return results;
}
