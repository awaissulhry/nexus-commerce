import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { HoldFact, MaterialReadinessFact } from '@nexus/factory-domain/production/work-orders/blockers'
import type { WorkOrderReadiness } from '@nexus/factory-domain/planning/readiness/readiness'
import { reasonWords } from '../../../../platform/reasons/service'
import { livePlanOf, readinessFor, type LivePlan } from '../../../planning/readiness/service'
import { SITE_COLUMNS as PLANNING_SITE_COLUMNS } from '../../../planning/store'
import { activeHoldsOf } from '../../../quality/holds/checks'
import type { Reader } from '../store'

/**
 * What the release's W2a blockers read (B-W2a-46; MES-004; factory-domain production/work-orders/blockers), with the
 * release check's own reader: the scoped client for the record, the release command's transaction for the release (so the
 * check and the write see the same rows). Queries run one after another.
 *
 *   holds      every ACTIVE quality hold naming the work order (modules/quality/holds activeHoldsOf), and the work order's
 *              own ON_HOLD state when no quality hold is its record (an NCR's hold): the reason in words
 *   readiness  the plan's word for the work order and each of its materials, computed now from the site's live plan
 *              (modules/planning/readiness readinessFor: one read of the site's plan inputs, so once per request)
 */

export interface ReleaseBlockerFacts {
  readonly holds: readonly HoldFact[]
  /** The plan's answer; null for a repair (it plans no material). */
  readonly readiness: WorkOrderReadiness | null
}

export interface BlockerSubject {
  readonly id: string
  readonly kind: string
  readonly siteId: string
  readonly status: string
}

export async function readHoldFacts(db: Reader, workOrderId: string): Promise<HoldFact[]> {
  const holds = await activeHoldsOf(db, 'WorkOrder', [workOrderId])
  const row = await db.workOrder.findUnique({ where: { id: workOrderId }, select: { status: true, holdReason: true, heldAt: true, holdRecordType: true, holdRecordId: true } })
  const words = holds.length > 0 ? await reasonWords(db, 'HOLD') : new Map()
  const facts: HoldFact[] = holds.map((hold) => ({ holdId: hold.id, reason: words.get(hold.reasonCode)?.labelEn ?? hold.reasonCode, placedAt: toUtcIso(hold.placedAt) }))
  // ON_HOLD under a record that is not one of these quality holds (an NCR): the work order's own reason.
  const named = row?.holdRecordType === 'QualityHold' && holds.some((hold) => hold.id === row.holdRecordId)
  if (row?.status === 'ON_HOLD' && !named) facts.push({ holdId: null, reason: row.holdReason ?? 'on hold', placedAt: toUtcIso(row.heldAt ?? new Date(0)) })
  return facts
}

/**
 * Live plans by site and day, for a reader that checks many work orders in one request (Today's "held" source runs THE
 * release check for up to 50 drafts: one netting per site, not per draft). Made per request by the caller, never kept.
 */
export type PlanCache = Map<string, Promise<LivePlan | null>>
export const newPlanCache = (): PlanCache => new Map()

function livePlanFor(db: Reader, siteId: string, today: BusinessDate, cache: PlanCache): Promise<LivePlan | null> {
  const key = `${siteId}|${today}`
  let plan = cache.get(key)
  if (!plan) {
    plan = (async () => {
      const site = await db.site.findUnique({ where: { id: siteId }, select: PLANNING_SITE_COLUMNS })
      return site ? livePlanOf(db, site, today) : null
    })()
    cache.set(key, plan)
  }
  return plan
}

export async function readReadiness(db: Reader, siteId: string, workOrderId: string, today: BusinessDate, cache: PlanCache = newPlanCache()): Promise<WorkOrderReadiness | null> {
  const live = await livePlanFor(db, siteId, today, cache)
  if (!live) return null
  const [answer] = await readinessFor(db, live.site, [workOrderId], live)
  return answer ?? null
}

/**
 * Everything the W2a blockers read for one work order (a repair reads its holds only). The plan's readiness nets the whole
 * site, so it is read only when it can change the answer — a material short on hand now (`short`) — unless the caller
 * shows it (`always`: the record's release check, whose readiness line the person reads).
 */
export async function readReleaseBlockers(db: Reader, workOrder: BlockerSubject, today: BusinessDate, options: { readonly cache?: PlanCache; readonly readiness: 'always' | 'whenShort' | 'never'; readonly short: boolean }): Promise<ReleaseBlockerFacts> {
  const holds = await readHoldFacts(db, workOrder.id)
  const wanted = workOrder.kind !== 'REPAIR' && options.readiness !== 'never' && (options.readiness === 'always' || options.short)
  const readiness = wanted ? await readReadiness(db, workOrder.siteId, workOrder.id, today, options.cache ?? newPlanCache()) : null
  return { holds, readiness }
}

/** The plan's words per material, as the MATERIAL check reads them (null: the plan has no part of the work order). */
export function materialReadinessOf(readiness: WorkOrderReadiness | null): MaterialReadinessFact[] | null {
  if (!readiness || readiness.word === 'NOT_PLANNED') return null
  return readiness.materials.map((material) => ({ itemId: material.itemId, itemColourId: material.itemColourId, word: material.word, date: material.date, reason: material.reason }))
}

/** The release check's `readiness` part: the word, its date and reason, and each material's (no money, no person). */
export function readinessPart(readiness: WorkOrderReadiness | null) {
  if (!readiness) return null
  return {
    word: readiness.word,
    date: readiness.date,
    reason: readiness.reason,
    materials: readiness.materials.map((material) => ({
      itemId: material.itemId,
      itemColourId: material.itemColourId,
      label: material.label,
      uom: material.uom,
      word: material.word,
      date: material.date,
      needed: material.needed,
      reserved: material.reserved,
      inStock: material.inStock,
      onOrder: material.onOrder,
      short: material.short,
      reason: material.reason,
    })),
  }
}
