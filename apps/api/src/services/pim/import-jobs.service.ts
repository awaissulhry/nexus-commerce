/**
 * PES.5 / D15.15 — **the diff token IS the job.**
 *
 * Dry-run persists the computed diff as a `BulkOperation` in `QUEUED`; apply
 * takes no file and no mode and replays the STORED diff. So the thing the
 * operator approved is the thing that runs — a second parse could produce a
 * different answer from the same file (a schema refresh, another operator's
 * edit) and the operator would never know they approved something else.
 *
 * ⚠ NOT the legacy import-wizard. `ImportJob` / `ImportJobRow` back
 * `/bulk-operations/imports`, which the Owner validated on 2026-07-06 under a
 * standing rule — *"do NOT make functional changes to it"*. Nothing here touches
 * those tables or carries that name (D15.14).
 *
 * The store is `BulkOperation`, extended additively, because it already held the
 * ruled record: `changes` per cell, `PARTIAL` as its own status, `errors`,
 * `uploadFilename`, and `expiresAt` — which is `revertibleUntil` under an older
 * name. A second job table would have been the drift the ruling exists to stop.
 */

import { canonical, type DiffCell, type DiffCounts } from './import-diff.service.js'

export type JobState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'REVERTED' | 'CANCELLED'

/**
 * #600(4) — the DB's names are ours; the WIRE speaks D15.13.5's lowercase.
 * Mapped in one place so the two vocabularies cannot drift into each other.
 */
export type WireState = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'reverted' | 'cancelled'
export const toWireState = (s: string): WireState => String(s).toLowerCase() as WireState

/** #600(4) — outcome verdicts on the wire. `refused` always carries a reason. */
export type WireVerdict = 'written' | 'refused' | 'unchanged'

/** One stored cell. Coordinates are COMPONENTS (D15.13.3) — never a composed id. */
export interface StoredCell {
  contentAddress?: DiffCell['contentAddress']
  restoreIntent?: 'set' | 'reset'
  productId: string
  aliasKey: string
  /** The sheet key — names the cell. */
  fieldKey: string
  /** The field the WRITE is told (`attr_x`); absent on a job stored before 2026-09-05 → the sheet key. */
  writeField?: string
  scope: DiffCell['scope']
  verdict: DiffCell['verdict']
  pins: boolean
  before: unknown
  after: unknown
  reason?: string
}

export interface JobPoll {
  jobId: string
  state: JobState
  /**
   * #614 — WHICH phase produced this state. A job can be `partial` twice for
   * different reasons: partial on apply, then partial again on revert. The state
   * alone cannot tell them apart, so a consumer reading `state` without `phase`
   * can say "partial" and not say partial at what.
   */
  phase: 'apply' | 'revert'
  processed: number
  total: number
  outcomes: { rowId: string; fieldKey: string; verdict: WireVerdict; reason?: string }[]
  counts: DiffCounts
  expiresAt?: string
}

/** A preview that is no longer applyable — already applied, cancelled, or expired. */
export class JobNotApplicableError extends Error {
  readonly code = 'job_not_applicable'
  readonly statusCode = 409
  constructor(readonly jobId: string, readonly state: string) {
    super(`This preview is ${state.toLowerCase()} — a preview applies once. Run a new dry-run to see the current diff.`)
    this.name = 'JobNotApplicableError'
  }
}

const CANCEL_AFTER_HOURS = 24

/** Persist a computed diff as the job. Returns the id the operator later applies. */
export async function storePreview(input: {
  cells: DiffCell[]
  counts: DiffCounts
  productId: string
  filename?: string | null
  userId?: string | null
  blankPolicy: 'ignore' | 'clear'
  scope: { kind: string; channel: string | null; marketplace: string | null; locale?: string | null }
  /**
   * The MARKET the sheet was opened on — **a separate fact from the coordinate,
   * and this is the failure that proves it.**
   *
   * A scope names a coordinate (`channel` x `marketplace`); a master scope has
   * none, so `scope.marketplace` is null. Storing only the scope therefore lost
   * the market, and `apply` rebuilt its read with `market: ''` and threw
   * `unknown_market` — which is the very error that had stranded a job in
   * `RUNNING`, reappearing inside its own fix. Measured: 7 of 11 assertions
   * failed, and they would have failed on every MASTER job while passing on
   * every channel one.
   *
   * Two facts, stored as two fields. Neither can be derived from the other.
   */
  market: string
}): Promise<{ jobId: string; expiresAt: Date }> {
  const { default: prisma } = await import('../../db.js')
  const stored: StoredCell[] = input.cells.map((c) => ({
    productId: c.rowId, aliasKey: c.aliasKey, fieldKey: c.fieldKey, writeField: c.writeField, scope: c.scope, contentAddress: c.contentAddress,
    verdict: c.verdict, pins: c.pins, before: c.before, after: c.after,
    ...(c.restoreIntent ? { restoreIntent: c.restoreIntent } : {}),
    ...(c.reason ? { reason: c.reason } : {}),
  }))
  // The blank-cell mode is baked in here, NOT passed at apply: it is an input to
  // the diff the operator saw, so re-supplying it later could apply a different
  // intent to the same approved preview.
  const expiresAt = new Date(Date.now() + CANCEL_AFTER_HOURS * 3600_000)
  const job = await prisma.bulkOperation.create({
    data: {
      userId: input.userId ?? null,
      productCount: new Set(stored.map((c) => c.productId)).size,
      changeCount: input.counts.changed,
      // #600(2) — the SCOPE is stored with the diff. Apply takes no query at all:
    // a coordinate supplied at apply time could differ from the one the operator
    // previewed, which is the same reason the diff itself is stored rather than
    // recomputed.
    changes: { kind: 'studio-import', blankPolicy: input.blankPolicy, scope: input.scope, market: input.market, cells: stored } as object,
      status: 'QUEUED',
      total: stored.length,
      processed: 0,
      uploadFilename: input.filename ?? null,
      expiresAt,
    },
    select: { id: true },
  })
  return { jobId: job.id, expiresAt }
}

const asPayload = (v: unknown) =>
  (v && typeof v === 'object' ? v : {}) as {
    kind?: string; blankPolicy?: string; cells?: StoredCell[]
    scope?: { kind: string; channel: string | null; marketplace: string | null; locale?: string | null }
    market?: string
    phase?: 'apply' | 'revert'
    outcomes?: JobPoll['outcomes']
    appliedCells?: Array<{ rowId: string; fieldKey: string }>
  }

export async function readJob(jobId: string) {
  const { default: prisma } = await import('../../db.js')
  const job = await prisma.bulkOperation.findUnique({ where: { id: jobId } })
  if (!job) return null
  const payload = asPayload(job.changes)
  if (payload.kind !== 'studio-import') return null // not ours; never touch it
  return {
    job, cells: payload.cells ?? [],
    outcomes: payload.outcomes ?? (Array.isArray(job.errors) ? job.errors : []),
    blankPolicy: (payload.blankPolicy ?? 'ignore') as 'ignore' | 'clear',
    scope: payload.scope ?? null,
    market: payload.market ?? null,
    phase: (payload.phase ?? null) as 'apply' | 'revert' | null,
  }
}

/**
 * Apply the STORED diff.
 *
 * `writeCells` is supplied by the caller so this service never grows a second
 * write path: the route hands it a writer that goes through the ordinary bulk
 * PATCH, which already owns validation, the cap guard, CAS and the audit trail.
 *
 * `currentOf` re-reads what each cell holds NOW. A cell whose value moved since
 * the preview is **skipped and recorded**, never written — the operator approved
 * a specific before→after, and applying it to a different before is the stale
 * write that undo paths are most prone to (#258).
 */
export async function applyStoredJob(input: {
  jobId: string
  /** Preconditions that must hold BEFORE the job is marked RUNNING (#600.1). */
  preflight?: () => Promise<void>
  currentOf: (cell: StoredCell) => Promise<unknown>
  writeCells: (cells: StoredCell[]) => Promise<{ applied: number; errors: { productId: string; fieldKey: string; error: string }[] }>
}): Promise<JobPoll> {
  const { default: prisma } = await import('../../db.js')
  const loaded = await readJob(input.jobId)
  if (!loaded) throw new Error(`No studio import job ${input.jobId}`)
  const { job, cells } = loaded
  // A preview applies ONCE. Surfaced as a typed conflict, not a bare Error:
  // measured in the rehearsal, a second apply returned 500, so an operator
  // double-clicking Apply saw a server error instead of "already applied" —
  // and a 500 invites a retry, which is the one thing that must not happen here.
  if (job.status !== 'QUEUED') {
    throw new JobNotApplicableError(input.jobId, job.status)
  }
  if (job.expiresAt && job.expiresAt.getTime() <= Date.now()) throw new JobNotApplicableError(input.jobId, 'EXPIRED')

  // #600(1) — RUNNING is entered only after EVERY precondition holds, and any
  // throw after that moves the row to FAILED with its reason.
  //
  // Measured: a job went RUNNING and the route then threw `unknown_market`,
  // leaving `RUNNING, processed: 0` forever — cancel refused it (not QUEUED),
  // re-apply refused it (not QUEUED), and nothing was running. A state nobody
  // is in is worse than a failure, because a failure can be retried and a
  // stranded RUNNING can only be repaired by hand.
  //
  // `preflight` is the caller's remaining preconditions (the scope read). It
  // runs BEFORE the transition, so the ordering — not the removal of one bad
  // parameter — is what closes the class.
  if (input.preflight) await input.preflight()

  const claimed = await prisma.bulkOperation.updateMany({ where: { id: job.id, status: 'QUEUED' }, data: { status: 'RUNNING' } })
  if (claimed.count !== 1) throw new JobNotApplicableError(input.jobId, 'ALREADY CLAIMED')

  const failJob = async (reason: string) => {
    await prisma.bulkOperation.update({
      where: { id: job.id },
      data: { status: 'FAILED', completedAt: new Date(), errors: [{ stage: 'apply', error: reason }] as object },
    })
  }

  const outcomes: JobPoll['outcomes'] = []
  const toWrite: StoredCell[] = []
  for (const c of cells) {
    if (c.verdict !== 'changed') {
      if (c.verdict === 'refused') outcomes.push({ rowId: c.productId, fieldKey: c.fieldKey, verdict: 'refused', reason: c.reason })
      continue
    }
    const now = await input.currentOf(c).catch(async err => { await failJob(err instanceof Error ? err.message : String(err)); throw err })
    if (canonical(now) !== canonical(c.before)) {
      outcomes.push({ rowId: c.productId, fieldKey: c.fieldKey, verdict: 'refused', reason: 'changed since the preview' })
      continue
    }
    toWrite.push(c)
  }

  let result: { applied: number; errors: { productId: string; fieldKey: string; error: string }[] }
  try {
    result = toWrite.length > 0 ? await input.writeCells(toWrite) : { applied: 0, errors: [] }
  } catch (err) {
    await failJob(err instanceof Error ? err.message : String(err))
    throw err
  }
  for (const e of result.errors) {
    outcomes.push({ rowId: e.productId, fieldKey: e.fieldKey, verdict: 'refused', reason: e.error })
  }
  const writtenKeys = new Set(result.errors.map((e) => `${e.productId}:${e.fieldKey}`))
  for (const c of toWrite) {
    if (!writtenKeys.has(`${c.productId}:${c.fieldKey}`)) {
      outcomes.push({ rowId: c.productId, fieldKey: c.fieldKey, verdict: 'written' })
    }
  }

  const refused = outcomes.filter((o) => o.verdict === 'refused').length
  // PARTIAL is its own state and is NEVER reported as COMPLETED (D15.13.5):
  // "finished with refusals" is a different fact from "finished".
  const state: JobState = refused > 0 ? 'PARTIAL' : 'COMPLETED'
  const counts: DiffCounts = {
    unchanged: cells.filter((c) => c.verdict === 'unchanged').length,
    changed: outcomes.filter((o) => o.verdict === 'written').length,
    refused,
    wouldPin: cells.filter((c) => c.verdict === 'changed' && c.pins).length,
  }
  await prisma.bulkOperation.update({
    where: { id: job.id },
    data: {
      status: state,
      processed: outcomes.length,
      errors: outcomes.filter((o) => o.verdict === 'refused') as object,
      completedAt: new Date(),
      changes: { ...asPayload(job.changes), phase: 'apply', outcomes, appliedCells: outcomes.filter(outcome => outcome.verdict === 'written').map(({ rowId, fieldKey }) => ({ rowId, fieldKey })) } as object,
    },
  })
  return {
    jobId: job.id, state, phase: 'apply', processed: outcomes.length, total: cells.length, outcomes, counts,
    ...(job.expiresAt ? { expiresAt: job.expiresAt.toISOString() } : {}),
  }
}

/**
 * #600(3) / D15.6 — revert an applied import.
 *
 * Per-cell CAS on the stored `after` (D15.14.4): a cell is written back to its
 * `before` only if it still holds what the import put there. **A cell edited
 * since the import is skipped and recorded**, never overwritten — otherwise
 * revert silently discards someone's later work and tells nobody, which is the
 * failure undo paths are most prone to and the one an operator is least
 * equipped to notice.
 *
 * The revert is itself a write through the ordinary path (`writeCells`), so it
 * carries the same validation, CAS and audit trail as the import it undoes.
 */
export async function revertStoredJob(input: {
  jobId: string
  currentOf: (cell: StoredCell) => Promise<unknown>
  writeCells: (cells: StoredCell[]) => Promise<{ applied: number; errors: { productId: string; fieldKey: string; error: string }[] }>
}): Promise<JobPoll> {
  const { default: prisma } = await import('../../db.js')
  const loaded = await readJob(input.jobId)
  if (!loaded) throw new Error(`No studio import job ${input.jobId}`)
  const { job, cells } = loaded
  // Only a job that actually wrote something can be reverted. REVERTED is
  // excluded so a double-click cannot re-apply the befores over newer work.
  if (job.status !== 'COMPLETED' && job.status !== 'PARTIAL') {
    throw new JobNotApplicableError(input.jobId, job.status)
  }
  const claimed = await prisma.bulkOperation.updateMany({ where: { id: job.id, status: job.status }, data: { status: 'RUNNING' } })
  if (claimed.count !== 1) throw new JobNotApplicableError(input.jobId, 'ALREADY CLAIMED')

  const outcomes: JobPoll['outcomes'] = []
  const toWrite: StoredCell[] = []
  for (const c of cells) {
    if (c.verdict !== 'changed') continue
    // A refused apply must never gain an undo merely because another writer later used its value.
    const applied = asPayload(job.changes).appliedCells
    const previousRefusals = Array.isArray(job.errors) ? job.errors as Array<{ rowId?: string; fieldKey?: string }> : []
    if (applied ? !applied.some(key => key.rowId === c.productId && key.fieldKey === c.fieldKey)
      : previousRefusals.some(key => key.rowId === c.productId && key.fieldKey === c.fieldKey)) continue
    const now = await input.currentOf(c).catch(async err => {
      await prisma.bulkOperation.update({ where: { id: job.id }, data: { status: 'FAILED', completedAt: new Date(), errors: [{ stage: 'revert', error: err instanceof Error ? err.message : String(err) }] as object } })
      throw err
    })
    if (canonical(now) !== canonical(c.after)) {
      outcomes.push({ rowId: c.productId, fieldKey: c.fieldKey, verdict: 'refused', reason: 'changed since import' })
      continue
    }
    // Swap the direction: the revert writes the BEFORE.
    toWrite.push({ ...c, after: c.before })
  }

  let result: { applied: number; errors: { productId: string; fieldKey: string; error: string }[] }
  try {
    result = toWrite.length > 0 ? await input.writeCells(toWrite) : { applied: 0, errors: [] }
  } catch (err) {
    await prisma.bulkOperation.update({
      where: { id: job.id },
      data: { status: 'FAILED', completedAt: new Date(), errors: [{ stage: 'revert', error: err instanceof Error ? err.message : String(err) }] as object },
    })
    throw err
  }
  for (const e of result.errors) outcomes.push({ rowId: e.productId, fieldKey: e.fieldKey, verdict: 'refused', reason: e.error })
  const failed = new Set(result.errors.map((e) => `${e.productId}:${e.fieldKey}`))
  for (const c of toWrite) {
    if (!failed.has(`${c.productId}:${c.fieldKey}`)) {
      outcomes.push({ rowId: c.productId, fieldKey: c.fieldKey, verdict: 'written' })
    }
  }

  const refused = outcomes.filter((o) => o.verdict === 'refused').length
  // #614 — a revert that skipped ANY cell is PARTIAL, never REVERTED.
  //
  // `reverted` on a job whose values are still applied is a lie by state: it
  // tells the operator the undo completed when part of it did not, and the part
  // that did not is precisely the part someone else had edited — the case they
  // most need to be told about. Same rule apply already follows.
  const revertState: JobState = refused > 0 ? 'PARTIAL' : 'REVERTED'
  await prisma.bulkOperation.update({
    where: { id: job.id },
    data: {
      status: revertState, processed: outcomes.length, completedAt: new Date(),
      errors: outcomes.filter((o) => o.verdict === 'refused') as object,
      changes: { ...asPayload(job.changes), phase: 'revert', outcomes } as object,
    },
  })
  return {
    jobId: job.id, state: revertState, phase: 'revert', processed: outcomes.length, total: cells.length, outcomes,
    counts: {
      unchanged: cells.filter((c) => c.verdict === 'unchanged').length,
      changed: outcomes.filter((o) => o.verdict === 'written').length,
      refused, wouldPin: 0,
    },
    ...(job.expiresAt ? { expiresAt: job.expiresAt.toISOString() } : {}),
  }
}

/**
 * A preview the operator never applied. `CANCELLED` is a fixed state name.
 *
 * Mechanism chosen: an explicit cancel (drawer close) AND a sweep of anything
 * still `QUEUED` past its `expiresAt`. The sweep is the one that matters — a
 * drawer closed by a crashed tab never sends anything, so relying on the client
 * alone would leave previews `QUEUED` forever and an operator could apply a
 * day-old diff whose befores have all moved.
 */
export async function cancelJob(jobId: string): Promise<boolean> {
  const { default: prisma } = await import('../../db.js')
  const loaded = await readJob(jobId)
  if (!loaded || loaded.job.status !== 'QUEUED') return false
  const result = await prisma.bulkOperation.updateMany({ where: { id: jobId, status: 'QUEUED' }, data: { status: 'CANCELLED', completedAt: new Date() } })
  return result.count === 1
}

export async function sweepExpiredPreviews(now = new Date()): Promise<number> {
  const { default: prisma } = await import('../../db.js')
  const stale = await prisma.bulkOperation.findMany({
    where: { status: 'QUEUED', expiresAt: { lt: now } },
    select: { id: true, changes: true },
  })
  const ours = stale.filter((s) => asPayload(s.changes).kind === 'studio-import').map((s) => s.id)
  if (ours.length === 0) return 0
  const r = await prisma.bulkOperation.updateMany({
    where: { id: { in: ours }, status: 'QUEUED' },
    data: { status: 'CANCELLED', completedAt: now },
  })
  return r.count
}
