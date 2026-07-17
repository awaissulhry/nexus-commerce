/**
 * FP7 — movement-ledger slice export (append-only paper trail; quantities, not
 * money — no grain gate needed). EPF1 (D-15-audit): every export run is audited.
 */
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { audit } from "@/lib/audit";
import { toCsv } from "@/lib/csv";

export const permission = FEATURES.exportsRun;

export const GET = guarded(FEATURES.exportsRun, async (_req, { actor }) => {
  const moves = await prisma.movementLedger.findMany({
    orderBy: { createdAt: "desc" },
    take: 5000,
    include: { material: { select: { name: true, unit: true } }, lot: { select: { lotCode: true } }, actor: { select: { displayName: true } } },
  });
  const headers = ["date", "material", "unit", "type", "qty", "reason", "ref_type", "ref_id", "lot", "actor"];
  const rows = moves.map((m) => [m.createdAt.toISOString().slice(0, 10), m.material.name, m.material.unit, m.type, m.qty, m.reason ?? "", m.refType ?? "", m.refId ?? "", m.lot?.lotCode ?? "", m.actor?.displayName ?? ""]);
  await audit({ actorId: actor!.id, entityType: "export", entityId: "ledger", action: "run", after: { rows: rows.length } });
  return new Response(toCsv(headers, rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="ledger.csv"' } });
});
