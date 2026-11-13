import { plusDays } from '@nexus/factory-domain/calendars/dates'
import type { GateMarket } from '@nexus/factory-domain/compliance/gates/gate'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDayStart, type BusinessDate } from '@nexus/factory-domain/core/time'
import { availableOf } from '@nexus/factory-domain/planning/capacity/available'
import type { TimedBucket } from '@nexus/factory-domain/planning/capacity/load'
import { planLevelled } from '@nexus/factory-domain/planning/planned-orders/multilevel'
import { itemPlanningFor } from '@nexus/factory-domain/planning/settings/items'
import { atpRow, atpWeeks, stockDateFor } from '@nexus/factory-domain/planning/promise/atp'
import { bridgeOf, copyFree, CTP_HORIZON_DAYS, freeAfterLoad, freeWhenEmpty, walkSteps, type Bridge, type CtpLane, type CtpStep, type FreeMap, type StepTimes } from '@nexus/factory-domain/planning/promise/ctp'
import {
  bridgeWords,
  daysAfterWanted,
  groupsWords,
  materialDateOf,
  meetsWanted,
  minutesFor,
  sizeGroupsOf,
  sizeWords,
  warningsOf,
  type MaterialArrival,
  type MaterialNeed,
  type PromiseWarning,
  type SizeGroup,
  type SizeState,
} from '@nexus/factory-domain/planning/promise/rules'
import { sourceFor, sourceRules } from '@nexus/factory-domain/purchasing/sources/sources'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { bookedOf, capacityWorld, type CapacityWorld } from '../capacity/service'
import { latestDoneRun, readPlanInputs, type PlanInputs } from '../inputs'
import type { Reader, SiteRow } from '../store'
import { certificatesOn, type SizeCertificate } from './certificates'
import { readRouting, readSkuFlows, readStyleFacts, revisionFor, skuKey, withPromiseLines, type RevisionFacts, type RoutingStepRow, type SkuFlows, type StyleFacts } from './store'
// B-W2b-365: a step only for some options counts when the garment asked has one of them.
import { stepsForOptions } from './steps'

/**
 * The promise engine (B-W2b-301; PLN-168, PLN-169, PLN-171, PLN-179): when can these garments be ready, per size. THE
 * place the calculator, a quote's suggested dates and an order line's open sizes ask. Read only; one client, one query
 * after another.
 *
 *   1. certificates  a size no valid certificate covers today is not promised (the SHIPMENT gate's certificate check)
 *   2. stock         a SKU set to make to stock at the site promises from available to promise first (PLN-168)
 *   3. material      the rest is added to the site's live plan AFTER every real order line (planning/inputs' hook): the
 *                    plan's netting says per size and material what stock, purchase orders and firm planned orders still
 *                    cover, and what is to buy (the supplier's lead time) or make; the latest arrival is the size's start
 *   4. capacity      from that day the routing walks the lanes' free minutes (released work and its backlog first: the
 *                    queue), sizes whose material comes later after the earlier ones (PLN-171: sizes finish apart)
 *   5. certificates  again on each size's day: a certificate that ends before it does not promise the size (PLN-179)
 *
 * Several asks (a quote's lines) share the stock and the capacity in the order given.
 */

export interface PromiseAsk {
  /** The caller's key for the ask (a quote line id, "calculator"). */
  readonly key: string
  readonly styleId: string
  readonly colourwayId: string
  readonly revisionId?: string | null | undefined
  readonly sizes: readonly { readonly size: string; readonly quantity: number }[]
  readonly madeToMeasure?: boolean
  readonly wantedDate: BusinessDate | null
  /**
   * An order line already in the plan: its own pieces no work order makes yet are asked (the sizes' quantities), read from
   * the plan as they are (no line is added, no stock is taken for it).
   */
  readonly orderLineId?: string | null | undefined
  /**
   * B-W2b-365: the options chosen for the garment (a quote line's, an order line's, the calculator's): a routing step only for
   * some options is walked only when one of them is chosen (./steps). Left out: none chosen.
   */
  readonly optionValueIds?: readonly string[] | undefined
}

export interface PromiseWhere {
  readonly site: SiteRow
  readonly today: BusinessDate
  readonly now: Date
  readonly market: GateMarket | null
  readonly destination: string | null
}

export interface SizeAnswer {
  readonly size: string
  readonly quantity: number
  readonly fromStock: number
  readonly toMake: number
  readonly state: SizeState
  /** The day it can be promised; null: not promised. */
  readonly date: BusinessDate | null
  /** The day it could be ready (even when a certificate does not let it be promised). */
  readonly readyDate: BusinessDate | null
  readonly meetsWanted: boolean | null
  readonly daysLate: number | null
  readonly material: { readonly date: BusinessDate; readonly setBy: MaterialArrival | null; readonly arrivals: MaterialArrival[] } | null
  readonly bridge: Bridge | null
  readonly certificate: SizeCertificate | null
  readonly words: string
}

export interface AskAnswer {
  readonly key: string
  readonly style: { readonly id: string; readonly code: string; readonly name: string }
  readonly colourway: { readonly id: string; readonly code: string; readonly name: string }
  readonly revision: RevisionFacts | null
  readonly madeToMeasure: boolean
  readonly wantedDate: BusinessDate | null
  /** Every promised size ready (ship complete); null: none promised. */
  readonly date: BusinessDate | null
  readonly earliest: BusinessDate | null
  /** Every size asked is promised. */
  readonly complete: boolean
  readonly meetsWanted: boolean | null
  readonly daysLate: number | null
  readonly sizes: SizeAnswer[]
  readonly groups: SizeGroup[]
  readonly groupsWords: string
  /** The bridge of the date (the last group made). */
  readonly bridge: Bridge | null
  readonly bridgeWords: string | null
  readonly steps: (StepTimes & { readonly lane: { readonly code: string; readonly name: string } | null })[]
  readonly warnings: PromiseWarning[]
  readonly words: string
}

// ---- capacity -------------------------------------------------------------------------------------------------------------

interface Lanes {
  readonly lanes: readonly CtpLane[]
  readonly names: ReadonlyMap<string, { code: string; name: string }>
  /** The lanes that do a kind of work: lines that do it (or every operation), then its work centres. */
  readonly forKind: (kind: string) => string[]
}

const laneKeyOf = (kind: string, id: string) => `${kind}:${id}`

/** The site's lanes over the horizon: available and booked minutes per day, the backlog that waits first. */
export function lanesOf(world: CapacityWorld, today: BusinessDate): Lanes {
  const last = plusDays(today, CTP_HORIZON_DAYS)
  const days: TimedBucket[] = []
  for (let date = today; date <= last; date = plusDays(date, 1)) days.push({ key: date, from: date, to: date, start: businessDayStart(date, world.site.timezone), end: businessDayStart(plusDays(date, 1), world.site.timezone) })
  const windowStart = days[0]!.start.getTime()
  const lanes: CtpLane[] = world.lanes.map((state) => {
    const setup = { people: state.people, unit: state.lane.kind === 'LINE' ? ('people' as const) : ('stations' as const), efficiencyPct: state.efficiencyPct }
    const booked = bookedOf(world, state, days)
    const byDate = new Map(state.days.map((day) => [day.date, day]))
    const laneDays = state.calendar
      ? days.map((bucket) => {
          const day = byDate.get(bucket.from)
          return { date: bucket.from, available: day ? availableOf(setup, [day]).availableMinutes : new Dec(0), booked: booked.get(bucket.key)?.booked ?? new Dec(0) }
        })
      : []
    let backlog: Decimal = new Dec(0)
    for (const part of world.parts) {
      if (part.laneKind !== state.lane.kind || part.laneId !== state.lane.id) continue
      const placement = part.placement
      if (placement.placedBy === 'NO_DATE' || (placement.placedBy === 'DUE_DATE' && placement.date < today) || (placement.placedBy === 'SLOT' && placement.end.getTime() <= windowStart)) backlog = backlog.plus(part.minutes)
    }
    return { key: laneKeyOf(state.lane.kind, state.lane.id), kind: state.lane.kind, id: state.lane.id, code: state.lane.code, name: state.lane.name, days: laneDays, backlog }
  })
  const kindOfCentre = new Map(world.lanes.filter((state) => state.lane.kind === 'WORK_CENTRE').map((state) => [state.lane.id, state.lane.workCentreKind]))
  const forKind = (kind: string): string[] => [
    ...world.lanes.filter((state) => state.lane.kind === 'LINE' && (state.lane.workCentreIds.length === 0 || state.lane.workCentreIds.some((id) => kindOfCentre.get(id) === kind))).map((state) => laneKeyOf('LINE', state.lane.id)),
    ...world.lanes.filter((state) => state.lane.kind === 'WORK_CENTRE' && state.lane.workCentreKind === kind).map((state) => laneKeyOf('WORK_CENTRE', state.lane.id)),
  ]
  return { lanes, names: new Map(lanes.map((lane) => [lane.key, { code: lane.code, name: lane.name }])), forKind }
}

/** The routing as walk steps for these garments (a step that applies to some sizes or colourways counts only theirs; B-W2b-365: pass the steps for the ask's options, ./steps). */
export function stepsFor(routing: readonly RoutingStepRow[], colourwayId: string, garments: readonly { size: string; pieces: number }[], lanes: Pick<Lanes, 'forKind'>): CtpStep[] {
  return routing.map((step) => {
    const colourOk = step.appliesToColourwayIds.length === 0 || step.appliesToColourwayIds.includes(colourwayId)
    const pieces = colourOk ? garments.filter((entry) => step.appliesToSizes.length === 0 || step.appliesToSizes.includes(entry.size)).reduce((sum, entry) => sum + entry.pieces, 0) : 0
    const outside = step.supplierId !== null
    return { seq: step.seq, name: step.name, outside: outside && pieces > 0, transitDays: step.transitDays, laneKeys: outside ? [] : lanes.forKind(step.workCentreKind), minutes: outside ? new Dec(0) : minutesFor(step.standardMinutes, pieces) }
  })
}

// ---- material ----------------------------------------------------------------------------------------------------------

interface PlanLine {
  readonly askKey: string
  readonly orderLineId: string
  /** An order line of the plan: only its parts no work order makes yet. */
  readonly existing: boolean
}

/** Per promise line and size, its material needs as the plan netted them. */
function needsOf(inputs: PlanInputs, plan: ReturnType<typeof planLevelled>, lines: readonly PlanLine[], extra: { readonly planning: readonly ItemPlanningLead[]; readonly colourCodes: ReadonlyMap<string, string>; readonly companyId: string }): { needs: Map<string, MaterialNeed[]>; warnings: Map<string, PromiseWarning[]> } {
  const mine = new Map(lines.map((line) => [line.orderLineId, line.askKey]))
  const existing = new Set(lines.filter((line) => line.existing).map((line) => line.orderLineId))
  const needs = new Map<string, MaterialNeed[]>()
  const warnings = new Map<string, PromiseWarning[]>()
  const itemOf = new Map(inputs.items.map((item) => [item.id, item]))
  const poOf = new Map(inputs.purchases.map((line) => [line.purchaseOrderLineId, `${line.purchaseOrderNumber} line ${line.seq}`]))
  plan.requirements.forEach((requirement, index) => {
    const netting = plan.netting[index]
    if (!netting) return
    const item = itemOf.get(requirement.itemId)
    const label = [item?.code ?? 'A material', requirement.itemColourId ? extra.colourCodes.get(requirement.itemColourId) : null].filter(Boolean).join(' ')
    const rule = itemPlanningFor(extra.planning.filter((row) => row.itemId === requirement.itemId), requirement.itemColourId)
    let lead: number | null
    if (requirement.action === 'MAKE') lead = rule?.makeLeadTimeDays ?? null
    else {
      const source = requirement.supplierId ? sourceFor(inputs.sources, { companyId: extra.companyId, itemId: requirement.itemId, itemColourId: requirement.itemColourId }, requirement.supplierId) : null
      lead = rule?.buyLeadTimeDays ?? (source ? sourceRules(source, inputs.supplierLeadTimes.get(requirement.supplierId!) ?? null).leadTimeDays : (inputs.input.supplyRulesOf?.(requirement.itemId, requirement.supplierId).leadTimeDays ?? null))
    }
    for (const coverage of netting.pegging.coverage) {
      if (!mine.has(coverage.part.orderLineId)) continue
      if (existing.has(coverage.part.orderLineId) && coverage.part.workOrderId !== null) continue
      const key = `${coverage.part.orderLineId}|${coverage.part.size ?? ''}`
      needs.set(key, [
        ...(needs.get(key) ?? []),
        {
          itemId: requirement.itemId,
          itemColourId: requirement.itemColourId,
          label,
          action: requirement.action,
          supplies: coverage.supplies.map((supply) => ({ kind: supply.kind, quantity: supply.quantity, date: supply.date, purchaseOrderLineId: supply.purchaseOrderLineId })),
          uncovered: coverage.uncovered,
          leadTimeDays: lead,
          delayDays: rule?.delayDays ?? null,
          purchaseOf: (id) => poOf.get(id),
        },
      ])
    }
  })
  for (const warning of plan.warnings) {
    if (!warning.orderLineId || !mine.has(warning.orderLineId) || existing.has(warning.orderLineId)) continue
    const key = mine.get(warning.orderLineId)!
    warnings.set(key, [...(warnings.get(key) ?? []), { code: warning.code, words: warning.message.replace(/^PROMISE line \d+ /, 'It ') }])
  }
  return { needs, warnings }
}

interface ItemPlanningLead {
  readonly itemId: string
  readonly itemColourId: string | null
  readonly buyLeadTimeDays: number | null
  readonly makeLeadTimeDays: number | null
  readonly delayDays: number | null
}

// ---- the engine --------------------------------------------------------------------------------------------------------------

interface Prepared {
  readonly ask: PromiseAsk
  readonly facts: StyleFacts
  readonly colourway: { id: string; code: string; name: string }
  readonly revision: RevisionFacts | null
  readonly routing: RoutingStepRow[]
  readonly sizes: { size: string; quantity: number; fromStock: number; toMake: number; stockDate: BusinessDate | null; state: SizeState | null; certificate: SizeCertificate | null }[]
  readonly warnings: PromiseWarning[]
}

/** The asks' answers, in their order. */
export async function answerPromises(db: Reader, where: PromiseWhere, asks: readonly PromiseAsk[]): Promise<AskAnswer[]> {
  const { site, today, now } = where
  const styleCache = new Map<string, StyleFacts | null>()
  const flowsCache = new Map<string, SkuFlows[]>()
  const takenFromStock = new Map<string, number>()
  const prepared: Prepared[] = []

  for (const [index, ask] of asks.entries()) {
    const path = asks.length === 1 ? 'body' : `body/lines/${index}`
    if (!styleCache.has(ask.styleId)) styleCache.set(ask.styleId, await readStyleFacts(db, ask.styleId))
    const facts = styleCache.get(ask.styleId)
    if (!facts) throw new ValidationError('The style is not known.', [{ path: `${path}/styleId`, message: 'Name a style.' }])
    const colourway = (await db.colourway.findFirst({ where: { id: ask.colourwayId, styleId: ask.styleId }, select: { id: true, code: true, name: true } })) ?? null
    if (!colourway) throw new ValidationError('The colourway is not one of the style.', [{ path: `${path}/colourwayId`, message: 'Name a colourway of the style.' }])
    const unknown = ask.madeToMeasure ? [] : ask.sizes.filter((entry) => !facts.style.sizes.includes(entry.size))
    if (unknown.length > 0) throw new ValidationError(`Size ${unknown.map((entry) => entry.size).join(', ')} is not in the style's range (${facts.style.sizes.join(', ')}).`, unknown.map((entry) => ({ path: `${path}/sizes/${ask.sizes.indexOf(entry)}/size`, message: 'A size of the style.' })))
    const revision = await revisionFor(db, ask.styleId, ask.revisionId)
    const routing = await readRouting(db, revision?.id ?? null)
    const warnings: PromiseWarning[] = []
    if (!revision) warnings.push({ code: 'NO_RELEASED_BOM', words: `${facts.style.code} has no released revision: no material or routing is counted.` })
    else if (routing.length === 0) warnings.push({ code: 'NO_ROUTING', words: `Revision ${revision.revision} of ${facts.style.code} has no routing: the make time is not counted.` })
    if (revision && revision.status !== 'RELEASED') warnings.push({ code: 'REVISION_NOT_RELEASED', words: `Revision ${revision.revision} of ${facts.style.code} is ${revision.status}: the date counts its BOM and routing, and it must be released before work can start.` })
    prepared.push({ ask, facts, colourway, revision, routing, sizes: ask.sizes.map((entry) => ({ size: entry.size, quantity: entry.quantity, fromStock: 0, toMake: entry.quantity, stockDate: null, state: null, certificate: null })), warnings })
  }

  // 1. Certificates today: a size none covers now is not promised (nothing is made for it).
  for (const entry of prepared) {
    const certificates = await certificatesOn(db, { styleId: entry.facts.style.id, styleCode: entry.facts.style.code, asks: entry.sizes.map((size) => ({ key: size.size, colourwayId: entry.colourway.id, colourwayCode: entry.colourway.code, size: size.size })), market: where.market, destination: where.destination, day: today, now })
    for (const size of entry.sizes) {
      const answer = certificates.get(size.size) ?? null
      size.certificate = answer
      if (answer?.state === 'MISSING') {
        size.state = 'NOT_CERTIFIED'
        size.toMake = 0
      }
    }
  }

  // 2. Stock: a SKU made to stock at the site promises from available to promise first.
  const weeks = atpWeeks(today, Math.ceil(CTP_HORIZON_DAYS / 7))
  for (const entry of prepared) {
    if (entry.ask.madeToMeasure || entry.ask.orderLineId) continue
    if (!flowsCache.has(entry.facts.style.id)) flowsCache.set(entry.facts.style.id, await readSkuFlows(db, site, entry.facts))
    const flows = flowsCache.get(entry.facts.style.id)!
    for (const size of entry.sizes) {
      if (size.state === 'NOT_CERTIFIED') continue
      const flow = flows.find((candidate) => candidate.colourwayId === entry.colourway.id && candidate.size === size.size)
      if (!flow || flow.strategy !== 'MAKE_TO_STOCK') continue
      const key = skuKey(entry.colourway.id, size.size)
      const taken = takenFromStock.get(key) ?? 0
      const row = atpRow(flow, weeks)
      const date = stockDateFor(row, size.quantity + taken, today)
      if (date !== null) {
        size.fromStock = size.quantity
        size.toMake = 0
        size.stockDate = date
      } else {
        size.fromStock = Math.max(0, Math.min(size.quantity, row.availableNow - taken))
        size.toMake = size.quantity - size.fromStock
        size.stockDate = size.fromStock > 0 ? today : null
      }
      takenFromStock.set(key, taken + size.fromStock)
    }
  }

  // 3. Material: what is still to make, after every real order line of the site's live plan.
  const lines = prepared.map((entry, index) => ({
    entry,
    plan: {
      orderId: newId(),
      orderNumber: 'PROMISE',
      orderLineId: entry.ask.orderLineId ?? newId(),
      lineSeq: index + 1,
      styleId: entry.facts.style.id,
      colourwayId: entry.colourway.id,
      revisionId: entry.revision?.id ?? null,
      sizes: entry.sizes.filter((size) => size.toMake > 0).map((size) => ({ size: size.size, pieces: size.toMake })),
      partyId: null,
      madeToMeasure: entry.ask.madeToMeasure ?? false,
    },
  }))
  const toPlan = lines.filter((line) => line.plan.sizes.length > 0 && (line.plan.revisionId !== null || line.entry.ask.orderLineId))
  const added = toPlan.filter((line) => !line.entry.ask.orderLineId)
  let needs = new Map<string, MaterialNeed[]>()
  let planWarnings = new Map<string, PromiseWarning[]>()
  if (toPlan.length > 0) {
    const latest = await latestDoneRun(db, site.id)
    const inputs = await readPlanInputs(db, site, today, latest?.id ?? null, added.length === 0 ? undefined : withPromiseLines(db, added.map((line) => line.plan)))
    const plan = planLevelled(inputs.input, inputs.garments)
    const itemIds = [...new Set(plan.requirements.map((line) => line.itemId))]
    const planning = itemIds.length === 0 ? [] : await db.itemPlanning.findMany({ where: { siteId: site.id, itemId: { in: itemIds } }, select: { itemId: true, itemColourId: true, buyLeadTimeDays: true, makeLeadTimeDays: true, delayDays: true }, orderBy: { id: 'asc' } })
    const colourIds = [...new Set(plan.requirements.flatMap((line) => (line.itemColourId ? [line.itemColourId] : [])))]
    const colours = colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true } })
    const found = needsOf(inputs, plan, toPlan.map((line) => ({ askKey: line.entry.ask.key, orderLineId: line.plan.orderLineId, existing: Boolean(line.entry.ask.orderLineId) })), { planning, colourCodes: new Map(colours.map((colour) => [colour.id, colour.code])), companyId: site.companyId })
    needs = found.needs
    planWarnings = found.warnings
  }

  // 4. Capacity: the site's lanes, their load and backlog, walked in the asks' order.
  const world = await capacityWorld(db, site, { from: today, to: plusDays(today, CTP_HORIZON_DAYS) }, today)
  const lanes = lanesOf(world, today)
  const free: FreeMap = freeAfterLoad(lanes.lanes)
  const empty = freeWhenEmpty(lanes.lanes)
  const makeLeadOf = await makeLeadTimes(db, site, prepared)

  const answers: AskAnswer[] = []
  for (const line of lines) {
    const { entry } = line
    const warnings: PromiseWarning[] = [...entry.warnings, ...(planWarnings.get(entry.ask.key) ?? [])]
    const material = new Map<string, ReturnType<typeof materialDateOf>>()
    for (const size of entry.sizes) {
      if (size.toMake <= 0) continue
      const found = materialDateOf(needs.get(`${line.plan.orderLineId}|${entry.ask.madeToMeasure ? (line.plan.sizes[0]?.size ?? '') : size.size}`) ?? needs.get(`${line.plan.orderLineId}|`) ?? [], today)
      material.set(size.size, found)
      warnings.push(...found.warnings)
    }
    // Sizes whose material is there on the same day are made together; a later group queues behind the earlier ones.
    const byDate = new Map<BusinessDate, string[]>()
    for (const [size, found] of material) byDate.set(found.date, [...(byDate.get(found.date) ?? []), size])
    const finishOf = new Map<string, { finish: BusinessDate | null; bridge: Bridge | null; steps: StepTimes[] }>()
    let lastSteps: StepTimes[] = []
    let lastBridge: Bridge | null = null
    for (const date of [...byDate.keys()].sort()) {
      const group = byDate.get(date)!
      const garments = group.map((size) => ({ size, pieces: entry.sizes.find((candidate) => candidate.size === size)!.toMake }))
      let finish: BusinessDate | null
      let emptyFinish: BusinessDate | null
      let steps: StepTimes[] = []
      if (!entry.revision) {
        // Nothing to make it from: no released revision (the warning says so).
        finish = null
        emptyFinish = null
      } else if (entry.routing.length === 0) {
        const days = Math.max(0, ...group.map((size) => makeLeadOf(entry.colourway.id, size) ?? 0))
        finish = plusDays(date, days)
        emptyFinish = finish
      } else {
        const walkSpec = stepsFor(stepsForOptions(entry.routing, entry.ask.optionValueIds), entry.colourway.id, garments, lanes) // B-W2b-365
        const base = walkSteps(walkSpec, copyFree(empty), date, lanes.names)
        const real = walkSteps(walkSpec, free, date, lanes.names)
        warnings.push(...real.problems)
        finish = real.finish
        emptyFinish = base.finish
        steps = [...real.steps]
      }
      const bridge = finish === null ? null : bridgeOf(today, date, emptyFinish ?? finish, finish)
      for (const size of group) finishOf.set(size, { finish, bridge, steps })
      lastSteps = steps
      lastBridge = bridge
    }

    // 5. Dates per size, and the certificate on each size's day.
    const sizeDates = entry.sizes.map((size) => {
      if (size.state === 'NOT_CERTIFIED') return { size, ready: null as BusinessDate | null }
      const made = size.toMake > 0 ? (finishOf.get(size.size)?.finish ?? null) : null
      const ready = size.toMake > 0 ? (made === null ? null : size.stockDate && size.stockDate > made ? size.stockDate : made) : size.stockDate
      return { size, ready }
    })
    const days = [...new Set(sizeDates.flatMap((entry) => (entry.ready && entry.ready > today ? [entry.ready] : [])))].sort()
    for (const day of days) {
      const onDay = sizeDates.filter((candidate) => candidate.ready === day)
      const certificates = await certificatesOn(db, { styleId: entry.facts.style.id, styleCode: entry.facts.style.code, asks: onDay.map((candidate) => ({ key: candidate.size.size, colourwayId: entry.colourway.id, colourwayCode: entry.colourway.code, size: candidate.size.size })), market: where.market, destination: where.destination, day, now })
      for (const candidate of onDay) {
        const answer = certificates.get(candidate.size.size) ?? null
        if (answer) candidate.size.certificate = answer
        if (answer?.state === 'MISSING') candidate.size.state = 'NOT_CERTIFIED'
      }
    }
    const sizes: SizeAnswer[] = sizeDates.map(({ size, ready }) => {
      const state: SizeState = size.state === 'NOT_CERTIFIED' ? 'NOT_CERTIFIED' : ready === null ? 'NO_DATE' : size.toMake === 0 ? 'FROM_STOCK' : size.fromStock > 0 ? 'STOCK_AND_MAKE' : 'MAKE'
      const date = state === 'NOT_CERTIFIED' || state === 'NO_DATE' ? null : ready
      const found = material.get(size.size)
      const made = finishOf.get(size.size)
      if (size.certificate?.heldAtShipment) warnings.push({ code: 'HELD_AT_SHIPMENT', words: size.certificate.heldAtShipment })
      return {
        size: size.size,
        quantity: size.quantity,
        fromStock: size.fromStock,
        toMake: size.toMake,
        state,
        date,
        readyDate: ready,
        meetsWanted: meetsWanted(date, entry.ask.wantedDate),
        daysLate: daysAfterWanted(date, entry.ask.wantedDate),
        material: found ? { date: found.date, setBy: found.setBy, arrivals: found.arrivals } : null,
        bridge: made?.bridge ?? null,
        certificate: size.certificate,
        words: sizeWords({ size: size.size, state, date, fromStock: size.fromStock, toMake: size.toMake, why: state === 'NOT_CERTIFIED' ? (size.certificate?.words ?? null) : state === 'NO_DATE' ? (warnings.find((warning) => warning.code === 'NO_RELEASED_BOM' || warning.code === 'BEYOND_HORIZON' || warning.code === 'NO_CAPACITY')?.words ?? null) : null }, today),
      }
    })
    const promised = sizes.filter((size) => size.date !== null)
    const date = promised.length === 0 ? null : promised.map((size) => size.date!).reduce((a, b) => (a > b ? a : b))
    const earliest = promised.length === 0 ? null : promised.map((size) => size.date!).reduce((a, b) => (a < b ? a : b))
    const groups = sizeGroupsOf(sizes.map((size) => ({ size: size.size, date: size.date })), entry.facts.style.sizes, today)
    const lastMade = sizes.filter((size) => size.date === date && size.bridge).map((size) => size.bridge!)[0] ?? (date === null ? null : lastBridge)
    const setBy = sizes.find((size) => size.date === date && size.material?.setBy)?.material?.setBy ?? null
    const complete = promised.length === sizes.length
    const words =
      date === null
        ? `${entry.facts.style.code} ${entry.colourway.code}: no size can be promised.`
        : `${entry.facts.style.code} ${entry.colourway.code}: ${groupsWords(groups)}${complete ? '' : ' (not every size is promised)'}.`
    answers.push({
      key: entry.ask.key,
      style: { id: entry.facts.style.id, code: entry.facts.style.code, name: entry.facts.style.name },
      colourway: entry.colourway,
      revision: entry.revision,
      madeToMeasure: entry.ask.madeToMeasure ?? false,
      wantedDate: entry.ask.wantedDate,
      date,
      earliest,
      complete,
      meetsWanted: meetsWanted(complete ? date : null, entry.ask.wantedDate),
      daysLate: daysAfterWanted(date, entry.ask.wantedDate),
      sizes,
      groups,
      groupsWords: groupsWords(groups),
      bridge: lastMade,
      bridgeWords: lastMade ? bridgeWords(lastMade, setBy, today) : null,
      steps: lastSteps.map((step) => ({ ...step, lane: step.laneKey ? (lanes.names.get(step.laneKey) ?? null) : null })),
      warnings: warningsOf(warnings),
      words,
    })
  }
  return answers
}

/** The make lead time of a SKU at the site (ItemPlanning.makeLeadTimeDays of its FINISHED item), for a style without a routing. */
async function makeLeadTimes(db: Reader, site: SiteRow, prepared: readonly Prepared[]): Promise<(colourwayId: string, size: string) => number | null> {
  const styleIds = [...new Set(prepared.filter((entry) => entry.routing.length === 0).map((entry) => entry.facts.style.id))]
  if (styleIds.length === 0) return () => null
  const variants = await db.variant.findMany({ where: { styleId: { in: styleIds } }, select: { id: true, colourwayId: true, size: true } })
  const items = variants.length === 0 ? [] : await db.item.findMany({ where: { kind: 'FINISHED', variantId: { in: variants.map((variant) => variant.id) } }, select: { id: true, variantId: true } })
  const rows = items.length === 0 ? [] : await db.itemPlanning.findMany({ where: { siteId: site.id, itemId: { in: items.map((item) => item.id) } }, select: { itemId: true, makeLeadTimeDays: true } })
  const leadOfItem = new Map(rows.map((row) => [row.itemId, row.makeLeadTimeDays]))
  const itemOfVariant = new Map(items.map((item) => [item.variantId!, item.id]))
  const variantOf = new Map(variants.map((variant) => [`${variant.colourwayId}|${variant.size}`, variant.id]))
  return (colourwayId, size) => {
    const variant = variantOf.get(`${colourwayId}|${size}`)
    const item = variant ? itemOfVariant.get(variant) : undefined
    return item ? (leadOfItem.get(item) ?? null) : null
  }
}
