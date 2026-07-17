/**
 * FP7 — movement-ledger export (append-only paper trail; quantities, not
 * money — no grain gate needed). EPF1 (D-15-audit): every export run is
 * audited.
 * FS5 — the take-5000 truncation is gone: this is now the FULL-TABLE archival
 * export (docs/factory/FS5-RETENTION.md — the ledger is append-only forever;
 * this streamed CSV is the archival path). Streamed via id-cursor batches —
 * FS1's streamed-export pattern in its PK-keyset shape: the archival order is
 * insertion order, which cuid ids already carry, so no in-memory id spine is
 * needed and memory stays flat at 1.2M+ rows. Columns unchanged from FP7.
 */
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { audit } from "@/lib/audit";
import { csvChunk } from "@/lib/csv";

export const permission = FEATURES.exportsRun;

const BATCH = 1000; // well under SQLite's bound-parameter limit (N-1)
const HEADERS = ["date", "material", "unit", "type", "qty", "reason", "ref_type", "ref_id", "lot", "actor"];

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
          const moves = await prisma.movementLedger.findMany({
            where: { id: { gt: cursor } },
            orderBy: { id: "asc" },
            take: BATCH, // bounded: id-cursor batch of the streamed archival export
            include: {
              material: { select: { name: true, unit: true } },
              lot: { select: { lotCode: true } },
              actor: { select: { displayName: true } },
            },
          });
          if (moves.length === 0) break;
          const rows = moves.map((m) => [
            m.createdAt.toISOString().slice(0, 10),
            m.material.name,
            m.material.unit,
            m.type,
            m.qty,
            m.reason ?? "",
            m.refType ?? "",
            m.refId ?? "",
            m.lot?.lotCode ?? "",
            m.actor?.displayName ?? "",
          ]);
          controller.enqueue(encoder.encode(csvChunk(rows)));
          total += moves.length;
          cursor = moves[moves.length - 1].id;
        }
        await audit({ actorId, entityType: "export", entityId: "ledger", action: "run", after: { rows: total } });
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="ledger.csv"' },
  });
});
