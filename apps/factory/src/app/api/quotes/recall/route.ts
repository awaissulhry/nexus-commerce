/**
 * EPQ.4 — recall pre-fill: "this party bought this garment before — last time
 * it sold for €X and REALLY cost €Y." Data = the latest SHIPPED+ order for
 * party+template (via its born-from quote's lines — order lines don't carry
 * templateId), actual cost from the FP6 ledger (EPF lib, read-only). The
 * editor shows it as a dismissible hint when a line picks that template —
 * never a write, never a prefill without the Owner's hand.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { orderActuals, SHIPPED_STATES } from "@/lib/quotes/actuals";

export const permission = PAGES.quotes;

export const GET = guarded(PAGES.quotes, async (req: NextRequest, { resolved }) => {
  const partyId = req.nextUrl.searchParams.get("partyId");
  const templateId = req.nextUrl.searchParams.get("templateId");
  if (!partyId || !templateId) return NextResponse.json({ recall: null });

  const order = await prisma.order.findFirst({
    where: {
      partyId,
      state: { in: [...SHIPPED_STATES] },
      bornFromQuote: { lines: { some: { templateId } } },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!order) return NextResponse.json({ recall: null });

  const actual = (await orderActuals([order.id])).get(order.id);
  if (!actual) return NextResponse.json({ recall: null });
  return jsonStripped(
    {
      recall: {
        orderId: actual.orderId,
        orderNumber: actual.orderNumber,
        soldNetCents: actual.soldNetCents,
        actualCostCents: actual.actualCostCents,
        estCostCents: actual.estCostCents,
      },
    },
    resolved,
  );
});
