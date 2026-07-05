/** FP8.4 — shipments slice export. Cost column is grain-gated (financials.costs.view); the rest is operational. */
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES, FIELDS } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/csv";

export const permission = FEATURES.exportsRun;

export const GET = guarded(FEATURES.exportsRun, async (_req, { resolved }) => {
  const canCost = !!resolved && (resolved.isOwner || resolved.permissions.has(FIELDS.costsView));
  const shipments = await prisma.shipment.findMany({
    orderBy: { createdAt: "desc" },
    take: 5000,
    select: { createdAt: true, state: true, service: true, trackingNumber: true, costCents: true, order: { select: { number: true, party: { select: { name: true } } } } },
  });
  const headers = ["date", "order", "customer", "carrier_service", "tracking", "state", ...(canCost ? ["cost_eur"] : [])];
  const rows = shipments.map((s) => [
    s.createdAt.toISOString().slice(0, 10),
    s.order.number,
    s.order.party.name,
    s.service ?? "",
    s.trackingNumber ?? "",
    s.state,
    ...(canCost ? [s.costCents != null ? (s.costCents / 100).toFixed(2) : ""] : []),
  ]);
  return new Response(toCsv(headers, rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="shipments.csv"' } });
});
