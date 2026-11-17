import type { FactoryClient } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { dateOnly, type DatedLine, type DateOnly } from '@nexus/factory-domain/planning/promise/date-only'
import { impactOf, type Impact, type ImpactAsk, type ImpactLine } from '@nexus/factory-domain/sales/change-requests/impact'
import type { AskedCell, OrderRequestKind } from '@nexus/factory-domain/sales/change-requests/rules'
import { freezeVerdict, type FreezeRuleFacts, type OrderFreezeField, type OrderFreezeStage } from '@nexus/factory-domain/sales/order-changes/freeze'
import { countryOf } from '../../compliance/gates/facts'
import { LINES_LIMIT, promiseLinesOf } from '../../planning/promise-keep/lines'
import { answerPromises, type PromiseAsk } from '../../planning/promise/engine'
import { whereOf } from '../../planning/promise/read'
import { SITE_COLUMNS, type SiteRow } from '../../planning/store'
import { keeperPlanningContext } from '../../production/brand/facts'
import { activeRules } from '../order-changes/freeze'
import { readStages, stageOfLine, stageOfSize, type OrderStages } from '../order-changes/stages'

/**
 * B-PR-25 (production plan §3 "Before Send it sees: what is frozen, priced or not, earliest date"; 08-backend §4.2 "Impact
 * before Send": "only a date leaves it, never a load or a line"; lead picks L4; review fixes R-09, R-32; wall test PW-P06): the
 * facts of an ask's impact, read for ONE order of the customer in the tenant's scope (as the person: the freeze rules, the
 * cells' stages and planning are office tables), only AFTER the partner read found the order and only for that order's own
 * lines. The rules are factory-domain sales/change-requests/impact (impactOf):
 *
 *   frozen    the customer's own freeze rules beside the company's (order-changes/freeze activeRules: the customer's replace
 *             the company's per field) read against the furthest stage of each of the order's cells (order-changes/stages)
 *   priced    yes or no (the impact holds no amount); a cancel's fee is the caller's, for a reader with the price grain only
 *   earliest  planning's answer for what the ask is about, through the ONE shared helper planning/promise/date-only: the day
 *             the plan says the order's own open lines are ready (planning/promise-keep promiseLinesOf, the board's finish of
 *             their work orders, their planned orders, the promise engine for the pieces nothing makes yet), and, for a change
 *             that adds pieces, when the engine could make those pieces (they queue behind every order already in the plan).
 *             Asked only when the ask names a date (a change's, a rush's need-by date, a split's first part) or adds pieces,
 *             and for a split only its first part's sizes. Planning reads the whole plant (shared capacity): of it only the
 *             date, whether it is partial and whether it meets the date asked leave this file (dateOnly builds a new object of
 *             those three fields); a line no plant plans, or a plant whose read fails, is left out (the date says "partial").
 */

/** One line of the customer's own order, as the tenant's scope reads it for the impact. */
interface OrderLineFacts {
  readonly id: string
  readonly companyId: string
  readonly siteId: string | null
  readonly styleId: string
  readonly colourwayId: string
  readonly styleRevisionId: string | null
  readonly kind: string
}

/** What planning is asked about, for one order. */
export interface EarliestAsk {
  /** The date the customer asked for (a change's, a rush's need-by date, a split's first part's); null: none. */
  readonly wanted: BusinessDate | null
  /** The order's own lines whose planned day counts, each with the sizes that count (null: every open size of it). */
  readonly lines: readonly { readonly lineId: string; readonly sizes: readonly string[] | null }[]
  /** The pieces a change adds, per line and size (asked of the engine as pieces nothing makes yet). */
  readonly extra: readonly { readonly lineId: string; readonly sizes: readonly { readonly size: string; readonly quantity: number }[] }[]
}

/** What planning is asked for an ask (null: planning is not asked: no date named, no piece added). */
export function earliestAskOf(kind: OrderRequestKind, cells: readonly AskedCell[], requestedDate: BusinessDate | null, openLineIds: readonly string[]): EarliestAsk | null {
  if (kind === 'SPLIT_SHIPMENT') {
    const lines = new Map<string, string[]>()
    for (const cell of cells) if (cell.size !== null) lines.set(cell.orderLineId, [...(lines.get(cell.orderLineId) ?? []), cell.size])
    return { wanted: requestedDate, lines: [...lines].map(([lineId, sizes]) => ({ lineId, sizes })), extra: [] }
  }
  if (kind === 'CHANGE') {
    const extra = new Map<string, { size: string; quantity: number }[]>()
    for (const cell of cells) {
      if (cell.size === null || cell.quantity <= cell.quantityBefore) continue
      extra.set(cell.orderLineId, [...(extra.get(cell.orderLineId) ?? []), { size: cell.size, quantity: cell.quantity - cell.quantityBefore }])
    }
    if (requestedDate === null && extra.size === 0) return null
    return { wanted: requestedDate, lines: openLineIds.map((lineId) => ({ lineId, sizes: null })), extra: [...extra].map(([lineId, sizes]) => ({ lineId, sizes })) }
  }
  if (kind === 'RUSH' && requestedDate !== null) return { wanted: requestedDate, lines: openLineIds.map((lineId) => ({ lineId, sizes: null })), extra: [] }
  return null
}

const latestOf = (dates: readonly (BusinessDate | null)[]): BusinessDate | null => dates.reduce<BusinessDate | null>((best, date) => (date !== null && (best === null || date > best) ? date : best), null)
const meets = (date: BusinessDate | null, wanted: BusinessDate | null): boolean | null => (wanted === null || date === null ? null : date <= wanted)

/** The making site of each line (its own, else its company's only active plant; none: no plant plans it). */
async function sitesOf(db: FactoryClient, lines: readonly OrderLineFacts[]): Promise<Map<string, SiteRow | null>> {
  const out = new Map<string, SiteRow | null>()
  const own = [...new Set(lines.flatMap((line) => (line.siteId ? [line.siteId] : [])))]
  const sites = new Map((own.length > 0 ? await db.site.findMany({ where: { id: { in: own } }, select: SITE_COLUMNS }) : []).map((site) => [site.id, site]))
  const plants = new Map<string, SiteRow | null>()
  for (const line of lines) {
    if (line.siteId) {
      out.set(line.id, sites.get(line.siteId) ?? null)
      continue
    }
    if (!plants.has(line.companyId)) {
      const found = await db.site.findMany({ where: { companyId: line.companyId, kind: 'PLANT', status: 'ACTIVE' }, select: SITE_COLUMNS, take: 2 })
      plants.set(line.companyId, found.length === 1 ? found[0]! : null)
    }
    out.set(line.id, plants.get(line.companyId) ?? null)
  }
  return out
}

/**
 * Planning's earliest date for the ask, a date only. Each line asked becomes one dated line (its open sizes', or the sizes
 * named: the latest day the plan says one of them is ready), each line's added pieces another (the engine's day for them);
 * everything else planning knows stays here.
 */
export async function earliestOf(db: FactoryClient, input: { readonly tenantId: string; readonly requestId: string; readonly order: { readonly shipTo: unknown }; readonly lines: readonly OrderLineFacts[]; readonly ask: EarliestAsk; readonly now: Date }): Promise<DateOnly> {
  const { ask, now } = input
  const byId = new Map(input.lines.map((line) => [line.id, line]))
  const wantedIds = [...new Set([...ask.lines.map((entry) => entry.lineId), ...ask.extra.map((entry) => entry.lineId)])].filter((lineId) => byId.has(lineId))
  const sites = await sitesOf(db, wantedIds.map((lineId) => byId.get(lineId)!))
  const context = keeperPlanningContext(input.tenantId, input.requestId)
  const dated: DatedLine[] = []
  // A line that is not one of the order's own is never asked (nor named): left out.
  let leftOut = [...ask.lines, ...ask.extra].filter((entry) => !byId.has(entry.lineId)).length
  const bySite = new Map<string, { site: SiteRow; lineIds: string[] }>()
  for (const lineId of wantedIds) {
    const site = sites.get(lineId) ?? null
    if (!site) {
      leftOut += ask.lines.filter((entry) => entry.lineId === lineId).length + ask.extra.filter((entry) => entry.lineId === lineId).length
      continue
    }
    const group = bySite.get(site.id) ?? { site, lineIds: [] }
    group.lineIds.push(lineId)
    bySite.set(site.id, group)
  }
  for (const { site, lineIds } of bySite.values()) {
    const planned = ask.lines.filter((entry) => lineIds.includes(entry.lineId))
    const extra = ask.extra.filter((entry) => lineIds.includes(entry.lineId))
    try {
      // The day the plan says the order's own lines are ready (their work orders, planned orders, the engine for the rest).
      if (planned.length > 0) {
        const read = await promiseLinesOf(db, context, site, now, { orderLineIds: planned.map((entry) => entry.lineId), limit: LINES_LIMIT })
        const views = new Map(read.lines.map((line) => [line.id, line]))
        for (const entry of planned) {
          const view = views.get(entry.lineId)
          if (!view) {
            leftOut += 1
            continue
          }
          const sizes = view.sizes.filter((size) => size.open > 0 && (entry.sizes === null || (size.size !== null && entry.sizes.includes(size.size))))
          const unknown = sizes.length === 0 || sizes.some((size) => size.finish === null)
          const date = latestOf(sizes.map((size) => size.finish))
          dated.push({ date, complete: !unknown, meetsWanted: meets(date, ask.wanted) })
        }
      }
      // The pieces a change adds: asked of the engine as new pieces (behind every order already in the plan).
      if (extra.length > 0) {
        const { where } = await whereOf(db, site, now, countryOf(input.order.shipTo))
        const asks: PromiseAsk[] = extra.map((entry) => {
          const line = byId.get(entry.lineId)!
          return { key: `extra:${line.id}`, styleId: line.styleId, colourwayId: line.colourwayId, revisionId: line.styleRevisionId, sizes: entry.sizes.map((size) => ({ size: size.size, quantity: size.quantity })), madeToMeasure: line.kind === 'MADE_TO_MEASURE', wantedDate: ask.wanted }
        })
        for (const answer of await answerPromises(db, where, asks)) dated.push({ date: answer.date, complete: answer.complete, meetsWanted: answer.meetsWanted })
      }
    } catch {
      // A plant whose planning read fails (no calendar, a broken plan): its lines are left out (the date says "partial").
      leftOut += planned.length + extra.length
    }
  }
  return dateOnly(dated, leftOut)
}

/** What the impact reads of the order in the tenant's scope: its lines' stages, the customer's rules, the lines' making facts. */
export interface ImpactReads {
  readonly stages: OrderStages
  readonly rules: FreezeRuleFacts[]
  readonly lines: OrderLineFacts[]
}

export async function readImpactFacts(db: FactoryClient, order: { readonly id: string; readonly companyId: string; readonly partyId: string }, lineIds: readonly string[]): Promise<ImpactReads> {
  const rules = await activeRules(db, order.companyId, order.partyId)
  const stages = await readStages(db, lineIds)
  const lines = lineIds.length === 0 ? [] : await db.salesOrderLine.findMany({ where: { orderId: order.id, id: { in: [...lineIds] } }, select: { id: true, companyId: true, siteId: true, styleId: true, colourwayId: true, styleRevisionId: true, kind: true } })
  return { stages, rules, lines }
}

/** The order's own lines as the impact rules read them: each line's furthest stage and its sizes' (FEE lines are never made). */
export function impactLinesOf(lines: readonly { readonly id: string; readonly seq: number; readonly kind: string; readonly closedShortQuantity: number | null; readonly sizes: readonly { readonly size: string }[] }[], stages: OrderStages): ImpactLine[] {
  return lines
    .filter((line) => line.kind !== 'FEE')
    .map((line) => ({
      id: line.id,
      seq: line.seq,
      closedShort: line.closedShortQuantity !== null,
      stage: stageOfLine(stages, line.id).stage,
      sizeStages: Object.fromEntries(line.sizes.map((size) => [size.size, stageOfSize(stages, line.id, size.size).stage])),
    }))
}

/** What the ask touches, as the impact rules read it (a change's cells that move, its date and address; a date of a rush or a split). */
export function impactAskOf(kind: OrderRequestKind, cells: readonly AskedCell[], header: { readonly requestedDate: BusinessDate | null; readonly shipToAddressId: string | null }): ImpactAsk {
  if (kind === 'CHANGE') {
    // B-PR-27a: a cell of a line asked in another colourway reads the line's colour freeze (and its size's, when it changes).
    const asked = cells.filter((cell) => (cell.size !== null && cell.quantity !== cell.quantityBefore) || (cell.colourwayId ?? null) !== null)
    return { kind, cells: asked.map((cell) => ({ lineId: cell.orderLineId, size: cell.quantity !== cell.quantityBefore ? cell.size : null, ...((cell.colourwayId ?? null) !== null ? { colourway: true } : {}) })), requestedDate: header.requestedDate, shipTo: header.shipToAddressId !== null }
  }
  return { kind, requestedDate: kind === 'RUSH' || kind === 'SPLIT_SHIPMENT' ? header.requestedDate : null }
}

/** The impact itself (factory-domain impactOf) from the reads and planning's date only. */
export function impactFrom(ask: ImpactAsk, lines: readonly ImpactLine[], reads: Pick<ImpactReads, 'stages' | 'rules'>, cancelFeePct: string | null, earliest: DateOnly | null): Impact {
  return impactOf(ask, { lines, orderStage: reads.stages.order.stage, rules: reads.rules, cancelFeePct, earliest })
}

/** A freeze verdict as the customer reads it (its state and words; never the rule). */
export function freezeOf(rules: readonly FreezeRuleFacts[], field: OrderFreezeField, stage: OrderFreezeStage | null) {
  const verdict = freezeVerdict(rules, field, stage)
  return { state: verdict.state, words: { it: verdict.words.it, en: verdict.words.en } }
}
