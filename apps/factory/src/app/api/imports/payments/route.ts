/**
 * FP9.3 — bank-CSV payment import, the dry-run idiom: paste a statement, the app
 * proposes which order each line pays (reference in the description, else exact
 * amount), and NOTHING is written until the Owner confirms the subset. Applying
 * creates BALANCE payments (needs payments.record on top of imports.run). This
 * matches to orders — it is not bank reconciliation.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { hasPermission } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { orderTotals } from "@/lib/orders/money";
import { parseBankCsv, matchBankRows, type MatchTarget } from "@/lib/financials/bank-match";

export const permission = FEATURES.importsRun;

const Body = z.object({
  rawCsv: z.string().optional(),
  apply: z.array(z.object({ orderId: z.string().min(1), amountCents: z.number().int().positive(), note: z.string().max(200).optional() })).optional(),
});

export const POST = guarded(FEATURES.importsRun, async (req, { actor, resolved }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  // ── apply confirmed matches → BALANCE payments ──
  if (parsed.data.apply && parsed.data.apply.length > 0) {
    if (!hasPermission(resolved!, FEATURES.paymentsRecord)) return NextResponse.json({ error: "You can't record payments" }, { status: 403 });
    let created = 0;
    for (const a of parsed.data.apply) {
      const order = await prisma.order.findUnique({ where: { id: a.orderId }, select: { id: true } });
      if (!order) continue;
      const p = await prisma.payment.create({ data: { orderId: a.orderId, kind: "BALANCE", amountCents: a.amountCents, method: "bank import", notes: a.note ?? null }, select: { id: true } });
      void audit({ actorId: actor!.id, entityType: "payment", entityId: p.id, action: "recorded", after: { orderId: a.orderId, kind: "BALANCE", via: "bank-import", amountCents: a.amountCents } });
      await publishEventDurable("payment.recorded", { orderId: a.orderId, paymentId: p.id, kind: "BALANCE" });
      created++;
    }
    return NextResponse.json({ ok: true, created });
  }

  // ── dry-run: parse + propose ──
  const rows = parseBankCsv(parsed.data.rawCsv ?? "");
  if (rows.length === 0) return jsonStripped({ proposals: [], note: "No rows parsed — expected a header naming date, amount and description columns." }, resolved);

  const orders = await prisma.order.findMany({
    where: { state: { notIn: ["CANCELLED"] } },
    select: { id: true, number: true, party: { select: { name: true } }, lines: { select: { netPriceCents: true, costCents: true, qty: true } }, payments: { select: { amountCents: true } }, invoices: { select: { number: true } } },
  });
  const targets: MatchTarget[] = orders.map((o) => {
    const net = orderTotals(o.lines).netCents;
    const paid = o.payments.reduce((s, p) => s + p.amountCents, 0);
    return { orderId: o.id, number: o.number, partyName: o.party.name, balanceCents: net - paid, invoiceNumbers: o.invoices.map((i) => i.number) };
  });
  return jsonStripped({ proposals: matchBankRows(rows, targets) }, resolved);
});
