/**
 * AX-IE.6 — apply a previewed bulksheet. The first thing here that writes.
 *
 * Every row goes through the EXISTING write path:
 *   ads-mutation.service → ads-write-gate → OutboundSyncQueue → ads-sync.worker
 *
 * The importer never calls Amazon directly. That matters because the gate is
 * where all the containment lives — env-live, production-connection, and a
 * per-campaign allowlist that is default-deny. A bulk upload must not be a way
 * around any of it.
 *
 * Per-row independent, partial success by default: refusing 4,000 good rows over
 * 3 bad ones is user-hostile. `strict` opts into all-or-nothing for people who
 * want it.
 *
 * Idempotency comes from ImportJobRow.status rather than a new table — a row
 * that already succeeded is skipped on re-run, so the natural recovery action
 * after a partial failure (upload it again) is safe rather than double-applying.
 */

import type { PrismaClient } from '@prisma/client'
import { parseMoney, parseVocabulary } from '@nexus/shared/ads-bulksheet'
import {
  updateCampaignWithSync, updateAdGroupWithSync, updateAdTargetWithSync, updatePortfolioWithSync,
  type AdsActor,
} from '../ads-mutation.service.js'
import type { PreviewRow } from './preview.js'
import { applyFields } from './field-map.js'

export interface ApplyOptions {
  actor: AdsActor
  /** False (default) queues through the gate without a live Amazon write. */
  applyImmediately: boolean
  /** All-or-nothing: abort the whole set on the first failure. */
  strict: boolean
  /**
   * What to do with rows whose edited fields also moved on Amazon.
   * 'skip' (default) is the safe answer; 'mine' overwrites deliberately.
   */
  conflicts: 'skip' | 'mine'
}

export interface ApplyRowResult {
  rowIndex: number
  entity: string
  targetId: string | null
  label: string
  outcome: 'APPLIED' | 'SKIPPED' | 'FAILED'
  message: string
}

export interface ApplyResult {
  changeSetId: string
  applied: number
  skipped: number
  failed: number
  aborted: boolean
  results: ApplyRowResult[]
}

const STATE_TO_DB: Record<string, 'ENABLED' | 'PAUSED' | 'ARCHIVED'> = {
  enabled: 'ENABLED', paused: 'PAUSED', archived: 'ARCHIVED',
}
const STRATEGY_TO_DB: Record<string, 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL'> = {
  'Dynamic bids – down only': 'LEGACY_FOR_SALES',
  'Dynamic bids – up and down': 'AUTO_FOR_SALES',
  'Fixed bid': 'MANUAL',
}

const nextOf = (row: PreviewRow, field: string): string | undefined =>
  row.diffs.find((d) => d.field === field)?.next

/**
 * Apply the rows a preview already resolved.
 *
 * `rows` is the preview's own output, so apply and preview cannot disagree about
 * what was going to happen — the caller has already checked that the plan token
 * still matches.
 */
export async function applyPlan(
  prisma: PrismaClient,
  jobId: string,
  rows: PreviewRow[],
  opts: ApplyOptions,
): Promise<ApplyResult> {
  // The change set: every AdvertisingActionLog row written below carries it, so
  // /actions/:changeSetId/rollback reverts the entire upload in one call.
  const changeSetId = `import:${jobId}`
  const out: ApplyResult = { changeSetId, applied: 0, skipped: 0, failed: 0, aborted: false, results: [] }

  // Rows already applied by an earlier run of this same job are skipped — this
  // is the idempotency guarantee, and it uses the staging table we already have.
  const done = new Set(
    (await prisma.importJobRow.findMany({ where: { jobId, status: 'SUCCESS' }, select: { rowIndex: true } }))
      .map((r) => r.rowIndex),
  )

  for (const row of rows) {
    const rec = (outcome: ApplyRowResult['outcome'], message: string) => {
      out.results.push({ rowIndex: row.rowIndex, entity: row.entity, targetId: row.targetId, label: row.label, outcome, message })
      if (outcome === 'APPLIED') out.applied++
      else if (outcome === 'SKIPPED') out.skipped++
      else out.failed++
    }

    if (done.has(row.rowIndex)) { rec('SKIPPED', 'Already applied by an earlier run of this import'); continue }
    if (row.status === 'UNCHANGED') { rec('SKIPPED', 'Nothing to change'); continue }
    if (row.status === 'UNRESOLVED') { rec('SKIPPED', row.note ?? 'Could not resolve the target entity'); continue }
    if (row.status === 'UNSUPPORTED') { rec('SKIPPED', row.note ?? 'This entity type cannot be applied yet'); continue }
    if (row.status === 'CONFLICT' && opts.conflicts === 'skip') {
      rec('SKIPPED', `Skipped: ${row.note ?? 'changed on Amazon since download'}`)
      continue
    }
    if (row.status === 'CREATE') {
      // Creates need the ad-group resolution and create-service plumbing that
      // /bulk/apply already owns; wiring them here as well would be a second
      // path to the same write. Left for the endpoint consolidation.
      rec('SKIPPED', 'Row creation is not part of this apply path yet')
      continue
    }
    if (!row.targetId) { rec('SKIPPED', 'No resolved entity to write to'); continue }

    try {
      let res: { ok: boolean; error: string | null } | null = null

      if (row.entity === 'Campaign') {
        // D2 — every writable column comes from the shared FIELD_MAP, which is
        // also what preview derives its diff list from. Adding a column in one
        // place can no longer leave the other behind.
        const patch: Record<string, unknown> = {}
        const err = applyFields('campaign', patch, (c) => nextOf(row, c))
        if (err) { rec('FAILED', err); continue }
        if (row.status === 'ARCHIVE') patch.status = 'ARCHIVED'
        if (!Object.keys(patch).length) { rec('SKIPPED', 'No writable field changed'); continue }
        res = await updateCampaignWithSync({
          campaignId: row.targetId, patch: patch as Parameters<typeof updateCampaignWithSync>[0]['patch'], actor: opts.actor,
          reason: `bulksheet import ${jobId}`, applyImmediately: opts.applyImmediately, changeSetId,
        })
      } else if (row.entity === 'Portfolio') {
        // AX-IE.2 — same rails as everything else: through the write gate and
        // the outbox, never a private path. A portfolio moves budget.
        const patch: Record<string, unknown> = {}
        const err = applyFields('portfolio', patch, (c) => nextOf(row, c))
        if (err) { rec('FAILED', err); continue }
        if (!Object.keys(patch).length) { rec('SKIPPED', 'No writable field changed'); continue }
        res = await updatePortfolioWithSync({
          portfolioId: row.targetId, patch: patch as Parameters<typeof updatePortfolioWithSync>[0]['patch'], actor: opts.actor,
          reason: `bulksheet import ${jobId}`, applyImmediately: opts.applyImmediately, changeSetId,
        })
      } else if (row.entity === 'Ad group') {
        const patch: Record<string, unknown> = {}
        const err = applyFields('adGroup', patch, (c) => nextOf(row, c))
        if (err) { rec('FAILED', err); continue }
        if (row.status === 'ARCHIVE') patch.status = 'ARCHIVED'
        if (!Object.keys(patch).length) { rec('SKIPPED', 'No writable field changed'); continue }
        res = await updateAdGroupWithSync({
          adGroupId: row.targetId, patch: patch as Parameters<typeof updateAdGroupWithSync>[0]['patch'], actor: opts.actor,
          reason: `bulksheet import ${jobId}`, applyImmediately: opts.applyImmediately, changeSetId,
        })
      } else {
        // Keyword / Product targeting / the negative variants all live on AdTarget.
        const patch: Record<string, unknown> = {}
        const err = applyFields('adTarget', patch, (c) => nextOf(row, c))
        if (err) { rec('FAILED', err); continue }
        if (row.status === 'ARCHIVE') patch.status = 'ARCHIVED'
        if (!Object.keys(patch).length) { rec('SKIPPED', 'No writable field changed'); continue }
        res = await updateAdTargetWithSync({
          adTargetId: row.targetId, patch: patch as Parameters<typeof updateAdTargetWithSync>[0]['patch'], actor: opts.actor,
          reason: `bulksheet import ${jobId}`, applyImmediately: opts.applyImmediately, changeSetId,
        })
      }

      if (res?.ok) {
        rec('APPLIED', opts.applyImmediately ? 'Applied (live)' : 'Queued through the write gate (pending)')
        await prisma.importJobRow.updateMany({
          where: { jobId, rowIndex: row.rowIndex },
          data: {
            status: 'SUCCESS',
            targetId: row.targetId,
            completedAt: new Date(),
            // The before/after snapshot the operator was shown, frozen — so what
            // was approved stays recoverable after the fact.
            beforeState: Object.fromEntries(row.diffs.map((d) => [d.field, d.current])) as object,
            afterState: Object.fromEntries(row.diffs.map((d) => [d.field, d.next])) as object,
          },
        })
      } else {
        rec('FAILED', res?.error ?? 'Write refused')
        await prisma.importJobRow.updateMany({
          where: { jobId, rowIndex: row.rowIndex },
          data: { status: 'FAILED', errorMessage: (res?.error ?? 'write refused').slice(0, 900) },
        })
        if (opts.strict) { out.aborted = true; break }
      }
    } catch (e) {
      rec('FAILED', (e as Error).message.slice(0, 300))
      if (opts.strict) { out.aborted = true; break }
    }
  }

  return out
}
