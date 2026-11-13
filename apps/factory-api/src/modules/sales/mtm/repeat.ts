import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { RepeatBody } from '@nexus/factory-domain/sales/mtm/contracts'
import { isOld, monthsBetween, OLD_AFTER_MONTHS, type ReviewStatus } from '@nexus/factory-domain/sales/mtm/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { QUOTES_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { assertMay as assertMayOrder } from '../orders/access'
import { addUnitInCommand, unitViews } from '../quotes/mtm-line'
import { detailInCommand, onQuote } from '../quotes/quotes'
import { officeQuote } from '../quotes/store'
import { waitsForMeasures } from './order-gate'
import { assertMayProfile, chainOf, latestOf, officeOf, profileNotFound, profileOf, unitsOf } from './store'

/**
 * A repeat order from a rider's saved profile (B-W2b-358; SAL-300; design sales.mtm › Orders "Repeat order from the latest profile
 * (prompts to re-measure if old)"), and the made-to-measure units of an order:
 *
 *   GET  /sales/mtm/profiles/:profileId/repeat   sales.measurements.view: the rider's newest revision (when, its review), whether a
 *                                                new measure is asked first (measured more than 12 months ago), and the units made
 *                                                to the rider's garment type, newest first (what a repeat copies)
 *   POST /sales/mtm/profiles/:profileId/repeat   quotes.manage over the quote (and sales.measurements.view over the customer):
 *                                                {quoteId, version, fromLineId?, measuredOk} a unit like an earlier one (its style,
 *                                                colourway and base size; priced as a new unit: the customer's list price) on the
 *                                                rider's NEWEST revision, on the DRAFT quote named (orders are made from quotes: W1).
 *                                                Old measures are refused in words (409 "ask for a new measure") unless the person
 *                                                says they order on them anyway (measuredOk, kept in the audit)
 *   GET  /sales/orders/:orderId/made-to-measure  orders.view: the order's units, each checked, and whether it waits for the review
 */

async function readableProfile(caller: CommandCaller, profileId: string) {
  const context = officeOf(caller)
  const row = await caller.withClient((db) => profileOf(db, profileId))
  if (!row) throw profileNotFound()
  assertMayProfile(context, row.partyId)
  return row
}

const reMeasureWords = (takenOn: string, months: number): string => `Measured on ${takenOn}, ${months} months ago (more than ${OLD_AFTER_MONTHS}): ask for a new measure first (a measurement link, or a fitting), or say you order on these measures anyway.`

/** GET /sales/mtm/profiles/:profileId/repeat */
export async function repeatFacts(caller: CommandCaller, profileId: string) {
  const row = await readableProfile(caller, profileId)
  const now = serverClock.now()
  const today = businessDate(now)
  return caller.withClient(async (db) => {
    const chain = await chainOf(db, row)
    const latest = chain.at(-1)!
    const takenOn = businessDate(latest.takenAt)
    const old = isOld(takenOn, today)
    const months = monthsBetween(takenOn, today)
    return {
      repeat: {
        latest: { id: latest.id, revision: latest.revision, takenAt: toUtcIso(latest.takenAt), takenOn, months, old, review: latest.reviewStatus as ReviewStatus },
        reMeasure: old ? reMeasureWords(takenOn, months) : null,
        earlier: await unitsOf(db, chain.map((revision) => revision.id)),
      },
    }
  })
}

/** POST /sales/mtm/profiles/:profileId/repeat */
export async function repeatOrder(caller: CommandCaller, profileId: string, body: RepeatBody, idempotencyKey?: string) {
  const row = await readableProfile(caller, profileId)
  const quote = await officeQuote(caller, body.quoteId, QUOTES_MANAGE)
  const now = serverClock.now()
  const facts = await caller.withClient(async (db) => {
    const latest = (await latestOf(db, row))!
    const units = await unitsOf(db, (await chainOf(db, row)).map((revision) => revision.id))
    return { latest, units }
  })
  const from = body.fromLineId ? facts.units.find((unit) => unit.lineId === body.fromLineId) : facts.units[0]
  if (!from) throw body.fromLineId ? new NotFoundError('Made-to-measure line not found (not a unit of this rider).') : new DomainError('conflict', `${row.riderName} has no made-to-measure unit yet to repeat: add one to the quote (…/lines/made-to-measure).`, [{ path: 'body/fromLineId', message: 'No earlier unit.' }])
  const takenOn = businessDate(facts.latest.takenAt)
  const old = isOld(takenOn, businessDate(now))
  if (old && !body.measuredOk) {
    const message = reMeasureWords(takenOn, monthsBetween(takenOn, businessDate(now)))
    throw new DomainError('conflict', message, [{ path: 'body/measuredOk', message }])
  }
  let lineId = ''
  const answer = await onQuote(caller, quote, { name: 'quotes.repeatMtm', idempotencyKey, input: { profileId, ...body }, version: body.version }, async (tools, current, version) => {
    lineId = await addUnitInCommand(tools, current, version, {
      styleId: from.style.id,
      colourwayId: from.colourway.id,
      profile: facts.latest,
      baseSize: from.baseSize,
      at: 'body',
      audit: { repeatOf: { lineId: from.lineId, kind: from.kind, number: from.number, revision: from.revision }, measuredOk: old ? true : undefined },
    })
    return detailInCommand(tools, current.id)
  })
  return { quote: answer.quote, lineId }
}

/** GET /sales/orders/:orderId/made-to-measure */
export async function orderUnits(caller: CommandCaller, orderId: string) {
  const context = officeOf(caller)
  const order = await caller.withClient((db) => db.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, number: true, status: true, companyId: true, partyId: true } }))
  assertMayOrder(context, ORDERS_VIEW, order)
  return caller.withClient(async (db) => {
    const lines = await db.salesOrderLine.findMany({ where: { orderId: order!.id, kind: 'MADE_TO_MEASURE' }, select: { id: true, seq: true, styleId: true, colourwayId: true, measurementProfileId: true, baseSize: true }, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
    const waits = order!.status === 'PENDING_APPROVAL' && (await waitsForMeasures(db, order!.id))
    return { made: { kind: 'ORDER' as const, id: order!.id, number: order!.number, status: order!.status as string, waitsForReview: waits, units: await unitViews(db, 'ORDER', lines) } }
  })
}
