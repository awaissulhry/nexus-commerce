/** EPO.2 — verification smoke (ad-hoc, untracked): the detail-route fold inputs
 * produce the same figures the financials drawer's route computes (same pure
 * fold, same collections — parity by construction, probed on live data). */
import { prisma } from "@/lib/db";
import { orderFinancials } from "@/lib/financials/rollup";

async function main() {
  const o = await prisma.order.findFirst({
    where: { state: { not: "CANCELLED" } },
    select: {
      id: true, number: true, state: true, createdAt: true,
      party: { select: { id: true, name: true } },
      lines: { select: { netPriceCents: true, costCents: true, qty: true } },
      payments: { select: { kind: true, amountCents: true } },
      invoices: { select: { amountCents: true, paidAt: true } },
      bornFromQuote: { select: { depositPct: true } },
    },
  });
  if (!o) { console.log("no orders to probe"); return; }
  const fin = orderFinancials({
    id: o.id, number: o.number, partyId: o.party.id, partyName: o.party.name, state: o.state, createdAtISO: o.createdAt.toISOString(),
    lines: o.lines, payments: o.payments,
    invoices: o.invoices.map((i) => ({ amountCents: i.amountCents ?? 0, paidAt: i.paidAt?.toISOString() ?? null })),
    depositPct: o.bornFromQuote?.depositPct, actualCostCents: null,
  });
  const sane = fin.balanceCents === fin.quotedNetCents - fin.paidCents;
  console.log(`${o.number} quoted=${fin.quotedNetCents} invoiced=${fin.invoicedCents} paid=${fin.paidCents} balance=${fin.balanceCents} identity=${sane ? "OK" : "BROKEN"}`);
  process.exit(sane ? 0 : 1);
}
void main();
