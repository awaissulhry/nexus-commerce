import type { FastifyInstance, FastifyRequest } from 'fastify'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import { effectiveHealth, type HealthRaise } from '@nexus/factory-domain/production-brand/health'
import { maskByLevel, progressSharedOf, shares, type ProductionShareLevel } from '@nexus/factory-domain/production-brand/levels'
import {
  APPROVAL_STATE_WORDS,
  CHANGE_PENDING_WORDS,
  GATE_STATE_WORDS,
  GATE_WORDS,
  gateOrder,
  nextMilestoneOf,
  ON_HOLD_WORDS,
  PARTLY_SHIPPED_WORDS,
  PAUSED_WORDS,
  problemStateOf,
  problemWords,
  swatchWords,
  type BrandGate,
  type PlannedDates,
  type ReportedProblem,
  type StageCounts,
} from '@nexus/factory-domain/production-brand/portal-read'
import { nextStageOf, type BrandStage, type OrderStage } from '@nexus/factory-domain/production-brand/stages'
import { brandList, usedOf, type UrgencyRow } from '@nexus/factory-domain/production-brand/urgency'
import { brandSideOf, type Waiting } from '@nexus/factory-domain/production-brand/waiting'
import {
  aheadWords,
  ASK_KIND_WORDS,
  BRAND_WAITING_WORDS,
  CHANGED_BY_US_WORDS,
  HEALTH_REASON_WORDS,
  HEALTH_WORDS,
  LEVEL_WORDS,
  SEWING_NOT_COUNTED_WORDS,
  setBackWords,
  STAGE_WORDS,
  URGENCY_WORDS,
  urgentUsedWords,
} from '@nexus/factory-domain/production-brand/words'
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import { PROGRESS_REFRESH_SECONDS, PROGRESS_STAGE_WORDS, PROGRESS_STAGES } from '@nexus/factory-domain/sales/portal-orders/progress'
import { customerPromiseHistory } from '@nexus/factory-domain/sales/portal-orders/promise'
import type { ExportCell, ExportLocale } from '@nexus/factory-domain/views/exports'
import { writeExport } from '../../../platform/exports/writer'
import { partnerOrder, portalReader, type PortalReader } from '../../sales/portal-orders/access'
import { progressFor } from '../../sales/portal-orders/progress'
import { dayOf, dayOrNull, namesOf, orderHistory, readLines, type PortalLine } from '../../sales/portal-orders/store'
import { GOODS_LINE_KINDS, isKeptState, keeperPlanningContext, readOrderProductionFacts } from '../brand/facts'
import {
  readGates,
  readOpenRequests,
  readOwnOrderNames,
  readPlanned,
  readProblems,
  readProductionOrders,
  readProductionRows,
  readProductionSettings,
  readSwatchAnswers,
  readWork,
  workOf,
  type BrandOrderRow,
  type OrderWork,
  type PartnerProductionRow,
  type ProductionSettings,
} from './access'
import { PRODUCTION_CHIPS, type ProductionChip } from './contract'

/**
 * B-PR-18 (production plan §2 the brand wall, §3 "Customer urgency", §4 "What a brand sees", §5 Portal; lead picks L17, L20, L24,
 * L25; review fixes R-10, R-26, R-41, R-42, R-43, R-46, R-65; Owner P3; the Owner rule 2026-11-16: "One brand must not be able to
 * see anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as
 * well."): the customer's own production in its portal.
 *
 *   GET /portal/production            My production: its orders in production (confirmed, not shipped in full) in ITS order —
 *                                     while its urgency is on, Urgent by its own urgent order, then Regular by the day it sent the
 *                                     order (oldest first), then when made, then number (production-brand/urgency brandList);
 *                                     off: every order by the day sent, no urgency in the read (the marks are kept, not used).
 *                                     Per order: its PO first, styles, pieces, the stage and the next, the ex-factory date (moved
 *                                     mark), the health chip with the reason code of a raise (never the note), who acts next (You
 *                                     or Us), the marks (on hold, paused at its request, partly shipped, change pending), its
 *                                     urgency (Urgent n, Urgent – asked, Changed by us, set to Regular by us with our reason), the
 *                                     next milestone by level, and the state of the problems it reported ("Waiting on us since
 *                                     16 Nov", "Answered", "Answered in SO-…"). The band: "2 of 3 urgent used" ("4 of 3 · 1 agreed
 *                                     with us") over its own open orders only. Chips with counts, search; every row, no page
 *   GET /portal/production?format=csv  the same rows (chip and search) as a CSV file in the person's language ("Export"): all of
 *                                     them, written here in the partner's scope (never the export job), urgency included
 *   GET /portal/production/:orderId   one order by level: Status only — stage (with "1 line ahead", "sewing not counted here"),
 *                                     health, who acts next, the holds in plain words, its urgency, its problem, the promise and
 *                                     its moves with reason codes; + Progress — the pieces per line and size of its own cells;
 *                                     + Gates & dates — its real gates, its swatch answers (approvals, not gates), and the cut,
 *                                     sewing and finish days of its own work in the PUBLISHED plan only. Another customer's order:
 *                                     404 with the words of an unknown one
 *
 * The partner read comes first (its own orders, rows, lines and requests: ./access.ts); the office's facts are read only for the
 * order ids it returned and its own party. No answer names a supervisor, an office person, a note, a place in our queue, a count
 * of other customers, a line, a lane, a load, a lot or a work order (factory-domain production-brand/portal-read).
 */

const LIVE = { events: ['brand_production.stage_reached', 'brand_production.health_changed', 'brand_production.urgency_changed', 'brand_production.hold_changed'] }

const CHIP_WORDS: Readonly<Record<ProductionChip, Words>> = Object.freeze({
  ALL: { it: 'Tutti in produzione', en: 'All in production' },
  URGENT: { it: 'Urgenti', en: 'Urgent' },
  WAITING_ON_YOU: { it: 'Tocca a voi', en: 'Waiting on you' },
  AT_RISK: { it: 'A rischio', en: 'At risk' },
  LATE: { it: 'In ritardo', en: 'Late' },
  ON_HOLD: { it: 'In sospeso', en: 'On hold' },
  READY: { it: 'Pronti per la spedizione', en: 'Ready to ship' },
})

/** B-PR-19: also the quality read's (./quality.ts). */
export const NOT_IN_PRODUCTION = 'This order is not in production.'

export interface ListQuery {
  readonly chip: ProductionChip
  readonly q?: string | undefined
  readonly locale?: ExportLocale | undefined
}

/** What a production read is from: the partner's own rows first, then the office's facts of exactly those orders. */
interface ProductionRead {
  readonly reader: PortalReader
  readonly partyId: string
  readonly today: BusinessDate
  readonly settings: ProductionSettings
  readonly orders: readonly BrandOrderRow[]
  readonly rows: ReadonlyMap<string, PartnerProductionRow>
  readonly lines: readonly PortalLine[]
  readonly requests: ReadonlyMap<string, ReadonlySet<string>>
  readonly problems: readonly ReportedProblem[]
  readonly work: ReadonlyMap<string, OrderWork>
  readonly gates: ReadonlyMap<string, readonly BrandGate[]>
  readonly planned: ReadonlyMap<string, PlannedDates>
  /** The live facts of an order the keeper has not written a row for yet (stage and who acts next). */
  readonly facts: ReadonlyMap<string, { readonly stage: OrderStage | null; readonly waiting: Waiting }>
  /** Its own orders named by a problem's answer ("Answered in SO-…"). */
  readonly names: ReadonlyMap<string, { readonly id: string; readonly number: string; readonly customerRef: string | null; readonly customerSeq: number | null }>
}

const goodsOf = (lines: readonly PortalLine[]): PortalLine[] => lines.filter((line) => (GOODS_LINE_KINDS as readonly string[]).includes(line.kind))

/** The facts of orders with no production row yet (the keeper writes it when the order is confirmed; read live meanwhile). */
async function factsOf(reader: PortalReader, request: FastifyRequest, orderIds: readonly string[], now: Date) {
  const facts = new Map<string, { stage: OrderStage | null; waiting: Waiting }>()
  if (orderIds.length === 0) return facts
  const context = keeperPlanningContext(reader.session.tenantId, String(request.id))
  await reader.inTenant(async (client) => {
    for (const orderId of orderIds) {
      const read = await readOrderProductionFacts(client, context, orderId, now, { health: false })
      if (read && read.order.partyId === reader.session.partyId) facts.set(orderId, { stage: read.stage, waiting: read.waiting })
    }
  })
  return facts
}

/** Everything a production read needs about these orders (all of them the session's party's, read in its scope first). */
async function readProduction(app: FastifyInstance, request: FastifyRequest, now: Date, scope: { readonly orderIds?: readonly string[]; readonly facts?: boolean } = {}): Promise<ProductionRead> {
  const reader = portalReader(app, request)
  const partyId = reader.session.partyId
  const partner = await request.withClient(async (client) => {
    const orders = await readProductionOrders(client, reader.session.company.id)
    const ids = orders.map((order) => order.id)
    return { orders, rows: await readProductionRows(client, ids), lines: await readLines(client, ids), requests: await readOpenRequests(client, ids) }
  })
  // The wall: every order the partner read found is the session's party's (row-level security); nothing else is read.
  const orders = partner.orders.filter((order) => order.partyId === partyId)
  const ids = orders.map((order) => order.id)
  const wanted = scope.orderIds ?? ids
  const tenant = await reader.inTenant(async (client) => {
    const settings = await readProductionSettings(client, partyId)
    const problems = await readProblems(client, partyId, wanted)
    const work = await readWork(client, partyId, partner.lines.filter((line) => wanted.includes(line.orderId)), { words: false })
    const gates = shares(settings.level, 'gates') ? await readGates(client, partyId, wanted) : new Map<string, BrandGate[]>()
    const planned = shares(settings.level, 'gates') ? await readPlanned(client, new Map(wanted.map((orderId) => [orderId, workOf(work, orderId).ownWorkOrderIds] as const))) : new Map<string, PlannedDates>()
    return { settings, problems, work, gates, planned }
  })
  const facts = scope.facts === false ? new Map<string, { stage: OrderStage | null; waiting: Waiting }>() : await factsOf(reader, request, wanted.filter((orderId) => !partner.rows.has(orderId)), now)
  const answeredIn = [...new Set(tenant.problems.flatMap((problem) => (problem.answeredInOrderId && problem.answeredInOrderId !== problem.orderId ? [problem.answeredInOrderId] : [])))]
  const names = await request.withClient((client) => readOwnOrderNames(client, answeredIn))
  return { reader, partyId, today: businessDate(now), ...tenant, orders, rows: partner.rows, lines: partner.lines, requests: partner.requests, facts, names }
}

// ---- one order's parts ------------------------------------------------------------------------------------------------------

function stageOf(read: ProductionRead, orderId: string) {
  const row = read.rows.get(orderId)
  const code: BrandStage | null = row ? row.stage : (read.facts.get(orderId)?.stage?.stage ?? null)
  if (code === null) return null
  const next = nextStageOf(code)
  return { code, words: STAGE_WORDS[code], since: row ? businessDate(row.stageAt) : null, next: next === null ? null : { code: next, words: STAGE_WORDS[next] } }
}

/** The chip the customer reads: computed, raised to At risk by a standing raise with its reason code; never the office's note. */
function healthOf(row: PartnerProductionRow | undefined, today: BusinessDate) {
  if (!row) return null
  const until = row.healthSetUntil ? dayOf(row.healthSetUntil) : null
  const raise: HealthRaise | null = row.healthSet !== null && row.healthReasonCode !== null && until !== null && today < until ? { reasonCode: row.healthReasonCode, until } : null
  const effective = effectiveHealth(row.health, raise)
  if (effective.health === null) return null
  return { code: effective.health, words: HEALTH_WORDS[effective.health], reason: effective.reasonCode ? { code: effective.reasonCode, words: HEALTH_REASON_WORDS[effective.reasonCode] } : null }
}

/** You or Us (a supplier or a workshop reads as us), since when. */
function waitingOf(read: ProductionRead, orderId: string) {
  const row = read.rows.get(orderId)
  const facts = read.facts.get(orderId)
  const on = row ? (row.waitingOn ?? 'US') : (facts?.waiting.on ?? 'US')
  const since = row ? row.waitingSince : (facts?.waiting.since ?? null)
  const side = brandSideOf(on)
  return { code: side, words: BRAND_WAITING_WORDS[side], since: since ? businessDate(since) : null }
}

function marksOf(read: ProductionRead, order: BrandOrderRow) {
  const work = workOf(read.work, order.id)
  const open = [...(read.requests.get(order.id) ?? [])]
  // An "Urgent – asked" is part of the urgency while it is on; any other open ask is a change pending.
  const changePending = open.some((kind) => kind !== 'RUSH' || !read.settings.urgencyOn)
  const partlyShipped = order.status === 'PARTLY_SHIPPED'
  const words = [...(work.onHold ? [ON_HOLD_WORDS] : []), ...(work.paused ? [PAUSED_WORDS] : []), ...(partlyShipped ? [PARTLY_SHIPPED_WORDS] : []), ...(changePending ? [CHANGE_PENDING_WORDS] : [])]
  return { onHold: work.onHold, paused: work.paused, partlyShipped, changePending, words }
}

/** The order as the urgency rules read it (its own row's urgency; Regular when it has none yet). */
function urgencyRowOf(read: ProductionRead, order: BrandOrderRow): UrgencyRow {
  const row = read.rows.get(order.id)
  return {
    orderId: order.id,
    partyId: order.partyId,
    number: order.number,
    orderDate: dayOf(order.orderDate),
    createdAt: order.createdAt,
    urgency: row?.urgency ?? 'REGULAR',
    urgentRank: row?.urgency === 'URGENT' ? row.urgentRank : null,
    setBy: row?.urgencySetBy ?? null,
    locked: row?.urgencyLocked ?? false,
    lockReason: row?.urgencyLockReason ?? null,
    open: isKeptState(order.status),
  }
}

/** Its urgency in the read (null while its switch is off: the marks are kept, not used, and not shown). */
function urgencyOf(read: ProductionRead, order: BrandOrderRow) {
  if (!read.settings.urgencyOn) return null
  const row = urgencyRowOf(read, order)
  const asked = read.requests.get(order.id)?.has('RUSH') ?? false
  const byUs = row.setBy === 'FACTORY'
  return {
    code: row.urgency,
    words: URGENCY_WORDS[row.urgency],
    urgentRank: row.urgentRank,
    asked,
    askedWords: asked ? ASK_KIND_WORDS.RUSH : null,
    byUs,
    byUsWords: byUs ? CHANGED_BY_US_WORDS : null,
    locked: row.locked,
    lockWords: row.locked ? setBackWords(row.lockReason) : null,
  }
}

/** "2 of 3 urgent used": its OWN open orders only (null while its switch is off). */
function urgentUseOf(read: ProductionRead) {
  if (!read.settings.urgencyOn) return null
  const use = usedOf(
    read.orders.map((order) => urgencyRowOf(read, order)),
    { partyId: read.partyId, max: read.settings.urgentMax },
  )
  return { ...use, words: urgentUsedWords(use) }
}

function problemOf(read: ProductionRead, orderId: string) {
  const state = problemStateOf(orderId, read.partyId, read.problems)
  if (state === null) return null
  const named = state.state === 'ANSWERED_IN' ? read.names.get(state.orderId) : undefined
  // An answer in an order it cannot read (none: a batch is one customer's) reads as plainly answered.
  const shown = state.state === 'ANSWERED_IN' && !named ? { state: 'ANSWERED' as const, on: state.on } : state
  return {
    state: shown.state,
    since: shown.state === 'WAITING_ON_US' ? shown.since : null,
    on: shown.state === 'WAITING_ON_US' ? null : shown.on,
    inOrder: named ? { id: named.id, number: named.number, customerRef: named.customerRef, yourNumber: customerNumberOf('ORDER', named.customerSeq) } : null,
    words: problemWords(shown, named?.number ?? null),
  }
}

const levelOf = (read: ProductionRead) => ({
  level: read.settings.level,
  levelWords: LEVEL_WORDS[read.settings.level],
  progressShared: progressSharedOf(read.settings.level),
  urgencyOn: read.settings.urgencyOn,
  urgentUse: urgentUseOf(read),
})

const countsOf = (whole: StageCounts): StageCounts => ({ ordered: whole.ordered, cut: whole.cut, sewn: whole.sewn, inspected: whole.inspected, packed: whole.packed })

// ---- the list ---------------------------------------------------------------------------------------------------------------

type Styles = Awaited<ReturnType<typeof namesOf>>['styles']

/** One row of My production (see the module's head). */
async function listRowOf(read: ProductionRead, styles: Styles, order: BrandOrderRow, now: Date) {
  const level: ProductionShareLevel = read.settings.level
  const lines = read.lines.filter((line) => line.orderId === order.id)
  const goods = goodsOf(lines)
  const stage = stageOf(read, order.id)
  const counts = shares(level, 'progress') && stage !== null ? countsOf((await progressFor(read.reader, order.id, lines, now)).view.whole) : null
  const milestone = nextMilestoneOf({ level, stage: stage?.code ?? null, counts, gates: read.gates.get(order.id) ?? [], planned: read.planned.get(order.id) ?? null })
  const next = milestone.next
  const promiseDate = dayOrNull(order.promiseDate)
  const originalPromiseDate = dayOrNull(order.originalPromiseDate)
  return {
    id: order.id,
    customerRef: order.customerRef,
    number: order.number,
    yourNumber: customerNumberOf('ORDER', order.customerSeq),
    orderedOn: dayOf(order.orderDate),
    styles: [...new Set(goods.map((line) => line.styleId))].flatMap((styleId) => {
      const style = styles.get(styleId)
      return style ? [{ code: style.code, name: style.name }] : []
    }),
    pieces: goods.reduce((sum, line) => sum + line.quantity, 0),
    promiseDate,
    originalPromiseDate,
    promiseMoved: originalPromiseDate !== null && promiseDate !== originalPromiseDate,
    stage,
    health: healthOf(read.rows.get(order.id), read.today),
    waiting: waitingOf(read, order.id),
    marks: marksOf(read, order),
    urgency: urgencyOf(read, order),
    next: next ? { kind: next.kind, stage: next.kind === 'STAGE' ? next.stage : null, gate: next.kind === 'GATE' ? next.gate : null, date: next.date, words: next.words } : null,
    count: milestone.count,
    problem: problemOf(read, order.id),
  }
}
type ListRow = Awaited<ReturnType<typeof listRowOf>>

function inChip(chip: ProductionChip, row: ListRow): boolean {
  switch (chip) {
    case 'ALL':
      return true
    case 'URGENT':
      return row.urgency?.code === 'URGENT'
    case 'WAITING_ON_YOU':
      return row.waiting.code === 'YOU'
    case 'AT_RISK':
      return row.health?.code === 'AT_RISK'
    case 'LATE':
      return row.health?.code === 'LATE'
    case 'ON_HOLD':
      return row.marks.onHold || row.marks.paused
    case 'READY':
      return row.stage?.code === 'READY'
  }
}

/** Every row in the customer's own order, searched, with the chips' counts and the rows of the chip asked. */
async function listRows(read: ProductionRead, query: ListQuery, now: Date): Promise<{ chips: { chip: ProductionChip; count: number; words: Words }[]; items: ListRow[] }> {
  const styles = (await read.reader.inTenant((client) => namesOf(client, [...new Set(goodsOf(read.lines).map((line) => line.styleId))], []))).styles
  const ordered = brandList(
    read.orders.map((order) => urgencyRowOf(read, order)),
    { partyId: read.partyId, urgencyOn: read.settings.urgencyOn },
  )
  const orderOf = new Map(read.orders.map((order) => [order.id, order]))
  const rows: ListRow[] = []
  // One order after the other: a progress read holds a connection of its own.
  for (const entry of ordered) {
    const order = orderOf.get(entry.orderId)
    if (order) rows.push(await listRowOf(read, styles, order, now))
  }
  const q = query.q?.trim().toLowerCase() ?? ''
  const found = (row: ListRow) => q === '' || [row.customerRef, row.number, ...row.styles.flatMap((style) => [style.code, style.name])].some((value) => value !== null && value.toLowerCase().includes(q))
  const searched = rows.filter(found)
  // While its urgency is off, no urgency chip is drawn (the marks are kept, not used).
  const chips = PRODUCTION_CHIPS.filter((chip) => chip !== 'URGENT' || read.settings.urgencyOn).map((chip) => ({ chip, count: searched.filter((row) => inChip(chip, row)).length, words: CHIP_WORDS[chip] }))
  return { chips, items: searched.filter((row) => inChip(query.chip, row)) }
}

export async function productionList(app: FastifyInstance, request: FastifyRequest, query: ListQuery, now: Date) {
  const read = await readProduction(app, request, now)
  const { chips, items } = await listRows(read, query, now)
  return { asOf: toUtcIso(now), ...levelOf(read), chip: query.chip, chips, count: items.length, items, live: LIVE }
}

// ── B-PR-20 ──
/**
 * B-PR-20 (production plan §5 Portal › Home "Home shows 5 waiting", §4 marks; PW-P07): the customer's Home counts of its OWN orders
 * in production — waiting on it, at risk, on hold (its own pause included) — the same rules as My production's chips
 * (WAITING_ON_YOU, AT_RISK, ON_HOLD), from the same read (the partner's own rows first, then the office's facts of exactly those
 * orders), so a tile and the list it opens agree. Nothing of another customer is read or counted.
 */
export async function productionCounts(app: FastifyInstance, request: FastifyRequest, now: Date): Promise<{ readonly waitingOnYou: number; readonly atRisk: number; readonly onHold: number }> {
  const read = await readProduction(app, request, now)
  let waitingOnYou = 0
  let atRisk = 0
  let onHold = 0
  for (const order of read.orders) {
    if (waitingOf(read, order.id).code === 'YOU') waitingOnYou++
    if (healthOf(read.rows.get(order.id), read.today)?.code === 'AT_RISK') atRisk++
    const marks = marksOf(read, order)
    if (marks.onHold || marks.paused) onHold++
  }
  return { waitingOnYou, atRisk, onHold }
}

/** The events after which the Home's production counts read again (the partner live channel: its own orders only). */
export const PRODUCTION_HOME_LIVE: readonly string[] = Object.freeze([...LIVE.events])
// ── end B-PR-20 ──

// ---- the list's file ("Export") ---------------------------------------------------------------------------------------------

const HEADINGS = {
  urgency: { it: 'Urgenza', en: 'Urgency' },
  customerRef: { it: 'Vostro riferimento (PO)', en: 'Your reference (PO)' },
  number: { it: 'Nostro ordine n.', en: 'Our order no.' },
  yourOrder: { it: 'Il vostro ordine n.', en: 'Your order no.' },
  orderedOn: { it: 'Inviato il', en: 'Sent on' },
  styles: { it: 'Modelli', en: 'Styles' },
  pieces: { it: 'Pezzi', en: 'Pieces' },
  stage: { it: 'Fase', en: 'Stage' },
  since: { it: 'Dal', en: 'Since' },
  next: { it: 'Prossimo passo', en: 'Next' },
  nextDate: { it: 'Data prevista del prossimo passo', en: 'Next date' },
  count: { it: 'Avanzamento', en: 'Progress' },
  promiseDate: { it: 'Data di uscita dalla fabbrica', en: 'Ex-factory date' },
  firstPromise: { it: 'Prima data promessa', en: 'First promised date' },
  health: { it: 'Stato', en: 'Health' },
  reason: { it: 'Motivo', en: 'Reason' },
  waiting: { it: 'A chi tocca', en: 'Waiting on' },
  marks: { it: 'Note', en: 'Marks' },
  problem: { it: 'Problema segnalato', en: 'Problem reported' },
} as const satisfies Record<string, Words>
const TITLE: Words = { it: 'La vostra produzione', en: 'Your production' }
const ROWS_WORDS = (count: number): Words => ({ it: `${count} ${count === 1 ? 'ordine' : 'ordini'}`, en: `${count} ${count === 1 ? 'order' : 'orders'}` })

/** GET /portal/production?format=csv: every row of the chip and search as a CSV file in the person's language. */
export async function productionCsv(app: FastifyInstance, request: FastifyRequest, query: ListQuery, now: Date): Promise<{ bytes: Uint8Array; fileName: string; contentType: string }> {
  const read = await readProduction(app, request, now)
  const { items } = await listRows(read, query, now)
  const locale: ExportLocale = query.locale ?? (read.reader.session.person.locale === 'it' ? 'it' : 'en')
  const say = (words: Words) => words[locale]
  const urgencyOn = read.settings.urgencyOn
  const headings = [
    ...(urgencyOn ? [say(HEADINGS.urgency)] : []),
    say(HEADINGS.customerRef),
    say(HEADINGS.number),
    say(HEADINGS.yourOrder),
    say(HEADINGS.orderedOn),
    say(HEADINGS.styles),
    say(HEADINGS.pieces),
    say(HEADINGS.stage),
    say(HEADINGS.since),
    say(HEADINGS.next),
    say(HEADINGS.nextDate),
    ...(shares(read.settings.level, 'progress') ? [say(HEADINGS.count)] : []),
    say(HEADINGS.promiseDate),
    say(HEADINGS.firstPromise),
    say(HEADINGS.health),
    say(HEADINGS.reason),
    say(HEADINGS.waiting),
    say(HEADINGS.marks),
    say(HEADINGS.problem),
  ]
  const day = (value: string | null): ExportCell => (value ? { day: value } : null)
  const urgencyText = (row: ListRow): string => {
    const urgency = row.urgency
    if (!urgency) return ''
    if (urgency.locked && urgency.lockWords) return say(urgency.lockWords)
    const base = urgency.code === 'URGENT' && urgency.urgentRank !== null ? `${say(urgency.words)} ${urgency.urgentRank}` : urgency.asked && urgency.askedWords ? say(urgency.askedWords) : say(urgency.words)
    return urgency.byUs && urgency.byUsWords ? `${base} · ${say(urgency.byUsWords)}` : base
  }
  const body: ExportCell[][] = items.map((row) => [
    ...(urgencyOn ? [urgencyText(row)] : []),
    row.customerRef,
    row.number,
    row.yourNumber?.seq ?? null,
    day(row.orderedOn),
    row.styles.map((style) => style.code).join(', '),
    row.pieces,
    row.stage ? say(row.stage.words) : null,
    day(row.stage?.since ?? null),
    row.next ? say(row.next.words) : null,
    day(row.next?.date ?? null),
    ...(shares(read.settings.level, 'progress') ? [row.count ? say(row.count.words) : null] : []),
    day(row.promiseDate),
    row.promiseMoved ? day(row.originalPromiseDate) : null,
    row.health ? say(row.health.words) : null,
    row.health?.reason ? say(row.health.reason.words) : null,
    say(row.waiting.words),
    row.marks.words.map(say).join(', ') || null,
    row.problem ? say(row.problem.words) : null,
  ])
  const bytes = await writeExport({ format: 'CSV', locale, title: say(TITLE), note: null, headings, rows: body, tail: say(ROWS_WORDS(body.length)) })
  return { bytes, fileName: `${say(TITLE)} ${read.today}.csv`, contentType: 'text/csv; charset=utf-8' }
}

// ---- one order --------------------------------------------------------------------------------------------------------------

/** + Progress: the pieces per line and size of its own cells (kept a minute; the counts of modules/sales/portal-orders/progress). */
async function progressSection(reader: PortalReader, orderId: string, lines: readonly PortalLine[], names: Awaited<ReturnType<typeof namesOf>>, now: Date) {
  const answer = await progressFor(reader, orderId, lines, now)
  const lineOf = new Map(lines.map((line) => [line.id, line]))
  return {
    asOf: toUtcIso(answer.computedAt),
    refreshSeconds: PROGRESS_REFRESH_SECONDS,
    stages: PROGRESS_STAGES.map((key) => ({ key, words: PROGRESS_STAGE_WORDS[key] })),
    lines: answer.view.lines.map((line) => {
      const own = lineOf.get(line.lineId)
      const style = own ? names.styles.get(own.styleId) : undefined
      const colourway = own ? names.colourways.get(own.colourwayId) : undefined
      return { ...line, sizes: [...line.sizes], style: style ? { code: style.code, name: style.name } : null, colourway: colourway ? { code: colourway.code, name: colourway.name } : null }
    }),
    whole: answer.view.whole,
    percent: answer.view.percent,
  }
}

/** + Gates & dates: its real gates, its swatch answers (approvals, not gates), its own work's days in the published plan. */
async function gatesSection(request: FastifyRequest, read: ProductionRead, orderId: string, lines: readonly PortalLine[]) {
  const answers = await request.withClient((client) => readSwatchAnswers(client, [...new Set(lines.map((line) => line.styleId))]))
  return {
    gates: [...(read.gates.get(orderId) ?? [])].sort(gateOrder).map((gate) => ({ kind: gate.kind, words: GATE_WORDS[gate.kind], state: gate.state, stateWords: GATE_STATE_WORDS[gate.state], targetDate: gate.targetDate, doneOn: gate.doneOn })),
    approvals: answers.map((answer) => ({ kind: answer.kind, words: swatchWords(answer.kind), state: answer.state, stateWords: APPROVAL_STATE_WORDS[answer.state], sentOn: answer.sentOn, answeredOn: answer.answeredOn })),
    planned: read.planned.get(orderId) ?? { cutStart: null, sewStart: null, finish: null },
  }
}

export async function productionOrder(app: FastifyInstance, request: FastifyRequest, orderId: string, now: Date) {
  const reader = portalReader(app, request)
  // The partner read first: another customer's order is as unknown as a wrong id.
  const order = await partnerOrder(request, reader, orderId)
  const own = await request.withClient(async (client) => ({ row: (await readProductionRows(client, [order.id])).get(order.id), lines: await readLines(client, [order.id]) }))
  const inProduction = isKeptState(order.status)
  // A shipped order keeps its state as history (its row); one that never was in production is not found here.
  if (!inProduction && !own.row) throw new NotFoundError(NOT_IN_PRODUCTION)
  const read = await readProduction(app, request, now, { orderIds: [order.id], facts: false })
  const tenant = await reader.inTenant(async (client) => ({
    work: await readWork(client, read.partyId, own.lines, { words: true }),
    history: await orderHistory(client, order.id),
    names: await namesOf(client, [...new Set(own.lines.map((line) => line.styleId))], [...new Set(own.lines.map((line) => line.colourwayId))]),
    facts: goodsOf(own.lines).length > 0 ? await readOrderProductionFacts(client, keeperPlanningContext(reader.session.tenantId, String(request.id)), order.id, now, { health: false }) : null,
  }))
  const facts = tenant.facts && tenant.facts.order.partyId === read.partyId ? tenant.facts : null
  const view: ProductionRead = {
    ...read,
    rows: own.row ? new Map<string, PartnerProductionRow>([...read.rows, [order.id, own.row]]) : read.rows,
    lines: own.lines,
    work: tenant.work,
    facts: facts ? new Map<string, { stage: OrderStage | null; waiting: Waiting }>([[order.id, { stage: facts.stage, waiting: facts.waiting }]]) : read.facts,
  }
  const brandOrder: BrandOrderRow = read.orders.find((entry) => entry.id === order.id) ?? { ...order, createdAt: new Date(0) }
  const level = view.settings.level
  const work = workOf(view.work, order.id)
  const stage = stageOf(view, order.id)
  // "1 line ahead" and "sewing not counted here" from the live facts, when they agree with the stage the customer reads.
  const live = facts?.stage && stage && facts.stage.stage === stage.code ? facts.stage : null
  const seqOf = new Map(own.lines.map((line) => [line.id, line.seq]))
  const promiseDate = dayOrNull(order.promiseDate)
  const originalPromiseDate = dayOrNull(order.originalPromiseDate)
  // A section the level does not share is never read, and masked last before the answer leaves.
  const sections = maskByLevel(level, {
    progress: shares(level, 'progress') ? await progressSection(reader, order.id, own.lines, tenant.names, now) : null,
    gates: shares(level, 'gates') ? await gatesSection(request, view, order.id, own.lines) : null,
  })
  return {
    asOf: toUtcIso(now),
    ...levelOf(view),
    order: {
      id: order.id,
      customerRef: order.customerRef,
      number: order.number,
      yourNumber: customerNumberOf('ORDER', order.customerSeq),
      orderedOn: dayOf(order.orderDate),
      promiseDate,
      originalPromiseDate,
      promiseMoved: originalPromiseDate !== null && promiseDate !== originalPromiseDate,
    },
    inProduction,
    stage: stage
      ? {
          ...stage,
          ahead: live?.ahead ?? 0,
          aheadWords: aheadWords(live?.ahead ?? 0),
          sewingNotCounted: live?.sewingNotCounted ?? false,
          sewingNotCountedWords: live?.sewingNotCounted ? SEWING_NOT_COUNTED_WORDS : null,
        }
      : null,
    health: healthOf(view.rows.get(order.id), view.today),
    waiting: waitingOf(view, order.id),
    marks: marksOf(view, brandOrder),
    holds: [...work.holds],
    urgency: inProduction ? urgencyOf(view, brandOrder) : null,
    problem: problemOf(view, order.id),
    promiseHistory: customerPromiseHistory(tenant.history.moves, (lineId) => seqOf.get(lineId)).map((move) => ({ ...move, lines: [...move.lines] })),
    progress: sections.progress,
    gates: sections.gates,
    live: LIVE,
  }
}
