/**
 * FP4 — record a payment against an order (behind payments.record). When a
 * DEPOSIT brings the order to its required deposit (FD13), any work order
 * BLOCKED "awaiting deposit" unblocks to READY — the gate opens. Not a payments
 * integration and not accounting (FP9): a Payment row is a manual act.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { orderTotals, depositRequiredCents, depositPaidCents, isDepositMet } from "@/lib/orders/money";

export const permission = FEATURES.paymentsRecord;

const Body = z.object({
  kind: z.enum(["DEPOSIT", "BALANCE", "OTHER"]).default("DEPOSIT"),
  amountCents: z.number().int().positive("Amount must be positive"),
  method: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(500).optional(),
  // EPO1.3 (C4) — minted once when the payment modal opens; retries and
  // double-clicks reuse it, so the money can only land once.
  idempotencyKey: z.string().trim().min(8).max(80).optional(),
});

export const POST = guarded(FEATURES.paymentsRecord, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
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

  let payment: { id: string };
  try {
    payment = await prisma.payment.create({
      data: { orderId: id, kind: parsed.data.kind, amountCents: parsed.data.amountCents, method: parsed.data.method ?? null, notes: parsed.data.notes ?? null, idempotencyKey: parsed.data.idempotencyKey ?? null },
      select: { id: true },
    });
  } catch (err) {
    // unique(idempotencyKey) tripped — a concurrent double-submit lost the race
    if ((err as { code?: string }).code === "P2002") return NextResponse.json({ ok: true, unblocked: 0, duplicate: true });
    throw err;
  }
  void audit({ actorId: actor!.id, entityType: "payment", entityId: payment.id, action: "recorded", after: { orderId: id, kind: parsed.data.kind, amountCents: parsed.data.amountCents } });
  await publishEventDurable("payment.recorded", { orderId: id, paymentId: payment.id, kind: parsed.data.kind });

  // deposit gate: does this bring us to the requirement? unblock the WO(s)
  let unblocked = 0;
  const required = depositRequiredCents(orderTotals(order.lines).netCents, order.bornFromQuote?.depositPct);
  const paidNow = depositPaidCents([...order.payments, { kind: parsed.data.kind, amountCents: parsed.data.amountCents }]);
  if (isDepositMet(required, paidNow)) {
    const blocked = order.workOrders.filter((w) => w.state === "BLOCKED");
    if (blocked.length > 0) {
      const res = await prisma.workOrder.updateMany({ where: { id: { in: blocked.map((w) => w.id) } }, data: { state: "READY", blockedReason: null } });
      unblocked = res.count;
      void audit({ actorId: actor!.id, entityType: "order", entityId: id, action: "deposit-met", after: { unblocked } });
      // EPO1.3 (C3) — per-WO trail: each unblock is its own audit row
      for (const w of blocked) {
        void audit({ actorId: actor!.id, entityType: "workorder", entityId: w.id, action: "unblocked", after: { orderId: id, number: w.number, via: "deposit-met" } });
      }
      await publishEventDurable("workorder.updated", { orderId: id, unblocked });
      // Cross-review M3: money-event bells (payment/deposit/invoice) are EPF's,
      // added ONCE in the shared route by their cycle — EPO keeps lifecycle
      // bells only (ready-to-ship, delivered). Deposit-met bell ceded.
    }
  }

  return NextResponse.json({ ok: true, unblocked });
});
