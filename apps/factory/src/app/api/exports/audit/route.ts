/**
 * FS5 — audit-trail CSV export (new: the AuditLog previously had no export at
 * all). Append-only forever; this FULL-TABLE streamed CSV is its archival
 * path (docs/factory/FS5-RETENTION.md). Same id-cursor batch pattern as
 * exports/ledger — memory flat at 800k+ rows. Timestamps are full ISO (a
 * forensic timeline, not a day report); before/after ship as JSON cells
 * (toCsv quoting handles them). The export run itself lands in the audit
 * trail (EPF1 D-15-audit), like every other export.
 */
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { audit } from "@/lib/audit";
import { csvChunk } from "@/lib/csv";

export const permission = FEATURES.exportsRun;

const BATCH = 1000; // well under SQLite's bound-parameter limit (N-1)
const HEADERS = ["id", "date", "actor", "entity_type", "entity_id", "action", "before", "after"];

const json = (v: unknown): string => (v == null ? "" : JSON.stringify(v));

export const GET = guarded(FEATURES.exportsRun, async (_req, { actor }) => {
  const actorId = actor!.id;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(HEADERS.join(",")));
        let cursor = "";
        let total = 0;
        for (;;) {
          const entries = await prisma.auditLog.findMany({
            where: { id: { gt: cursor } },
            orderBy: { id: "asc" },
            take: BATCH, // bounded: id-cursor batch of the streamed archival export
            include: { actor: { select: { displayName: true } } },
          });
          if (entries.length === 0) break;
          const rows = entries.map((a) => [
            a.id,
            a.createdAt.toISOString(),
            a.actor?.displayName ?? "",
            a.entityType,
            a.entityId,
            a.action,
            json(a.before),
            json(a.after),
          ]);
          controller.enqueue(encoder.encode(csvChunk(rows)));
          total += entries.length;
          cursor = entries[entries.length - 1].id;
        }
        await audit({ actorId, entityType: "export", entityId: "audit", action: "run", after: { rows: total } });
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="audit.csv"' },
  });
});
