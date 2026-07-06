/**
 * FF2.8b — Flat-file import routes.
 *
 * All routes require the `products.import` permission (RBAC manifest entry added
 * before the /api/flat-file catch-all).
 *
 * Endpoints:
 *   POST /api/flat-file/import/preview        — parse + diff, persist PREVIEW record
 *   POST /api/flat-file/import/:id/apply      — re-preview against live DB, apply + persist
 *   GET  /api/flat-file/imports               — list import history
 *   GET  /api/flat-file/import/:id            — fetch one record (incl. diff for UI)
 *   GET  /api/flat-file/import/:id/report     — download annotated xlsx report
 *
 * Safety guarantees:
 *   • The preview route writes NOTHING to the product catalog.
 *   • The apply route is the only catalog-mutating one.
 *   • applyDeletes is only called when diff.deletes.length > 0; a phrase mismatch
 *     returns a 400 with the expected phrase so the UI can prompt the operator.
 *   • The apply route re-runs previewImport against the current DB, so it applies
 *     the diff that reflects the live state at apply-time (not just at preview-time).
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { previewImport } from '../services/flat-file/import/import.service.js'
import { applyChanges, applyDeletes, deleteConfirmationPhrase } from '../services/flat-file/import/apply.js'
import type { ApplyResult } from '../services/flat-file/import/apply.js'
import { generateProcessingReport } from '../services/flat-file/import/report.js'
import type { ImportScope } from '../services/flat-file/import/scope.js'
import { getArtifactStore } from '../services/flat-file/artifact-store.js'
import {
  createPreviewRecord,
  recordApply,
  getImport,
  listImports,
} from '../services/flat-file/import/import-history.service.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// ── Route bodies ──────────────────────────────────────────────────────────────

interface PreviewBody {
  fileBase64: string
  filename?: string
  scope: ImportScope
}

interface ApplyBody {
  deleteConfirmation?: string
  conflictPolicy?: 'file-wins' | 'db-wins'
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const flatFileImportRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /flat-file/import/preview ────────────────────────────────────────
  //
  // Decode the uploaded xlsx, run a dry-run preview (no catalog writes),
  // persist the diff + artifact to allow a later apply call, return the diff
  // for the UI to render.
  fastify.post<{ Body: PreviewBody }>(
    '/flat-file/import/preview',
    async (request, reply) => {
      const { fileBase64, filename, scope } = request.body ?? ({} as PreviewBody)

      if (!fileBase64) {
        return reply.code(400).send({ success: false, error: 'fileBase64 is required' })
      }
      if (!scope?.channel) {
        return reply.code(400).send({ success: false, error: 'scope.channel is required' })
      }

      let bytes: Uint8Array
      try {
        bytes = Uint8Array.from(Buffer.from(fileBase64, 'base64'))
      } catch {
        return reply.code(400).send({ success: false, error: 'fileBase64 is not valid base64' })
      }

      try {
        // Persist the raw upload to the artifact store so apply can re-fetch it.
        const store = getArtifactStore()
        const uploadKey = 'ffimport-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
        const uploadHandle = await store.put(uploadKey, bytes, XLSX_MIME)

        // Dry-run preview: parse + validate + diff (no catalog writes).
        const preview = await previewImport(prisma, bytes, scope)

        // Persist the preview record.
        const { id } = await createPreviewRecord(prisma, {
          channel: scope.channel,
          markets: scope.markets,
          includeMaster: scope.includeMaster,
          snapshotId: preview.meta.snapshotId,
          filename,
          uploadHandle,
          diff: preview.diff,
        })

        return reply.send({
          success: true,
          importId: id,
          validation: preview.validation,
          diff: preview.diff,
          scope,
          meta: preview.meta,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(500).send({ success: false, error: msg })
      }
    },
  )

  // ── POST /flat-file/import/:id/apply ─────────────────────────────────────
  //
  // Re-run preview against the CURRENT DB state, apply the fresh diff, generate
  // + store the processing report, and update the import record.
  //
  // CATALOG-MUTATING — gated by products.import permission + typed delete
  // confirmation + the engine's scope/reversible guarantees.
  fastify.post<{ Params: { id: string }; Body: ApplyBody }>(
    '/flat-file/import/:id/apply',
    async (request, reply) => {
      const { id } = request.params
      const { deleteConfirmation, conflictPolicy } = request.body ?? {}

      // Load the persisted preview record.
      const record = await getImport(prisma, id)
      if (!record) {
        return reply.code(404).send({ success: false, error: 'Import record not found' })
      }
      if (record.status !== 'PREVIEW') {
        return reply.code(409).send({
          success: false,
          error: 'Import has already been applied',
          status: record.status,
        })
      }
      if (!record.uploadHandle) {
        return reply.code(409).send({ success: false, error: 'Upload artifact not available for re-apply' })
      }

      // Reconstruct the scope from the persisted record.
      const scope: ImportScope = {
        channel: record.channel as ImportScope['channel'],
        markets: record.markets as string[] | 'ALL',
        includeMaster: record.includeMaster as boolean,
      }

      // Fetch the stored artifact bytes.
      const store = getArtifactStore()
      const bytes = await store.get(record.uploadHandle)
      if (!bytes) {
        return reply.code(409).send({ success: false, error: 'Upload artifact not found in store' })
      }

      try {
        // Re-run preview against the CURRENT DB state so the apply reflects any
        // changes made between preview and apply time.
        const fresh = await previewImport(prisma, bytes, scope)

        // Apply non-delete cell changes.
        const changed = await applyChanges(prisma, fresh.diff, {
          scope,
          conflictPolicy: conflictPolicy ?? 'file-wins',
        })

        // Apply row-level deletes (if any). Requires typed confirmation phrase.
        let deleted: ApplyResult = { applied: 0, skipped: 0, failed: 0, rows: [], inverseDiff: [] }
        if (fresh.diff.deletes.length > 0) {
          try {
            deleted = await applyDeletes(prisma, fresh.diff, {
              deleteConfirmation: deleteConfirmation ?? '',
            })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg === 'delete confirmation phrase does not match') {
              return reply.code(400).send({
                success: false,
                error: 'confirmation_required',
                phrase: deleteConfirmationPhrase(fresh.diff),
              })
            }
            throw err
          }
        }

        // Combine apply results.
        const combinedApply: ApplyResult = {
          applied: changed.applied + deleted.applied,
          skipped: changed.skipped + deleted.skipped,
          failed: changed.failed + deleted.failed,
          rows: [...changed.rows, ...deleted.rows],
          inverseDiff: [...changed.inverseDiff, ...deleted.inverseDiff],
        }

        const finalStatus: 'APPLIED' | 'FAILED' = combinedApply.failed > 0 ? 'FAILED' : 'APPLIED'

        // Generate + store the annotated processing report.
        let reportHandle: string | undefined
        try {
          const reportBytes = await generateProcessingReport(bytes, {
            validation: fresh.validation,
            apply: combinedApply,
          })
          const reportKey = 'ffimport-report-' + id
          reportHandle = await store.put(reportKey, reportBytes, XLSX_MIME)
        } catch {
          // Report generation failure is non-fatal — import still recorded.
        }

        // Persist the apply result.
        await recordApply(prisma, id, {
          inverseDiff: combinedApply.inverseDiff,
          appliedCount: combinedApply.applied,
          skippedCount: combinedApply.skipped,
          failedCount: combinedApply.failed,
          status: finalStatus,
          reportHandle,
        })

        return reply.send({
          success: true,
          importId: id,
          status: finalStatus,
          applied: combinedApply.applied,
          skipped: combinedApply.skipped,
          failed: combinedApply.failed,
          rows: combinedApply.rows,
          reportHandle: reportHandle ?? null,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(500).send({ success: false, error: msg })
      }
    },
  )

  // ── GET /flat-file/imports ────────────────────────────────────────────────
  //
  // List import history, most-recent first.
  // Query params: channel (AMAZON|EBAY|SHOPIFY), limit (default 50).
  fastify.get<{ Querystring: { channel?: string; limit?: string } }>(
    '/flat-file/imports',
    async (request, reply) => {
      const { channel, limit } = request.query ?? {}
      const records = await listImports(prisma, {
        channel,
        limit: limit ? Math.min(Number(limit), 200) : undefined,
      })
      return reply.send({ success: true, imports: records })
    },
  )

  // ── GET /flat-file/import/:id ─────────────────────────────────────────────
  //
  // Fetch a single import record (includes diff for UI rendering).
  fastify.get<{ Params: { id: string } }>(
    '/flat-file/import/:id',
    async (request, reply) => {
      const record = await getImport(prisma, request.params.id)
      if (!record) {
        return reply.code(404).send({ success: false, error: 'Import record not found' })
      }
      return reply.send({ success: true, import: record })
    },
  )

  // ── GET /flat-file/import/:id/report ─────────────────────────────────────
  //
  // Download the annotated xlsx processing report for a completed import.
  // Returns 404 if the import has no report (e.g. not yet applied).
  fastify.get<{ Params: { id: string } }>(
    '/flat-file/import/:id/report',
    async (request, reply) => {
      const record = await getImport(prisma, request.params.id)
      if (!record) {
        return reply.code(404).send({ success: false, error: 'Import record not found' })
      }
      if (!record.reportHandle) {
        return reply.code(404).send({ success: false, error: 'No report available for this import' })
      }

      const store = getArtifactStore()
      const bytes = await store.get(record.reportHandle)
      if (!bytes) {
        return reply.code(404).send({ success: false, error: 'Report artifact not found in store' })
      }

      const safeFilename = `import-report-${record.id}.xlsx`
      reply
        .header('Content-Type', XLSX_MIME)
        .header('Content-Disposition', `attachment; filename="${safeFilename}"`)
        .header('Content-Length', String(bytes.byteLength))
      return reply.send(bytes)
    },
  )
}

export default flatFileImportRoutes
