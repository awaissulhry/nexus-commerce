/**
 * F1 — Party export (round-trip contract with the import). Financial-ish
 * columns (payment terms) are stripped for callers without the grain — the
 * exporter calls the filter EXPLICITLY (exports bypass JSON serialization;
 * F0-FINDINGS §8 gap, closed at birth).
 */
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES, FIELDS } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/csv";

export const permission = FEATURES.exportsRun;

export const GET = guarded(FEATURES.exportsRun, async (_req, { resolved }) => {
  const canTerms = !!resolved && (resolved.isOwner || resolved.permissions.has(FIELDS.suppliersView));
  const parties = await prisma.party.findMany({
    where: { archivedAt: null },
    include: { emails: true },
    orderBy: { name: "asc" },
  });
  const headers = ["kind", "name", "email", "currency", ...(canTerms ? ["payment_terms"] : []), "notes"];
  const rows = parties.map((p) => [
    p.kind,
    p.name,
    p.emails[0]?.email ?? "",
    p.currency,
    ...(canTerms ? [p.paymentTerms ?? ""] : []),
    p.notes ?? "",
  ]);
  return new Response(toCsv(headers, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="parties.csv"',
    },
  });
});
