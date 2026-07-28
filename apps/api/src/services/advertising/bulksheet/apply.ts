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
import { parseMoney, parseVocabulary, isAdTargetEntity } from '@nexus/shared/ads-bulksheet'
import {
  updateCampaignWithSync, updateAdGroupWithSync, updateAdTargetWithSync, updatePortfolioWithSync,
  updateProductAdWithSync, writeAdvertisingActionLog,
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
 * AX-IE.9 — create a row the file asked for, through the SAME create services
 * the rest of the app uses. No second write path: rule zero.
 *
 * Two things are worth knowing about how this differs from an update.
 *
 * The create services push to Amazon INLINE (gated), rather than through the
 * outbox with a grace window. So a create lands immediately while the updates in
 * the same file are still sitting in the queue, and `applyImmediately` does not
 * change that — it only sets holdUntil on queued work, and a create has none.
 * That asymmetry is real and is why the operator is told, per row, whether the
 * new entity reached Amazon or exists only locally.
 *
 * They are also idempotent by natural key (H.1/H.5): re-running a create returns
 * the existing row rather than a duplicate. That is what makes re-uploading a
 * partially-applied file safe, which is the recovery path apply already
 * documents.
 */
async function createRow(
  prisma: PrismaClient,
  row: PreviewRow,
  jobId: string,
  opts: ApplyOptions,
  changeSetId: string,
): Promise<{ outcome: ApplyRowResult['outcome']; message: string; createdId: string | null }> {
  if (!row.parentId) return { outcome: 'SKIPPED', message: 'No parent resolved for this new row', createdId: null }

  const text = (c: string): string => (nextOf(row, c) ?? '').trim()
  const bidEur = (): number | null => {
    const raw = text('Bid')
    if (!raw) return null
    const m = parseMoney(raw)
    return 'error' in m ? null : m.value
  }
  const match = (): 'BROAD' | 'PHRASE' | 'EXACT' | null => {
    const canonical = parseVocabulary('matchType', text('Match type'))
    if (!canonical) return null
    if (canonical === 'Broad') return 'BROAD'
    if (canonical === 'Phrase' || canonical === 'Negative phrase') return 'PHRASE'
    if (canonical === 'Exact' || canonical === 'Negative exact') return 'EXACT'
    return null
  }

  const svc = await import('../ads-create.service.js')
  // AdsActor is a tagged string (`user:<id>` / `automation:<id>`); the create
  // services want the bare id for their audit rows.
  const actorId = opts.actor.startsWith('user:') ? opts.actor.slice('user:'.length) : undefined
  let created: { id: string; externalId: string | null }

  try {
    switch (row.entity) {
      case 'Ad group': {
        const name = text('Ad group name')
        if (!name) return { outcome: 'FAILED', message: 'Ad group name is required to create an ad group', createdId: null }
        const bid = (() => { const raw = text('Ad Group Default Bid'); if (!raw) return null; const m = parseMoney(raw); return 'error' in m ? null : m.value })()
        if (bid == null) return { outcome: 'FAILED', message: 'Ad Group Default Bid is required to create an ad group', createdId: null }
        const r = await svc.createAdGroupLocal({ campaignId: row.parentId, name, defaultBidEur: bid, userId: actorId })
        created = { id: r.id, externalId: r.externalAdGroupId }
        break
      }
      case 'Keyword': {
        const kw = text('Keyword text'); const mt = match(); const bid = bidEur()
        if (!kw) return { outcome: 'FAILED', message: 'Keyword text is required', createdId: null }
        if (!mt) return { outcome: 'FAILED', message: `Match type "${text('Match type')}" is not one we can create`, createdId: null }
        if (bid == null) return { outcome: 'FAILED', message: 'Bid is required to create a keyword', createdId: null }
        const r = await svc.createKeywordLocal({ adGroupId: row.parentId, keywordText: kw, matchType: mt, bidEur: bid, userId: actorId })
        created = { id: r.id, externalId: r.externalTargetId }
        break
      }
      case 'Negative keyword': {
        const kw = text('Keyword text'); const mt = match()
        if (!kw) return { outcome: 'FAILED', message: 'Keyword text is required', createdId: null }
        if (mt !== 'EXACT' && mt !== 'PHRASE') return { outcome: 'FAILED', message: 'A negative keyword must be Negative exact or Negative phrase', createdId: null }
        const r = await svc.createNegativeKeywordLocal({ adGroupId: row.parentId, keywordText: kw, matchType: mt, userId: actorId })
        created = { id: r.id, externalId: r.externalTargetId }
        break
      }
      case 'Campaign negative keyword': {
        const kw = text('Keyword text'); const mt = match()
        if (!kw) return { outcome: 'FAILED', message: 'Keyword text is required', createdId: null }
        if (mt !== 'EXACT' && mt !== 'PHRASE') return { outcome: 'FAILED', message: 'A campaign negative must be Negative exact or Negative phrase', createdId: null }
        // This one service takes the EXTERNAL campaign id, not the local one.
        const camp = await prisma.campaign.findUnique({ where: { id: row.parentId }, select: { externalCampaignId: true } })
        if (!camp?.externalCampaignId) {
          return { outcome: 'FAILED', message: 'That campaign has never synced to Amazon, so a campaign negative cannot be attached to it yet', createdId: null }
        }
        const r = await svc.createNegativeKeywordCampaignLocal({ externalCampaignId: camp.externalCampaignId, keywordText: kw, matchType: mt, userId: actorId })
        if (!r) return { outcome: 'FAILED', message: 'Campaign negative could not be created', createdId: null }
        created = { id: r.id, externalId: null }
        break
      }
      case 'Product targeting': {
        const expr = text('Product targeting expression'); const bid = bidEur()
        if (!expr) return { outcome: 'FAILED', message: 'Product targeting expression is required', createdId: null }
        if (bid == null) return { outcome: 'FAILED', message: 'Bid is required to create a product target', createdId: null }
        const r = await svc.createTargetLocal({ adGroupId: row.parentId, kind: 'PRODUCT', value: expr, bidEur: bid, userId: actorId })
        created = { id: r.id, externalId: r.externalTargetId }
        break
      }
      case 'Negative product targeting': {
        const expr = text('Product targeting expression')
        if (!expr) return { outcome: 'FAILED', message: 'Product targeting expression is required', createdId: null }
        const r = await svc.createNegativeProductTargetLocal({ adGroupId: row.parentId, asin: expr, userId: actorId })
        created = { id: r.id, externalId: r.externalTargetId }
        break
      }
      case 'Product ad': {
        const sku = text('SKU'); const asin = text('ASIN (Informational only)')
        if (!sku && !asin) return { outcome: 'FAILED', message: 'A product ad needs a SKU or an ASIN', createdId: null }
        const r = await svc.createProductAdLocal({ adGroupId: row.parentId, sku: sku || undefined, asin: asin || undefined, userId: actorId })
        created = { id: r.id, externalId: r.externalAdId }
        break
      }
      default:
        return { outcome: 'SKIPPED', message: `Creating a ${row.entity} from a bulksheet is not wired up`, createdId: null }
    }
  } catch (e) {
    return { outcome: 'FAILED', message: (e as Error).message.slice(0, 300), createdId: null }
  }

  // Register the create in the change set, so Undo covers it. Without this the
  // operator reverts an upload and the rows it INVENTED stay behind — the half
  // of the round trip that is easiest to miss and worst to discover late.
  // reverseOne inverts a create by archiving, which is Amazon's delete.
  const entityType = ENTITY_TYPE_FOR_LOG[row.entity]
  if (entityType) {
    await writeAdvertisingActionLog({
      changeSetId, actor: opts.actor,
      actionType: `bulksheet_create_${entityType.toLowerCase()}`,
      entityType, entityId: created.id,
      payloadBefore: { created: false },
      payloadAfter: Object.fromEntries(row.diffs.map((d) => [d.field, d.next])),
      outboundQueueId: null,
    })
  }

  // State is honoured after the fact: every create service makes the row
  // ENABLED, so a file asking for a paused new row would otherwise start
  // spending. Reported separately because the create itself did succeed.
  const wanted = STATE_TO_DB[text('State').toLowerCase()]
  let stateNote = ''
  if (wanted && wanted !== 'ENABLED') {
    const s = await setCreatedState(row.entity, created.id, wanted, opts, jobId, changeSetId)
    stateNote = s ? `, set to ${wanted.toLowerCase()}` : `, but could NOT be set to ${wanted.toLowerCase()} — it is live and enabled`
  }

  return {
    outcome: 'APPLIED',
    message: created.externalId
      ? `Created on Amazon (${created.externalId})${stateNote}`
      : `Created locally${stateNote} — not yet on Amazon (the write gate declined, or the parent has never synced)`,
    createdId: created.id,
  }
}

/** AdvertisingActionLog.entityType per bulksheet entity. */
const ENTITY_TYPE_FOR_LOG: Record<string, 'AD_GROUP' | 'AD_TARGET' | 'PRODUCT_AD'> = {
  'Ad group': 'AD_GROUP',
  'Keyword': 'AD_TARGET',
  'Negative keyword': 'AD_TARGET',
  'Campaign negative keyword': 'AD_TARGET',
  'Product targeting': 'AD_TARGET',
  'Negative product targeting': 'AD_TARGET',
  'Product ad': 'PRODUCT_AD',
}

/** Apply a non-default State to a row that was just created. */
async function setCreatedState(
  entity: string,
  id: string,
  status: 'ENABLED' | 'PAUSED' | 'ARCHIVED',
  opts: ApplyOptions,
  jobId: string,
  changeSetId: string,
): Promise<boolean> {
  const common = { actor: opts.actor, reason: `bulksheet import ${jobId}`, applyImmediately: opts.applyImmediately, changeSetId }
  try {
    if (entity === 'Ad group') return (await updateAdGroupWithSync({ adGroupId: id, patch: { status }, ...common })).ok
    if (entity === 'Product ad') return (await updateProductAdWithSync({ productAdId: id, status, ...common })).ok
    return (await updateAdTargetWithSync({ adTargetId: id, patch: { status }, ...common })).ok
  } catch {
    return false
  }
}

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
    if (out.aborted) break

    /**
     * The ONE place a row's fate is recorded — response, staging table and
     * strict-mode abort together.
     *
     * They used to be three separate things, and they disagreed. Several failure
     * paths (a bad State value, an unmappable column, the fail-closed default)
     * pushed FAILED into the response and returned without touching
     * ImportJobRow, so the staging row stayed PENDING — and the annotated
     * workbook, which reads that column, marked those rows "unchanged". The
     * operator's own file told them nothing had happened to a row that had just
     * failed. Those same paths also ignored `strict`, which is documented as
     * "abort the whole set on the first failure" and did not.
     *
     * Routing every outcome through here makes both impossible by construction
     * rather than by remembering.
     */
    const settle = async (outcome: ApplyRowResult['outcome'], message: string, createdId?: string | null): Promise<void> => {
      const targetId = createdId ?? row.targetId
      out.results.push({ rowIndex: row.rowIndex, entity: row.entity, targetId, label: row.label, outcome, message })
      if (outcome === 'APPLIED') out.applied++
      else if (outcome === 'SKIPPED') out.skipped++
      else out.failed++

      if (outcome === 'APPLIED') {
        await prisma.importJobRow.updateMany({
          where: { jobId, rowIndex: row.rowIndex },
          data: {
            status: 'SUCCESS', targetId, completedAt: new Date(),
            // The before/after snapshot the operator was shown, frozen — so what
            // was approved stays recoverable after the fact.
            beforeState: Object.fromEntries(row.diffs.map((d) => [d.field, d.current])) as object,
            afterState: Object.fromEntries(row.diffs.map((d) => [d.field, d.next])) as object,
          },
        })
        return
      }
      if (outcome === 'FAILED') {
        await prisma.importJobRow.updateMany({
          where: { jobId, rowIndex: row.rowIndex },
          data: { status: 'FAILED', errorMessage: message.slice(0, 900) },
        })
        if (opts.strict) out.aborted = true
        return
      }
      // SKIPPED. Guarded on `status != SUCCESS` because the first thing this
      // loop does is skip rows an EARLIER run already applied — overwriting
      // those back to SKIPPED would destroy the idempotency record and let a
      // third run re-apply them.
      await prisma.importJobRow.updateMany({
        where: { jobId, rowIndex: row.rowIndex, status: { not: 'SUCCESS' } },
        data: { status: 'SKIPPED', errorMessage: message.slice(0, 900) },
      })
    }
    const rec = settle

    /**
     * Every update service reports `{ ok: true, error: 'no_changes' }` when the
     * row already held the value asked for. That is NOT an applied write, and
     * reporting it as one is the failure this whole series is about: the
     * response says applied, the staging row goes SUCCESS, and the annotated
     * file comes back green for a change that never happened.
     *
     * Reachable, and by the documented recovery path: re-uploading a file whose
     * Archive rows already ran gets a NEW job id, so the "already applied" set
     * above is empty and every one of those rows would have reported APPLIED a
     * second time. `conflicts: 'mine'` gets there too, when the value someone
     * else set is the value being forced.
     */
    const settleWrite = async (res: { ok: boolean; error: string | null } | null): Promise<void> => {
      if (res?.ok && res.error === 'no_changes') {
        await settle('SKIPPED', 'Nothing to change — it already holds that value')
        return
      }
      if (res?.ok) {
        await settle('APPLIED', opts.applyImmediately ? 'Applied (live)' : 'Queued through the write gate (pending)')
        return
      }
      await settle('FAILED', res?.error ?? 'Write refused')
    }

    if (done.has(row.rowIndex)) { await rec('SKIPPED', 'Already applied by an earlier run of this import'); continue }
    if (row.status === 'UNCHANGED') { await rec('SKIPPED', 'Nothing to change'); continue }
    if (row.status === 'UNRESOLVED') { await rec('SKIPPED', row.note ?? 'Could not resolve the target entity'); continue }
    if (row.status === 'UNSUPPORTED') { await rec('SKIPPED', row.note ?? 'This entity type cannot be applied yet'); continue }
    if (row.status === 'CONFLICT' && opts.conflicts === 'skip') {
      await rec('SKIPPED', `Skipped: ${row.note ?? 'changed on Amazon since download'}`)
      continue
    }
    if (row.status === 'CREATE') {
      const r = await createRow(prisma, row, jobId, opts, changeSetId)
      // The created id is reported, not row.targetId — which is null on a create,
      // so the operator's result row used to name nothing at all.
      await settle(r.outcome, r.message, r.createdId)
      continue
    }
    if (!row.targetId) { await rec('SKIPPED', 'No resolved entity to write to'); continue }

    try {
      let res: { ok: boolean; error: string | null } | null = null

      if (row.entity === 'Campaign') {
        // D2 — every writable column comes from the shared FIELD_MAP, which is
        // also what preview derives its diff list from. Adding a column in one
        // place can no longer leave the other behind.
        const patch: Record<string, unknown> = {}
        const err = applyFields('campaign', patch, (c) => nextOf(row, c))
        if (err) { await rec('FAILED', err); continue }
        if (row.status === 'ARCHIVE') patch.status = 'ARCHIVED'
        if (!Object.keys(patch).length) { await rec('SKIPPED', 'No writable field changed'); continue }
        res = await updateCampaignWithSync({
          campaignId: row.targetId, patch: patch as Parameters<typeof updateCampaignWithSync>[0]['patch'], actor: opts.actor,
          reason: `bulksheet import ${jobId}`, applyImmediately: opts.applyImmediately, changeSetId,
        })
      } else if (row.entity === 'Portfolio') {
        // AX-IE.2 — same rails as everything else: through the write gate and
        // the outbox, never a private path. A portfolio moves budget.
        // Archive is not a portfolio operation. Amazon marks portfolio state
        // "(Informational only)" on its own sheet, so FIELD_MAP has no State for
        // it — without this the row would fall through to the generic "no
        // writable field changed", which reads as an empty edit rather than an
        // operation that does not exist.
        if (row.status === 'ARCHIVE') {
          await rec('SKIPPED', 'A portfolio cannot be archived from a bulksheet — Amazon treats portfolio state as read-only. Change it in the console.')
          continue
        }
        const patch: Record<string, unknown> = {}
        const err = applyFields('portfolio', patch, (c) => nextOf(row, c))
        if (err) { await rec('FAILED', err); continue }
        if (!Object.keys(patch).length) { await rec('SKIPPED', 'No writable field changed'); continue }
        res = await updatePortfolioWithSync({
          portfolioId: row.targetId, patch: patch as Parameters<typeof updatePortfolioWithSync>[0]['patch'], actor: opts.actor,
          reason: `bulksheet import ${jobId}`, applyImmediately: opts.applyImmediately, changeSetId,
        })
      } else if (row.entity === 'Ad group') {
        const patch: Record<string, unknown> = {}
        const err = applyFields('adGroup', patch, (c) => nextOf(row, c))
        if (err) { await rec('FAILED', err); continue }
        if (row.status === 'ARCHIVE') patch.status = 'ARCHIVED'
        if (!Object.keys(patch).length) { await rec('SKIPPED', 'No writable field changed'); continue }
        res = await updateAdGroupWithSync({
          adGroupId: row.targetId, patch: patch as Parameters<typeof updateAdGroupWithSync>[0]['patch'], actor: opts.actor,
          reason: `bulksheet import ${jobId}`, applyImmediately: opts.applyImmediately, changeSetId,
        })
      } else if (row.entity === 'Product ad') {
        // State-only, so it does not go through applyFields' patch shape —
        // updateProductAdWithSync takes the status directly. ARCHIVE is the
        // operation form of the same field.
        const raw = row.status === 'ARCHIVE' ? 'archived' : nextOf(row, 'State')
        const mapped = raw ? STATE_TO_DB[raw.trim().toLowerCase()] : undefined
        if (!raw) { await rec('SKIPPED', 'No writable field changed'); continue }
        if (!mapped) { await rec('FAILED', `State "${raw}" is not one we can write`); continue }
        res = await updateProductAdWithSync({
          productAdId: row.targetId, status: mapped, actor: opts.actor,
          reason: `bulksheet import ${jobId}`, applyImmediately: opts.applyImmediately, changeSetId,
        })
      } else if (isAdTargetEntity(row.entity)) {
        // Keyword / Product targeting / the negative variants all live on AdTarget.
        const patch: Record<string, unknown> = {}
        const err = applyFields('adTarget', patch, (c) => nextOf(row, c))
        if (err) { await rec('FAILED', err); continue }
        if (row.status === 'ARCHIVE') patch.status = 'ARCHIVED'
        if (!Object.keys(patch).length) { await rec('SKIPPED', 'No writable field changed'); continue }
        res = await updateAdTargetWithSync({
          adTargetId: row.targetId, patch: patch as Parameters<typeof updateAdTargetWithSync>[0]['patch'], actor: opts.actor,
          reason: `bulksheet import ${jobId}`, applyImmediately: opts.applyImmediately, changeSetId,
        })
      } else {
        // Fail closed. This used to be a bare `else` falling into the AdTarget
        // write above, which meant any entity without its own branch — Product
        // ad, Bidding adjustment — would have had its id handed to
        // updateAdTargetWithSync the moment somebody flipped `applySupported`.
        // A Product ad id is not an AdTarget id, so that is either a no-op or a
        // write to whatever row happens to share the value. Refusing is the only
        // safe answer, and it surfaces the missing branch instead of hiding it.
        await rec('FAILED', `${row.entity} has no apply path — preview should have marked this UNSUPPORTED. This is a bug, not a data problem.`)
        continue
      }

      await settleWrite(res)
    } catch (e) {
      await settle('FAILED', (e as Error).message.slice(0, 300))
    }
  }

  return out
}
