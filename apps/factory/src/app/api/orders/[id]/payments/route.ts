/**
 * FP4 → EPF1 — record a payment against an order (behind payments.record).
 * EPF1 (D-02/D-03/D-11/D-17): Σ payments ≤ net guard (409 `{overpayCents}`
 * unless `allowOverpay: true`); REFUND kind (negative amount + mandatory note,
 * audited `refund-recorded`); payment + audits + the FD13 deposit gate run in
 * ONE transaction, with the gate extracted to `lib/orders/deposit-gate` so the
 * bank import runs the IDENTICAL unblock rule; the Owner gets the money bell
 * (cross-review M3). Not a payments integration and not accounting (FP9): a
 * Payment row is a manual act.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { orderTotals, overpayCents } from "@/lib/orders/money";
import { PaymentBody } from "@/lib/orders/payment-schema";
import { parseBankDate } from "@/lib/financials/bank-match";
import { applyDepositGate, type DepositGateDb } from "@/lib/orders/deposit-gate";
import { paymentRecordedNotice } from "@/lib/financials/notify-money";
import { notifyOwners } from "@/lib/quotes/notify-owners";

export const permission = FEATURES.paymentsRecord;

export const POST = guarded(FEATURES.paymentsRecord, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = PaymentBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payment" }, { status: 400 });

  // C4 — replay? return the original outcome instead of recording twice.
  if (parsed.data.idempotencyKey) {
    const existing = await prisma.payment.findUnique({ where: { idempotencyKey: parsed.data.idempotencyKey }, select: { id: true, orderId: true } });
    if (existing) {
      if (existing.orderId !== id) return NextResponse.json({ error: "Idempotency key was used on another order" }, { status: 409 });
      return NextResponse.json({ ok: true, unblocked: 0, duplicate: true });
    }
  }

  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      lines: { select: { netPriceCents: true, costCents: true, qty: true } },
      payments: { select: { kind: true, amountCents: true } },
      bornFromQuote: { select: { depositPct: true } },
      workOrders: { select: { id: true, number: true, state: true } },
    },
  });
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // EPF1 (D-02/D-03): Σ payments ≤ net — overpaying is explicit, never silent.
  // Refunds (negative) can only lower the sum, so they always pass.
  const netCents = orderTotals(order.lines).netCents;
  const paidCents = order.payments.reduce((s, p) => s + (p.amountCents ?? 0), 0);
  const over = overpayCents(netCents, paidCents, parsed.data.amountCents);
  if (over > 0 && !parsed.data.allowOverpay) {
    return NextResponse.json(
      { error: `This would overpay ${order.number} by €${(over / 100).toFixed(2)} — €${(paidCents / 100).toFixed(2)} of €${(netCents / 100).toFixed(2)} is already recorded.`, overpayCents: over },
      { status: 409 },
    );
  }

  const isRefund = parsed.data.kind === "REFUND";
  let payment: { id: string };
  let unblocked = 0;
  try {
    // ONE transaction: payment + audit + deposit gate — commit together (D-17)
    const res = await prisma.$transaction(async (tx) => {
      // EPF2 — the modal's date field: value date as UTC midnight (bank-import convention)
      const receivedAt = parsed.data.receivedAt ? parseBankDate(parsed.data.receivedAt) : null;
      const p = await tx.payment.create({
        data: { orderId: id, kind: parsed.data.kind, amountCents: parsed.data.amountCents, method: parsed.data.method ?? null, notes: parsed.data.notes ?? null, idempotencyKey: parsed.data.idempotencyKey ?? null, ...(receivedAt ? { receivedAt } : {}) },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor!.id,
          entityType: "payment",
          entityId: p.id,
          action: isRefund ? "refund-recorded" : "recorded",
          after: { orderId: id, kind: parsed.data.kind, amountCents: parsed.data.amountCents, ...(over > 0 ? { overpayCents: over, allowOverpay: true } : {}) },
        },
      });
      // deposit gate (FD13): the ONE shared rule — see lib/orders/deposit-gate
      const gate = await applyDepositGate(
        tx as unknown as DepositGateDb,
        {
          id,
          lines: order.lines,
          payments: [...order.payments, { kind: parsed.data.kind, amountCents: parsed.data.amountCents }],
          depositPct: order.bornFromQuote?.depositPct,
          workOrders: order.workOrders,
        },
        actor!.id,
      );
      return { payment: p, unblocked: gate.unblocked };
    });
    payment = res.payment;
    unblocked = res.unblocked;
  } catch (err) {
    // unique(idempotencyKey) tripped — a concurrent double-submit lost the race
    if ((err as { code?: string }).code === "P2002") return NextResponse.json({ ok: true, unblocked: 0, duplicate: true });
    throw err;
  }

  await publishEventDurable("payment.recorded", { orderId: id, paymentId: payment.id, kind: parsed.data.kind });
  if (unblocked > 0) await publishEventDurable("workorder.updated", { orderId: id, unblocked });
  // cross-review M3: the money bell lands ONCE, here in the shared route
  await notifyOwners(paymentRecordedNotice({ orderId: id, orderNumber: order.number, paymentId: payment.id, amountCents: parsed.data.amountCents, kind: parsed.data.kind }));

  return NextResponse.json({ ok: true, unblocked });
});
