import type { Prisma } from '@nexus/factory-db'
import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { LOSS_DECISIONS, type LossDecision, type LossDecisionFacts } from '@nexus/factory-domain/planning/leather/loss'
import type { CommandTx } from '../../../core/command'
import { RUN_COLUMNS, type RunRow } from '../views'
import type { Reader, SiteRow } from '../store'

/**
 * What the leather plan's reads and decisions share (B-W2b-132): the site's latest finished plan run (the plan the need and
 * the protectors are read from; "as of" its end), the items the rows name, the decisions about a style's cutting loss (audit
 * rows on the Style, as B-W2b-64 keeps the standard review's: no table of their own) and the refusals in words.
 */

export const ACCEPT_ACTION = 'planning.leather.acceptLoss'
export const DISMISS_ACTION = 'planning.leather.dismissLoss'

/** The site's latest DONE run (the plan "What to buy & make" shows), or null before the first run. */
export const latestRunOf = (db: Reader, siteId: string): Promise<RunRow | null> =>
  db.planningRun.findFirst({ where: { siteId, status: 'DONE' }, select: RUN_COLUMNS, orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }] })

export const runViewOf = (run: RunRow | null) => (run && run.finishedAt ? { id: run.id, finishedAt: toUtcIso(run.finishedAt), orderLines: run.orderLines } : null)

export const siteViewOf = (site: SiteRow) => ({ id: site.id, code: site.code, name: site.name, timeZone: site.timezone })

export const LEATHER_ITEM_COLUMNS = {
  id: true,
  code: true,
  name: true,
  kind: true,
  tracking: true,
  isPpeComponent: true,
  baseUom: true,
  purchaseUom: true,
  purchaseFactor: true,
  consumptionUom: true,
  consumptionFactor: true,
  thicknessMinMm: true,
  thicknessMaxMm: true,
  currency: true,
} as const satisfies Prisma.ItemSelect
export type LeatherItemRow = Prisma.ItemGetPayload<{ select: typeof LEATHER_ITEM_COLUMNS }>

export const unitsOfItem = (item: LeatherItemRow) => ({
  baseUom: item.baseUom,
  purchaseUom: item.purchaseUom,
  purchaseFactor: item.purchaseFactor.toString(),
  consumptionUom: item.consumptionUom,
  consumptionFactor: item.consumptionFactor.toString(),
})

/** Leather planned by the hide (W1 tracking HIDE). */
export const isLeather = (item: Pick<LeatherItemRow, 'tracking'>): boolean => item.tracking === 'HIDE'
/** A protector: the kind, or a PPE component. */
export const isProtector = (item: Pick<LeatherItemRow, 'kind' | 'isPpeComponent'>): boolean => item.kind === 'PROTECTOR' || item.isPpeComponent

export interface StoredDecision extends LossDecisionFacts {
  readonly id: string
  readonly at: string
  readonly reason: string | null
  readonly fromPct: string | null
  readonly revision: number | null
}

/** The decisions about these styles' cutting loss at a site, newest first per style. */
export async function decisionsOf(db: Reader, siteId: string, styleIds: readonly string[]): Promise<Map<string, StoredDecision[]>> {
  const out = new Map<string, StoredDecision[]>()
  if (styleIds.length === 0) return out
  const rows = await db.auditLog.findMany({
    where: { action: { in: [ACCEPT_ACTION, DISMISS_ACTION] }, recordType: 'Style', recordId: { in: [...styleIds] }, siteId },
    select: { id: true, recordId: true, at: true, reason: true, after: true },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
  })
  for (const row of rows) {
    const after = (row.after ?? {}) as { decision?: unknown; toPct?: unknown; cuts?: unknown; fromPct?: unknown; carriedIn?: { revision?: unknown } | null }
    const decision = LOSS_DECISIONS.includes(after.decision as LossDecision) ? (after.decision as LossDecision) : null
    if (!decision || typeof after.toPct !== 'string' || typeof after.cuts !== 'number') continue
    const list = out.get(row.recordId) ?? []
    list.push({
      id: row.id,
      decision,
      toPct: after.toPct,
      cuts: after.cuts,
      fromPct: typeof after.fromPct === 'string' ? after.fromPct : null,
      at: toUtcIso(row.at),
      reason: row.reason ?? null,
      revision: typeof after.carriedIn?.revision === 'number' ? after.carriedIn.revision : null,
    })
    out.set(row.recordId, list)
  }
  return out
}

/** One decision about a style's loss at a time (the proposal is read again under it). */
export async function lockStyleLoss(tx: CommandTx, tenantId: string, styleId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.planning.leather-loss', ${tenantId}::uuid, ${styleId}::uuid), 0))`
}

/** A leather plan rule's refusal (409): `refusal/<CODE>` and the field at fault when there is one. */
export class LeatherRefusedError extends ConflictError {
  override name = 'LeatherRefusedError'
  override readonly issues: readonly Issue[]
  constructor(
    readonly refusal: string,
    message: string,
    field?: string,
  ) {
    super(message)
    this.issues = [{ path: `refusal/${refusal}`, message }, ...(field ? [{ path: `body/${field}`, message }] : [])]
  }
}

export const refuse = (code: string, message: string, field?: string): never => {
  throw new LeatherRefusedError(code, message, field)
}
