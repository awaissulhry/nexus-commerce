import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { QUALITY_CAPA_VIEW } from '@nexus/factory-domain/quality/capa/permissions'
import {
  averageDays,
  changeOf,
  daysBetween,
  dhuOf,
  doneOnTime,
  emptyTally,
  fpyOf,
  headcountOf,
  oldHoldAt,
  openAt,
  passRateOf,
  pct,
  peopleShown,
  previousOf,
  quarantineDaysOf,
  REPORT_LIMITS,
  rowFigures,
  spanOf,
  unitsInspectedOf,
  weeksOf,
  type Dimension,
  type KpiKey,
  type Period,
  type Tally,
  type Week,
} from '@nexus/factory-domain/quality/reports/rules'
import type { CommandCaller } from '../../../core/command'
import { headOf, momentOf, placeOf, type Place } from './access'
import type { CompareQuery, IncomingQuery, KpisQuery, TrendQuery } from './contract'
import {
  amendmentsSigned,
  capaActionsDone,
  capasClosed,
  chargesIn,
  crViFailed,
  endOfLineChecks,
  finalInspections,
  holdsAround,
  ids,
  incomingDecided,
  lotsReceived,
  lotSuppliers,
  makersCount,
  makersOf,
  ncrsAround,
  ncrsFound,
  operationsOf,
  partiesOf,
  peopleOfOperations,
  peopleOfPlaces,
  piecesByOperation,
  receiptWorkshops,
  sitePlaces,
  stylesOf,
  weeklyPeople,
  workOrdersOf,
  type EndOfLine,
  type FinalRow,
  type Reader,
  type Span,
} from './facts'

/**
 * The quality reports' answers (B-W2b-138; QHS-147; design quality.reports SCR-147): the headline numbers with the previous
 * period and a sparkline per week, the trend per week (all lines or one), the comparison by line, operation, supplier and
 * style, and incoming quality per supplier. Read only; every figure from signed records the caller may see; a group with
 * fewer people behind it than the company's minimum shows no figure (ANA-075; Statuto dei Lavoratori art. 4). Who the
 * people are never leaves the facts: only "enough" or "too few".
 */

const inSpan = (at: Date, span: Span): boolean => at.getTime() >= span.start.getTime() && at.getTime() < span.end.getTime()
const dayText = (value: Date): string => value.toISOString().slice(0, 10)
const sum = <T>(rows: readonly T[], of: (row: T) => number): number => rows.reduce((total, row) => total + of(row), 0)

interface WeekSpan extends Week {
  readonly span: Span
}
const weekSpans = (period: Period, timeZone: string): WeekSpan[] => weeksOf(period).map((week) => ({ ...week, span: spanOf(week, timeZone) }))

// ---- headline numbers -----------------------------------------------------------------------------------------------------------

interface RateNow {
  readonly tooFew: boolean
  readonly value: string | null
  readonly part: number | null
  readonly whole: number | null
  readonly checks: number | null
}

const masked = (tooFew: boolean, figures: Omit<RateNow, 'tooFew'>): RateNow => (tooFew ? { tooFew, value: null, part: null, whole: null, checks: null } : { tooFew, ...figures })

function rateAnswer(kpi: KpiKey, now: RateNow, before: RateNow | null, weeks: readonly { week: string; from: string; to: string; tooFew: boolean; value: string | null }[]) {
  return {
    ...now,
    previous: before ? { tooFew: before.tooFew, value: before.value } : null,
    change: before && !now.tooFew && !before.tooFew ? changeOf(kpi, now.value, before.value) : null,
    weeks: [...weeks],
  }
}

/** End-of-line figures of some checks over the people behind them. */
function endOfLineRates(checks: readonly EndOfLine[], people: number, minimum: number) {
  // Nothing counted is "—", not "too few": only a figure that exists can single someone out.
  const tooFew = checks.length > 0 && !peopleShown(people, minimum)
  const pieces = sum(checks, (row) => row.pieces)
  const defective = sum(checks, (row) => row.defectivePieces)
  const defects = sum(checks, (row) => row.defects)
  return {
    fpy: masked(tooFew, { value: fpyOf(pieces, defective), part: Math.max(0, pieces - defective), whole: pieces, checks: checks.length }),
    dhu: masked(tooFew, { value: dhuOf(defects, pieces), part: defects, whole: pieces, checks: checks.length }),
  }
}

/** The final AQL pass rate of some inspections over their makers. */
function aqlRate(finals: readonly FinalRow[], makers: ReadonlyMap<string, ReadonlySet<string>>, minimum: number): RateNow {
  const tooFew = finals.length > 0 && !peopleShown(makersCount(makers, finals.map((row) => row.workOrderId)), minimum)
  const passed = finals.filter((row) => row.passed).length
  return masked(tooFew, { value: passRateOf(passed, finals.length), part: passed, whole: finals.length, checks: finals.length })
}

async function capaRate(db: Reader, place: Place, span: Span): Promise<RateNow> {
  const actions = (await capaActionsDone(db, place.site.companyId, span)).filter((row) => can(place.actor, QUALITY_CAPA_VIEW, { companyId: row.capa.companyId, ...(row.capa.customerId ? { partyId: row.capa.customerId } : {}) }))
  // The owners are counted, never named: one person's actions on time would be that person's figure (ANA-075).
  const tooFew = actions.length > 0 && !peopleShown(headcountOf(actions.map((row) => row.ownerId)), place.minimum)
  const onTime = actions.filter((row) => doneOnTime(row.doneAt!, dayText(row.dueOn), place.site.timezone)).length
  return masked(tooFew, { value: pct(onTime, actions.length), part: onTime, whole: actions.length, checks: actions.length })
}

async function ncrCount(db: Reader, siteId: string, at: Date) {
  const open = (await ncrsAround(db, siteId, at)).filter((row) => openAt(row, at))
  return { value: open.length, averageAgeDays: averageDays(open.map((row) => daysBetween(row.foundOn, at))) }
}

async function oldHolds(db: Reader, siteId: string, at: Date): Promise<number> {
  const placedBefore = new Date(at.getTime() - REPORT_LIMITS.oldHoldDays * 86_400_000)
  return (await holdsAround(db, siteId, at, placedBefore)).filter((row) => oldHoldAt(row, at)).length
}

/** GET /quality/reports/kpis: the six headline numbers of the period, with the previous period when asked. */
export async function kpisAnswer(caller: CommandCaller, query: KpisQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, query)
    const { site, sight, minimum } = place
    const previous = query.compare === 'previous' ? previousOf(place.period) : null
    const before = previous ? spanOf(previous, site.timezone) : null
    const weeks = weekSpans(place.period, site.timezone)

    let fpy = null
    let dhu = null
    if (sight.inprocess) {
      const places = await sitePlaces(db, site.id)
      const checks = await endOfLineChecks(db, site.id, place.span)
      const now = endOfLineRates(checks, (await peopleOfPlaces(db, site.id, place.span, places)).site, minimum)
      const then = before ? endOfLineRates(await endOfLineChecks(db, site.id, before), (await peopleOfPlaces(db, site.id, before, places)).site, minimum) : null
      const people = await weeklyPeople(db, site.id, weeks, places)
      const perWeek = weeks.map((week) => ({ week, rates: endOfLineRates(checks.filter((row) => inSpan(row.decidedAt, week.span)), people.get(week.key)?.site ?? 0, minimum) }))
      fpy = rateAnswer('fpy', now.fpy, then?.fpy ?? null, perWeek.map(({ week, rates }) => ({ week: week.key, from: week.from, to: week.to, tooFew: rates.fpy.tooFew, value: rates.fpy.value })))
      dhu = rateAnswer('dhu', now.dhu, then?.dhu ?? null, perWeek.map(({ week, rates }) => ({ week: week.key, from: week.from, to: week.to, tooFew: rates.dhu.tooFew, value: rates.dhu.value })))
    }

    let aqlPass = null
    if (sight.inspections) {
      const finals = await finalInspections(db, site.id, place.span)
      const earlier = before ? await finalInspections(db, site.id, before) : []
      const makers = await makersOf(db, ids([...finals, ...earlier].map((row) => row.workOrderId)))
      const perWeek = weeks.map((week) => {
        const rate = aqlRate(finals.filter((row) => inSpan(row.decidedAt, week.span)), makers, minimum)
        return { week: week.key, from: week.from, to: week.to, tooFew: rate.tooFew, value: rate.value }
      })
      aqlPass = rateAnswer('aqlPass', aqlRate(finals, makers, minimum), before ? aqlRate(earlier, makers, minimum) : null, perWeek)
    }

    let ncrOpen = null
    if (sight.ncr) {
      const now = await ncrCount(db, site.id, momentOf(place.span, place.now))
      const then = before ? await ncrCount(db, site.id, momentOf(before, place.now)) : null
      ncrOpen = { ...now, previous: then, change: then ? changeOf('ncrOpen', now.value, then.value) : null }
    }

    const capaOnTime = sight.capa ? rateAnswer('capaOnTime', await capaRate(db, place, place.span), before ? await capaRate(db, place, before) : null, []) : null

    let holdsOld = null
    if (sight.holds) {
      const now = await oldHolds(db, site.id, momentOf(place.span, place.now))
      const then = before ? await oldHolds(db, site.id, momentOf(before, place.now)) : null
      holdsOld = { value: now, averageAgeDays: null, previous: then === null ? null : { value: then, averageAgeDays: null }, change: then === null ? null : changeOf('holdsOld', now, then) }
    }

    const amendments = sight.inspections || sight.incoming || sight.inprocess ? { signed: await amendmentsSigned(db, site.id, place.span) } : null

    return {
      ...headOf(place),
      previous,
      sight,
      kpis: { fpy, dhu, aqlPass, ncrOpen, capaOnTime, holdsOld },
      amendments,
    }
  })
}

// ---- the trend --------------------------------------------------------------------------------------------------------------------

/** GET /quality/reports/trend: FPY and DHU per week (all lines, or one), the final AQL pass, and the CAPAs closed each week. */
export async function trendAnswer(caller: CommandCaller, query: TrendQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, query)
    const { site, sight, minimum } = place
    const places = await sitePlaces(db, site.id)
    const lineId = query.lineId ?? null
    if (lineId && !places.lines.some((line) => line.id === lineId)) throw new NotFoundError('Line not found.')
    const weeks = weekSpans(place.period, site.timezone)

    const checks = sight.inprocess ? await endOfLineChecks(db, site.id, place.span, lineId) : []
    const people = sight.inprocess ? await weeklyPeople(db, site.id, weeks, places) : new Map()
    let finals = sight.inspections ? await finalInspections(db, site.id, place.span) : []
    if (lineId) {
      const orders = await workOrdersOf(db, ids(finals.map((row) => row.workOrderId)))
      finals = finals.filter((row) => orders.get(row.workOrderId)?.lineId === lineId)
    }
    const makers = await makersOf(db, ids(finals.map((row) => row.workOrderId)))
    const closed = sight.capa ? (await capasClosed(db, site.companyId, place.span)).filter((row) => can(place.actor, QUALITY_CAPA_VIEW, { companyId: row.companyId, ...(row.customerId ? { partyId: row.customerId } : {}) })) : []

    return {
      ...headOf(place),
      sight,
      lineId,
      lines: places.lines.map((line) => ({ ...line })),
      weeks: weeks.map((week) => {
        const counted = checks.filter((row) => inSpan(row.decidedAt, week.span))
        const behind = lineId ? (people.get(week.key)?.byLine.get(lineId) ?? 0) : (people.get(week.key)?.site ?? 0)
        const tooFew = sight.inprocess && counted.length > 0 && !peopleShown(behind, minimum)
        const show = sight.inprocess && !tooFew
        const pieces = sum(counted, (row) => row.pieces)
        const defects = sum(counted, (row) => row.defects)
        const weekFinals = finals.filter((row) => inSpan(row.decidedAt, week.span))
        const aql = aqlRate(weekFinals, makers, minimum)
        const capas = closed.filter((row) => row.closedAt && inSpan(row.closedAt, week.span))
        return {
          week: week.key,
          from: week.from,
          to: week.to,
          tooFew,
          fpy: show ? fpyOf(pieces, sum(counted, (row) => row.defectivePieces)) : null,
          dhu: show ? dhuOf(defects, pieces) : null,
          pieces: show ? pieces : null,
          defects: show ? defects : null,
          checks: show ? counted.length : null,
          aql: sight.inspections && !aql.tooFew ? { passed: aql.part ?? 0, decided: aql.whole ?? 0, pct: aql.value } : null,
          aqlTooFew: sight.inspections && aql.tooFew,
          capaClosed: sight.capa ? { count: capas.length, capas: capas.slice(0, REPORT_LIMITS.closuresPerWeek).map((row) => ({ id: row.id, number: row.number })) } : null,
        }
      }),
    }
  })
}

// ---- the comparison -------------------------------------------------------------------------------------------------------------

interface Row {
  readonly key: string
  readonly ref: { readonly id: string | null; readonly code: string; readonly name: string } | null
  readonly tally: Tally
  /** null: a dimension whose rows are not people (suppliers). */
  readonly people: number | null
}

const tallyIn = (rows: Map<string, Tally>, key: string): Tally => {
  const found = rows.get(key)
  if (found) return found
  const fresh = emptyTally()
  rows.set(key, fresh)
  return fresh
}

const NONE = '-'

async function lineRows(db: Reader, place: Place): Promise<Row[]> {
  const { site, sight } = place
  const places = await sitePlaces(db, site.id)
  const tallies = new Map<string, Tally>()
  if (sight.inprocess) {
    for (const check of await endOfLineChecks(db, site.id, place.span)) {
      const tally = tallyIn(tallies, check.lineId ?? NONE)
      tally.inspected += check.pieces
      tally.defects += check.defects
    }
  }
  const finals = sight.inspections ? await finalInspections(db, site.id, place.span) : []
  const ncrs = sight.ncr ? await ncrsFound(db, site.id, place.span) : []
  const orders = await workOrdersOf(db, ids([...finals.map((row) => row.workOrderId), ...ncrs.map((row) => row.workOrderId)]))
  for (const row of finals) {
    const tally = tallyIn(tallies, orders.get(row.workOrderId)?.lineId ?? NONE)
    tally.decided += 1
    if (row.passed) tally.passed += 1
  }
  for (const row of ncrs) if (row.workOrderId) tallyIn(tallies, orders.get(row.workOrderId)?.lineId ?? NONE).ncrs += 1
  const people = await peopleOfPlaces(db, site.id, place.span, places)
  const names = new Map(places.lines.map((line) => [line.id, line]))
  return [...tallies].map(([key, tally]) => ({ key, ref: key === NONE ? null : names.get(key) ?? { id: key, code: '?', name: '?' }, tally, people: key === NONE ? people.alone : (people.byLine.get(key) ?? 0) }))
}

async function operationRows(db: Reader, place: Place): Promise<Row[]> {
  const { site, sight } = place
  if (!sight.inprocess) return []
  const charges = await chargesIn(db, site.id, place.span)
  const pieces = await piecesByOperation(db, site.id, place.span)
  const operations = await operationsOf(db, ids([...charges.map((row) => row.workOrderOperationId), ...pieces.keys()]))
  const tallies = new Map<string, Tally>()
  const refs = new Map<string, { id: string | null; code: string; name: string }>()
  for (const [operationId, count] of pieces) {
    const operation = operations.get(operationId)
    if (!operation) continue
    tallyIn(tallies, operation.key).inspected += count
    if (!refs.has(operation.key)) refs.set(operation.key, { id: operation.operationId, code: operation.code, name: operation.name })
  }
  for (const charge of charges) {
    const operation = operations.get(charge.workOrderOperationId)
    if (!operation) continue
    tallyIn(tallies, operation.key).defects += charge.defects
    if (!refs.has(operation.key)) refs.set(operation.key, { id: operation.operationId, code: operation.code, name: operation.name })
  }
  const people = await peopleOfOperations(db, site.id, place.span, new Map([...operations].map(([id, operation]) => [id, operation.key])))
  return [...tallies].map(([key, tally]) => ({ key, ref: refs.get(key) ?? null, tally, people: people.get(key) ?? 0 }))
}

async function supplierRows(db: Reader, place: Place): Promise<Row[]> {
  const { site, sight } = place
  const tallies = new Map<string, Tally>()
  const inspections = sight.incoming ? await incomingDecided(db, site.id, place.span) : []
  const ncrs = sight.ncr ? await ncrsFound(db, site.id, place.span) : []
  const suppliers = await lotSuppliers(db, ids([...inspections.map((row) => row.lotId), ...ncrs.map((row) => row.lotId)]))
  const workshops = await receiptWorkshops(db, ids(inspections.map((row) => row.subcontractReceiptId)))
  for (const row of inspections) {
    const party = (row.lotId ? suppliers.get(row.lotId) : row.subcontractReceiptId ? workshops.get(row.subcontractReceiptId) : null) ?? NONE
    const tally = tallyIn(tallies, party)
    tally.inspected += row.sampleSize
    tally.defects += row.foundCritical + row.foundMajor + row.foundMinor
    tally.decided += 1
    if (row.computedResult === 'PASS') tally.passed += 1
  }
  for (const row of ncrs) {
    const party = row.supplierId ?? (row.lotId ? suppliers.get(row.lotId) : null)
    if (party) tallyIn(tallies, party).ncrs += 1
  }
  const parties = await partiesOf(db, [...tallies.keys()].filter((key) => key !== NONE))
  return [...tallies].map(([key, tally]) => ({ key, ref: key === NONE ? null : parties.get(key) ?? { id: key, code: '?', name: '?' }, tally, people: null }))
}

async function styleRows(db: Reader, place: Place): Promise<Row[]> {
  const { site, sight } = place
  const finals = sight.inspections ? await finalInspections(db, site.id, place.span) : []
  const ncrs = sight.ncr ? await ncrsFound(db, site.id, place.span) : []
  const orders = await workOrdersOf(db, ids([...finals.map((row) => row.workOrderId), ...ncrs.map((row) => row.workOrderId)]))
  const tallies = new Map<string, Tally>()
  const ordersOfStyle = new Map<string, Set<string>>()
  const note = (style: string, order: string | null) => {
    if (order) ordersOfStyle.set(style, (ordersOfStyle.get(style) ?? new Set<string>()).add(order))
  }
  for (const row of finals) {
    const style = orders.get(row.workOrderId)?.styleId
    if (!style) continue
    const tally = tallyIn(tallies, style)
    tally.inspected += unitsInspectedOf(row)
    tally.defects += row.defects
    tally.decided += 1
    if (row.passed) tally.passed += 1
    note(style, row.workOrderId)
  }
  for (const row of ncrs) {
    const style = row.styleId ?? (row.workOrderId ? orders.get(row.workOrderId)?.styleId : null)
    if (!style) continue
    tallyIn(tallies, style).ncrs += 1
    note(style, row.workOrderId)
  }
  const makers = await makersOf(db, ids([...ordersOfStyle.values()].flatMap((set) => [...set])))
  const styles = await stylesOf(db, [...tallies.keys()])
  return [...tallies].map(([key, tally]) => ({ key, ref: styles.get(key) ?? { id: key, code: '?', name: '?' }, tally, people: makersCount(makers, ordersOfStyle.get(key) ?? []) }))
}

/** GET /quality/reports/compare?by=line|operation|supplier|style: one row per group, never per worker. */
export async function compareAnswer(caller: CommandCaller, query: CompareQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, query)
    const by: Dimension = query.by ?? 'line'
    const { sight } = place
    const columns = {
      line: { counts: sight.inprocess, aql: sight.inspections, ncrs: sight.ncr },
      operation: { counts: sight.inprocess, aql: false, ncrs: false },
      supplier: { counts: sight.incoming, aql: sight.incoming, ncrs: sight.ncr },
      style: { counts: sight.inspections, aql: sight.inspections, ncrs: sight.ncr },
    }[by]
    const rows = by === 'line' ? await lineRows(db, place) : by === 'operation' ? await operationRows(db, place) : by === 'supplier' ? await supplierRows(db, place) : await styleRows(db, place)
    let hidden = 0
    const answered = rows.map((row) => {
      const tooFew = row.people !== null && !peopleShown(row.people, place.minimum)
      if (tooFew) hidden += 1
      return { key: row.key, ref: row.ref, tooFew, ...rowFigures(by, row.tally, tooFew, columns) }
    })
    // Worst first by defects (a row with no figure last), then by code: groups are compared, never people.
    answered.sort((a, b) => Number(a.tooFew) - Number(b.tooFew) || (b.defects ?? -1) - (a.defects ?? -1) || (a.ref?.code ?? '~').localeCompare(b.ref?.code ?? '~'))
    return { ...headOf(place), by, sight: columns, rows: answered, hidden }
  })
}

// ---- incoming quality -------------------------------------------------------------------------------------------------------------

interface SupplierFacts {
  workshop: boolean
  lots: number
  rejected: number
  crVi: number
  days: number[]
  waiting: number
  inspections: number
  failed: number
}

/** GET /quality/reports/incoming: per supplier, the lots received, rejected, Cr VI fails, days in quarantine, and the incoming inspections. */
export async function incomingAnswer(caller: CommandCaller, query: IncomingQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, query)
    const { site, sight } = place
    const facts = new Map<string, SupplierFacts>()
    const factsOf = (key: string): SupplierFacts => {
      const found = facts.get(key)
      if (found) return found
      const fresh: SupplierFacts = { workshop: false, lots: 0, rejected: 0, crVi: 0, days: [], waiting: 0, inspections: 0, failed: 0 }
      facts.set(key, fresh)
      return fresh
    }
    if (sight.lots) {
      const lots = await lotsReceived(db, site.id, place.span)
      const failed = await crViFailed(db, lots.map((row) => row.id))
      for (const lot of lots) {
        const entry = factsOf(lot.supplierId ?? NONE)
        entry.lots += 1
        if (lot.qualityStatus === 'REJECTED') entry.rejected += 1
        if (lot.qualityStatus === 'QUARANTINE') entry.waiting += 1
        if (failed.has(lot.id)) entry.crVi += 1
        const days = quarantineDaysOf(lot, place.now)
        if (days !== null) entry.days.push(days)
      }
    }
    if (sight.incoming) {
      const inspections = await incomingDecided(db, site.id, place.span)
      const suppliers = await lotSuppliers(db, ids(inspections.map((row) => row.lotId)))
      const workshops = await receiptWorkshops(db, ids(inspections.map((row) => row.subcontractReceiptId)))
      for (const row of inspections) {
        const party = (row.lotId ? suppliers.get(row.lotId) : row.subcontractReceiptId ? workshops.get(row.subcontractReceiptId) : null) ?? NONE
        const entry = factsOf(party)
        if (row.subcontractReceiptId) entry.workshop = true
        entry.inspections += 1
        if (row.computedResult === 'FAIL') entry.failed += 1
      }
    }
    const parties = await partiesOf(db, [...facts.keys()].filter((key) => key !== NONE))
    const suppliers = [...facts].map(([key, entry]) => ({
      party: key === NONE ? null : parties.get(key) ?? { id: key, code: '?', name: '?' },
      workshop: entry.workshop && entry.lots === 0,
      lotsReceived: sight.lots ? entry.lots : null,
      rejected: sight.lots ? entry.rejected : null,
      crViFails: sight.lots ? entry.crVi : null,
      averageQuarantineDays: sight.lots ? averageDays(entry.days) : null,
      inQuarantine: sight.lots ? entry.waiting : null,
      inspections: sight.incoming ? entry.inspections : null,
      inspectionsFailed: sight.incoming ? entry.failed : null,
    }))
    suppliers.sort((a, b) => (a.party?.name ?? '~').localeCompare(b.party?.name ?? '~'))
    return { ...headOf(place), sight: { incoming: sight.incoming, lots: sight.lots }, suppliers }
  })
}
