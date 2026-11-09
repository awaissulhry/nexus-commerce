import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { EffectivityQuery, EffectivityView } from '@nexus/factory-domain/product/routing-depth/contracts'
import { effectiveDays, effectivityWords, endOfDays, releaseDayRefusal, revisionOn } from '@nexus/factory-domain/product/routing-depth/rules'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { contextOf, readStyleFor } from '../routing/store'
import { asDate, dayOf, REVISION_DAY_COLUMNS, revisionDaysOf } from './store'

/**
 * Routing versions with effectivity (B-W2b-225; PRD-124; B-W2b-205's StyleRevision.effectiveFrom / effectiveTo). A
 * revision's routing applies to new work orders from the day it is released (Europe/Rome; the database fills
 * effectiveFrom from releasedAt) until the next revision's release day (the replaced revision's effectiveTo, set here in
 * the release's own command). A work order made before keeps its frozen copy: its revision and operations are frozen from
 * its release on (W1), whatever is released after.
 *
 *   at release     W1's release (bom/revisions.ts releaseRevision) calls `effectivityAtReleaseInCommand` right after the
 *                  draft became RELEASED and the old one OBSOLETE: a draft planned for another day is refused (a release on
 *                  a planned day comes with change orders); the old revision's effectiveTo = the new one's effectiveFrom,
 *                  unless it was released that same day (it never applied a whole day: its days end where they began,
 *                  which the database refuses, so it keeps none and the next release's day closes it on read).
 *   at withdrawal  W1's obsolete of a RELEASED revision without a replacement calls `effectivityAtWithdrawalInCommand`:
 *                  effectiveTo = that day (same exception).
 *   the read       GET /product/styles/:styleId/routing/effectivity[?on=day]: each revision's days, the one in effect on
 *                  the day, and per revision the open work orders that keep its frozen routing (counts; their numbers
 *                  only with workorders.view).
 */

const todayIn = (now: Date): BusinessDate => businessDate(now)

/** Inside the release command, after the status moves. Answers the days written, for the audit row. */
export async function effectivityAtReleaseInCommand(tools: CommandTools, released: { readonly revisionId: string; readonly revision: number }, previousId: string | null): Promise<{ effectiveFrom: BusinessDate | null; previousEffectiveTo: BusinessDate | null }> {
  const { tx, now } = tools
  const row = await tx.styleRevision.findUniqueOrThrow({ where: { id: released.revisionId }, select: REVISION_DAY_COLUMNS })
  const today = todayIn(now)
  const effectiveFrom = dayOf(row.effectiveFrom)
  const refusal = releaseDayRefusal(released.revision, effectiveFrom, today)
  if (refusal) throw new InvalidStateError(refusal)
  if (!previousId || effectiveFrom === null) return { effectiveFrom, previousEffectiveTo: null }
  const previous = await tx.styleRevision.findUniqueOrThrow({ where: { id: previousId }, select: REVISION_DAY_COLUMNS })
  const end = endOfDays(revisionDaysOf(previous), effectiveFrom)
  if (end === null) return { effectiveFrom, previousEffectiveTo: null }
  await tx.styleRevision.update({ where: { id: previousId }, data: { effectiveTo: asDate(end), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  return { effectiveFrom, previousEffectiveTo: end }
}

/** Inside the obsolete command of a RELEASED revision withdrawn without a replacement. */
export async function effectivityAtWithdrawalInCommand(tools: CommandTools, revisionId: string): Promise<BusinessDate | null> {
  const { tx, now } = tools
  const row = await tx.styleRevision.findUniqueOrThrow({ where: { id: revisionId }, select: REVISION_DAY_COLUMNS })
  const end = endOfDays(revisionDaysOf(row), todayIn(now))
  if (end === null || row.status !== 'OBSOLETE' || row.releasedAt === null) return null
  await tx.styleRevision.update({ where: { id: revisionId }, data: { effectiveTo: asDate(end), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  return end
}

const OPEN = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED'] as const
const MAX_NUMBERS = 20

/** GET /product/styles/:styleId/routing/effectivity (product.routing.view over the style's company). */
export async function getEffectivity(caller: CommandCaller, styleId: string, query: EffectivityQuery): Promise<EffectivityView> {
  const style = await readStyleFor(caller, styleId)
  const actor = actorOf(contextOf(caller))
  const today = todayIn(serverClock.now())
  const on = query.on ?? today
  return caller.withClient(async (client) => {
    const rows = await client.styleRevision.findMany({ where: { styleId }, select: REVISION_DAY_COLUMNS, orderBy: { revision: 'asc' } })
    const days = effectiveDays(rows.map(revisionDaysOf))
    const inEffect = revisionOn(days, on)
    const current = revisionOn(days, today)
    const counts = await client.workOrder.groupBy({ by: ['styleRevisionId', 'status'], where: { styleId, status: { in: [...OPEN] }, styleRevisionId: { not: null } }, _count: { _all: true } })
    // Their numbers only for a reader of work orders, of the companies and sites that reader reaches.
    const mayList = can(actor, WORKORDERS_VIEW, style.companyId === null ? {} : { companyId: style.companyId })
    const listed = mayList
      ? await client.workOrder.findMany({
          where: { AND: [{ styleId, status: { in: [...OPEN] } }, scopeWhere(actor, WORKORDERS_VIEW, { company: 'companyId', site: 'siteId' })] },
          select: { number: true, styleRevisionId: true },
          orderBy: { number: 'asc' },
        })
      : null
    const revisions = days.map((entry) => {
      const mine = counts.filter((row) => row.styleRevisionId === entry.revision.id)
      const drafts = mine.filter((row) => row.status === 'DRAFT').reduce((sum, row) => sum + row._count._all, 0)
      const open = mine.reduce((sum, row) => sum + row._count._all, 0)
      return {
        id: entry.revision.id,
        revision: entry.revision.revision,
        status: entry.revision.status,
        effectiveFrom: entry.from,
        effectiveTo: entry.to,
        fromSource: entry.fromSource,
        inEffect: inEffect?.revision.id === entry.revision.id,
        workOrders: { open, drafts, numbers: listed ? listed.filter((row) => row.styleRevisionId === entry.revision.id).slice(0, MAX_NUMBERS).map((row) => row.number) : null },
      }
    })
    const keeping = revisions.filter((entry) => entry.id !== current?.revision.id).map((entry) => ({ revision: entry.revision, workOrders: entry.workOrders.open - entry.workOrders.drafts }))
    return {
      style: { id: style.id, code: style.code, name: style.name },
      today,
      on,
      inEffect: inEffect ? { id: inEffect.revision.id, revision: inEffect.revision.revision } : null,
      revisions,
      words: { ...effectivityWords(current, keeping) },
    }
  })
}
