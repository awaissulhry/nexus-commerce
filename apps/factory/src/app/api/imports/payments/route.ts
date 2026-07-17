/**
 * FP9.3 → EPF1 — bank-CSV payment import, the dry-run idiom: paste a statement,
 * the app proposes which order each line pays, and NOTHING is written until the
 * Owner confirms the subset (needs payments.record on top of imports.run).
 * EPF1 (D-10/D-15): dry-run targets come from the SHARED `loadOrderFinancials`
 * fold (the hand-forked full-hydration balance calc is gone) and settled-order
 * references are flagged; apply runs in ONE transaction through
 * `applyBankRows` — per-row sha256 importKey dedupe (the same CSV twice = 0
 * new payments), bank date → receivedAt, amount ≤ live balance, awaited
 * audits, and the SAME FD13 deposit gate the FP4 payments route runs.
 * This matches to orders — it is not bank reconciliation.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { hasPermission } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { parseBankCsv, matchBankRows, type MatchTarget } from "@/lib/financials/bank-match";
import { applyBankRows, type BankApplyDb } from "@/lib/financials/bank-apply";
import { loadOrderFinancials } from "@/lib/financials/load";
import { paymentRecordedNotice } from "@/lib/financials/notify-money";
import { notifyOwners } from "@/lib/quotes/notify-owners";

export const permission = FEATURES.importsRun;

const Body = z.object({
  rawCsv: z.string().optional(),
  apply: z
    .array(
      z.object({
        orderId: z.string().min(1),
        amountCents: z.number().int().positive(),
        // the statement row's identity — hashed into the idempotency key
        date: z.string().max(40).default(""),
        description: z.string().max(300).default(""),
        note: z.string().max(200).optional(),
      }),
    )
    .max(500)
    .optional(),
});

export const POST = guarded(FEATURES.importsRun, async (req, { actor, resolved }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  // ── apply confirmed matches → BALANCE payments, ONE transaction ──
  if (parsed.data.apply && parsed.data.apply.length > 0) {
    if (!hasPermission(resolved!, FEATURES.paymentsRecord)) return NextResponse.json({ error: "You can't record payments" }, { status: 403 });

    const results = await prisma.$transaction(async (tx) => applyBankRows(tx as unknown as BankApplyDb, parsed.data.apply!, actor!.id));

    // events + bells only AFTER the transaction committed
    const created = results.filter((r) => r.status === "created");
    const skipped = results.filter((r) => r.status === "skipped").length;
    const errors = results.filter((r) => r.status === "error");
    for (const c of created) {
      await publishEventDurable("payment.recorded", { orderId: c.orderId, paymentId: c.paymentId, kind: "BALANCE" });
      if (c.unblocked > 0) await publishEventDurable("workorder.updated", { orderId: c.orderId, unblocked: c.unblocked });
      // cross-review M3: money bells are EPF's, deep-linking the order
      await notifyOwners(paymentRecordedNotice({ orderId: c.orderId, orderNumber: c.orderNumber, paymentId: c.paymentId, amountCents: c.amountCents, kind: "BALANCE", via: "bank-import" }));
    }
    await publishEventDurable("import.finished", { entity: "payments", created: created.length, skipped, errors: errors.length });
    await audit({
      actorId: actor!.id,
      entityType: "import",
      entityId: "payments",
      action: "applied",
      after: { rows: parsed.data.apply.length, created: created.length, skipped, errors: errors.length },
    });

    return NextResponse.json({ ok: true, created: created.length, skipped, errors: errors.map((e) => ({ index: e.index, orderId: e.orderId, reason: e.reason })), results });
  }

  // ── dry-run: parse + propose (targets from the SHARED fold — D-15) ──
  const rows = parseBankCsv(parsed.data.rawCsv ?? "");
  if (rows.length === 0) return jsonStripped({ proposals: [], note: "No rows parsed — expected a header naming date, amount and description columns." }, resolved);

  const fins = await loadOrderFinancials(undefined, { sorted: false });
  const targets: MatchTarget[] = fins.map((f) => ({
    orderId: f.orderId,
    number: f.number,
    partyName: f.partyName,
    balanceCents: f.balanceCents,
    invoiceNumbers: f.invoiceNumbers,
  }));
  return jsonStripped({ proposals: matchBankRows(rows, targets) }, resolved);
});
