import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import {
  cancelCellsOf,
  cancelProblems,
  changeCellsOf,
  changeProblems,
  NO_WITHDRAWAL_WORDS,
  REQUEST_KINDS,
  rulesOf,
  VERDICT_CODES,
  WAITING_REQUEST_STATUSES,
  type AskedCell,
  type RequestKind,
  type RuleOrder,
} from '@nexus/factory-domain/sales/change-requests/rules'
import { cancelFeeFor } from '@nexus/factory-domain/sales/change-requests/fee'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandTools } from '../../../core/command'
// B-PR-25: the production asks from the portal and the impact before Send.
import type { Prisma } from '@nexus/factory-db'
import { isAskOpen, PRODUCTION_REQUEST_KINDS, type AskLimits, type ProductionRequestKind } from '@nexus/factory-domain/production-brand/kinds'
import type { BrandUrgency } from '@nexus/factory-domain/production-brand/urgency'
import { blockedProblems, impactKeepable, type Impact } from '@nexus/factory-domain/sales/change-requests/impact'
import {
  ASK_RULES,
  ASK_SAMPLE_KINDS,
  ASK_VERDICT_CODES,
  askedSummary,
  askLineVerdict,
  askVerdict,
  ORDER_REQUEST_KIND_WORDS,
  productionAskProblems,
  productionCellsOf,
  productionColumnsOf,
  type AskFacts as ProductionVerdictFacts,
  type AskSampleKind,
  type AskUrgency,
  type OrderRequestKind,
} from '@nexus/factory-domain/sales/change-requests/rules'
import { readWork, workOf } from '../../production/brand-portal/access'
// B-PR-26: a partly shipped order's lines shipped in full (the cancel of what is still to ship).
import type { FactoryClient } from '@nexus/factory-db'
import { shortLinesOf } from '../orders/close-lines'
import { readOrder as readOfficeOrder, readOrderFacts } from '../orders/store'
import { earliestAskOf, earliestOf, freezeOf, impactAskOf, impactFrom, impactLinesOf, readImpactFacts } from './impact'
import { feeView, impactOut } from './store'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { partnerOrder, portalReader, type PortalReader } from '../portal-orders/access'
import { readLines, type PortalLine, type PortalOrderRow } from '../portal-orders/store'
import {
  addressesOf,
  addressLabel,
  asDay,
  dayOrNull,
  LIVE_EVENTS,
  lockRequest,
  readCancelReasons,
  readCatalogue,
  readCells,
  readCuts,
  readCutoffs,
  readShipTos,
  reasonWordsOf,
  REQUEST_COLUMNS,
  requestView,
  readCounterStates,
  ruleLinesOf,
  feeLinesOf,
  askedColourwayNames, // B-PR-27a
  readOtherColourways, // B-PR-27a
  type OtherColourway, // B-PR-27a
  type AddressRow,
  type CancelReason,
  type LineCatalogue,
  type RequestRow,
} from './store'

/**
 * The customer's side (B-W2b-183; SAL-077, SAL-078; design portal.customer.orders "Ask for a change", "Ask to cancel"): a
 * portal session of the order's party, in the portal's company.
 *
 *   rules     GET  /portal/sales-orders/:orderId/change-requests/rules (portal.salesOrders.ask): what both pop-ups show
 *             BEFORE the click — per line and size what may change, per line whether it may be cancelled and why not in
 *             words ("Not possible: the leather was cut on 12 Oct", "Not possible: in production", "within 14 days of the
 *             delivery date"), the reasons, their delivery addresses, the no-withdrawal words of SAL-304, the open request
 *   ask       POST …/change-requests (portal.salesOrders.ask): the same rules again at the click, refused in words (409 with
 *             the verdict's code in the path: `body/<CODE>`, `body/cells/<i>/<CODE>`), then ONE command in the customer's
 *             own scope: the order's requests serialised (an advisory lock per order: the partner role cannot lock the
 *             order's row), one OPEN request per order, the request OPEN with its cells (the pieces before read from the
 *             order now), an audit row on the request and one on the order (its timeline shows it to the office), and
 *             `order_change_request.asked` (Home › Approvals reads it)
 *   list      GET  …/change-requests (portal.salesOrders.view): the order's requests, newest first, with the office's words
 *             (never who answered)
 *   withdraw  POST …/change-requests/:requestId/withdraw (portal.salesOrders.ask): OPEN → WITHDRAWN, at the version read
 * B-W2b-F14: the cancel fee (SalesSettings.cancelFeePct) per line and for the whole order in the rules (before the click),
 * and on a waiting cancel request; amounts are prices (dropped without the grain), nothing is charged.
 * The cut-off settings, the cuts, the reasons and the catalogue are read in the tenant's scope as the person, after the
 * partner read found the order (none of them is partner-readable). An office preview never writes (its grants hold no
 * write permission; refused here too).
 *
 * B-PR-25 (production plan §3 "Brand asks, we decide", "Money"; lead picks L4, L18; review fixes R-09, R-14, R-50; wall test
 * PW-P06): the production asks too — "Urgent – asked" (RUSH) exactly while the customer's urgency switch is on, a pause, a
 * resume, ship what is ready, another sample round while its limits list them (PortalSettings, read in the tenant's scope)
 * — with factory-domain's rules (askVerdict, productionAskProblems) before the click (the rules read: `asks`, per line
 * `split` and `samples`, the freeze of each size and of the date and address) and at it; one request that waits per order and
 * kind (a change and a cancel keep one between them, as before; a production ask never blocks them). The impact before Send
 * (POST …/change-requests/impact, the same checks as Send): what is frozen by the customer's own freeze rules, priced or not,
 * the earliest date as a date only (./impact) — and it is kept on the request at Send, as shown (never an amount: the
 * database checks it); a part asked that cannot change any more is refused at Send in words. Money only for a reader with the
 * price grain: a cancel's fee (amounts AND percent) is left out of the rules, the impact and the requests for the others (the
 * Production role), who read "A price may apply" in the impact. A production ask is withdrawn here too while it waits.
 */

/** Everything the rules need, read for one order of the customer. */
interface AskFacts {
  readonly order: PortalOrderRow
  readonly lines: PortalLine[]
  readonly rule: RuleOrder
  readonly cutoffs: Awaited<ReturnType<typeof readCutoffs>>['cutoffs']
  /** B-W2b-F14: the cancel fee in force (percent text; null: free). */
  readonly cancelFeePct: string | null
  readonly catalogue: Map<string, LineCatalogue>
  readonly reasons: CancelReason[]
  readonly addresses: AddressRow[]
  readonly openRequestId: string | null
  readonly today: BusinessDate
  /** B-PR-25: what the production asks are read against. */
  readonly production: ProductionFacts
  /** B-PR-27a: per line, the other colourways of its style a change may ask it in (with the sizes each is made in). */
  readonly colourways: ReadonlyMap<string, readonly OtherColourway[]>
}

/** B-PR-25: the facts of the production asks of one order (factory-domain sales/change-requests/rules AskFacts). */
interface ProductionFacts {
  /** What the factory opened to the customer (PortalSettings.productionUrgencyOn, productionAskKinds). */
  readonly limits: AskLimits
  /** The request of each production kind that waits (OPEN or COUNTERED) and the day it was asked. */
  readonly waiting: ReadonlyMap<string, { readonly id: string; readonly day: BusinessDate }>
  /** Everything still open of the order is ready to ship (READY; a partly shipped order whose rest reads Ready to ship). */
  readonly ready: boolean
  /** A pause it asked holds: an ACCEPTED HOLD and a BRAND hold still active on its work. */
  readonly pauseOn: boolean
  readonly urgency: AskUrgency | null
  readonly shipComplete: boolean
}

const NO_LIMITS: AskLimits = Object.freeze({ productionUrgencyOn: false, productionAskKinds: [] })

/**
 * B-PR-26 (plan §3 "A partly shipped order may still ask to cancel unshipped lines (close short)"; R-35): the lines of the order
 * that shipped in full (every piece left in a shipment), read in the tenant's scope after the partner read found the order.
 */
async function readShippedInFull(db: FactoryClient, orderId: string): Promise<Set<string>> {
  const order = await readOfficeOrder(db, orderId)
  if (!order) return new Set()
  return new Set(shortLinesOf(await readOrderFacts(db, order)).filter((line) => line.quantity > 0 && line.shipped >= line.quantity).map((line) => line.id))
}

async function askFacts(request: FastifyRequest, reader: PortalReader, orderId: string, now: Date): Promise<AskFacts> {
  const order = await partnerOrder(request, reader, orderId)
  const lines = await request.withClient((client) => readLines(client, [order.id]))
  // B-PR-23: the change or cancel that waits (OPEN, or COUNTERED for the customer's answer); a production ask never holds them.
  const open = await request.withClient((client) => client.orderChangeRequest.findFirst({ where: { orderId: order.id, kind: { in: [...REQUEST_KINDS] }, status: { in: [...WAITING_REQUEST_STATUSES] } }, select: { id: true, createdAt: true }, orderBy: { createdAt: 'desc' } }))
  const addresses = await request.withClient((client) => readShipTos(client, order.partyId))
  // B-PR-25: the production asks' own facts in the customer's scope: the one of each kind that waits, an accepted pause, the
  // order's urgency and stage (BrandOrderProduction's partner columns), whether it ships complete.
  const own = await request.withClient(async (client) => ({
    waiting: await client.orderChangeRequest.findMany({ where: { orderId: order.id, kind: { in: [...PRODUCTION_REQUEST_KINDS] }, status: { in: [...WAITING_REQUEST_STATUSES] } }, select: { id: true, kind: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    pausesAccepted: await client.orderChangeRequest.count({ where: { orderId: order.id, kind: 'HOLD', status: 'ACCEPTED' } }),
    production: await client.brandOrderProduction.findFirst({ where: { salesOrderId: order.id }, select: { stage: true, urgency: true, urgencyLocked: true, urgencyLockReason: true } }),
    shipping: await client.salesOrder.findUnique({ where: { id: order.id }, select: { shipComplete: true } }),
  }))
  const tenant = await reader.inTenant(async (client) => ({
    settings: await readCutoffs(client, reader.session.tenantId, order.companyId),
    cuts: await readCuts(client, lines.map((line) => line.id)),
    // B-PR-26: a partly shipped order's lines that shipped in full (nothing of them is left to cancel).
    shippedInFull: order.status === 'PARTLY_SHIPPED' ? await readShippedInFull(client, order.id) : new Set<string>(),
    catalogue: await readCatalogue(client, lines),
    reasons: await readCancelReasons(client),
    // B-PR-25: the customer's limits (office-only settings, its own row) and whether a pause holds its work.
    limits: await client.portalSettings.findUnique({ where: { id: order.partyId }, select: { partyId: true, productionUrgencyOn: true, productionAskKinds: true } }),
    work: await readWork(client, order.partyId, lines, { words: false }),
    // B-PR-27a: the other colourways of each line's style (the catalogue is the tenant's).
    colourways: await readOtherColourways(client, lines),
  }))
  const rule: RuleOrder = {
    status: order.status,
    promiseDate: dayOrNull(order.promiseDate),
    lines: ruleLinesOf(lines, tenant.cuts).map((line) => (tenant.shippedInFull.has(line.id) ? { ...line, shippedInFull: true } : line)),
    openRequestDay: open ? businessDate(open.createdAt) : null,
  }
  // B-PR-25
  const waiting = new Map<string, { id: string; day: BusinessDate }>()
  for (const row of own.waiting) if (!waiting.has(row.kind)) waiting.set(row.kind, { id: row.id, day: businessDate(row.createdAt) })
  const limits = tenant.limits && tenant.limits.partyId === order.partyId ? { productionUrgencyOn: tenant.limits.productionUrgencyOn, productionAskKinds: [...tenant.limits.productionAskKinds] } : NO_LIMITS
  const production: ProductionFacts = {
    limits,
    waiting,
    ready: order.status === 'READY' || (order.status === 'PARTLY_SHIPPED' && own.production?.stage === 'READY'),
    pauseOn: own.pausesAccepted > 0 && workOf(tenant.work, order.id).paused,
    urgency: own.production ? { urgency: own.production.urgency as BrandUrgency, locked: own.production.urgencyLocked, lockReason: own.production.urgencyLockReason } : null,
    shipComplete: own.shipping?.shipComplete ?? false,
  }
  return { order, lines, rule, cutoffs: tenant.settings.cutoffs, cancelFeePct: tenant.settings.cancelFeePct, catalogue: tenant.catalogue, reasons: tenant.reasons, addresses, openRequestId: open?.id ?? null, today: businessDate(now), production, colourways: tenant.colourways }
}

/** B-PR-25: a production kind's facts as the domain's rules read them. */
const verdictFactsOf = (facts: AskFacts, kind: ProductionRequestKind): ProductionVerdictFacts => ({
  order: facts.rule,
  limits: facts.production.limits,
  waitingDay: facts.production.waiting.get(kind)?.day ?? null,
  ready: facts.production.ready,
  pauseOn: facts.production.pauseOn,
  urgency: facts.production.urgency,
  shipComplete: facts.production.shipComplete,
})

const isProductionKind = (kind: string): kind is ProductionRequestKind => (PRODUCTION_REQUEST_KINDS as readonly string[]).includes(kind)

export async function portalRules(app: FastifyInstance, request: FastifyRequest, orderId: string, now: Date) {
  const reader = portalReader(app, request)
  const facts = await askFacts(request, reader, orderId, now)
  const rules = rulesOf(facts.rule, facts.cutoffs, facts.today)
  // B-PR-25: the customer's freeze rules against the stages of its own order's cells (the tenant's scope, as the person).
  const freeze = await reader.inTenant((client) => readImpactFacts(client, facts.order, facts.lines.map((line) => line.id)))
  const ruleLines = new Map(facts.rule.lines.map((line) => [line.id, line]))
  const verdicts = new Map(rules.lines.map((entry) => [entry.lineId, entry]))
  // B-W2b-F14: the fee of cancelling each line, and the whole order (the lines not closed short), before the click.
  const feeLines = feeLinesOf(facts.lines)
  const fees = new Map(cancelFeeFor(feeLines, facts.lines.map((line) => line.id), facts.cancelFeePct, facts.order.currency).lines.map((line) => [line.lineId, line.fee]))
  const whole = cancelFeeFor(feeLines, null, facts.cancelFeePct, facts.order.currency)
  return {
    asOf: toUtcIso(now),
    order: {
      id: facts.order.id,
      number: facts.order.number,
      customerRef: facts.order.customerRef,
      status: facts.order.status,
      requestedDate: dayOrNull(facts.order.requestedDate),
      promiseDate: dayOrNull(facts.order.promiseDate),
      currency: facts.order.currency,
      version: facts.order.version,
    },
    change: rules.change,
    cancel: rules.cancel,
    lines: facts.lines.map((line) => {
      const catalogue = facts.catalogue.get(line.id)
      const ordered = new Map(line.sizes.map((size) => [size.size, size.quantity]))
      // The style's range in its order (a size it no longer offers stays when ordered), then any ordered size off the range.
      const range = catalogue?.range ?? []
      const sizes = [...range, ...line.sizes.map((size) => size.size).filter((size) => !range.includes(size))]
        .filter((size) => ordered.has(size) || (catalogue?.offered.has(size) ?? false))
        .map((size) => ({ size, quantity: ordered.get(size) ?? 0, offered: ordered.has(size) || (catalogue?.offered.has(size) ?? false) }))
      const verdict = verdicts.get(line.id)!
      // B-PR-25: each size's freeze, the line's ship-first and sample-round verdicts.
      const ruleLine = ruleLines.get(line.id)!
      const sizeStage = (size: string) => freeze.stages.lines.get(line.id)?.sizes.get(size)?.stage ?? null
      return {
        lineId: line.id,
        seq: line.seq,
        kind: line.kind,
        style: catalogue?.style ?? null,
        colourway: catalogue?.colourway ?? null,
        sizes,
        change: verdict.change,
        cancel: verdict.cancel,
        cancelFee: asMoney('price', fees.get(line.id) ?? 0),
        frozen: line.sizes.map((size) => ({ size: size.size, freeze: freezeOf(freeze.rules, 'SIZE_QUANTITY', sizeStage(size.size)) })),
        split: askLineVerdict('SPLIT_SHIPMENT', ruleLine, verdictFactsOf(facts, 'SPLIT_SHIPMENT')),
        samples: ASK_SAMPLE_KINDS.map((sampleKind) => ({ sampleKind, verdict: askLineVerdict('SAMPLE_ROUND', ruleLine, verdictFactsOf(facts, 'SAMPLE_ROUND'), sampleKind) })),
        // B-PR-27a: the other colourways of its style a change may ask it in (a made-to-measure line: none).
        colourways: line.kind === 'SIZE_GRID' ? (facts.colourways.get(line.id) ?? []).map((entry) => ({ id: entry.id, code: entry.code, name: entry.name, sizes: [...entry.sizes] })) : [],
      }
    }),
    // B-PR-25: no fee at all for a reader without prices (the Production role): neither the amounts nor the percent.
    ...(reader.seesPrices ? { cancelFee: { pct: whole.pct, words: whole.words, currency: whole.currency, wholeOrderFee: asMoney('price', whole.totalFee) } } : {}),
    reasons: facts.reasons,
    addresses: facts.addresses.map((row) => ({ id: row.id, label: addressLabel(row) })),
    noWithdrawal: facts.order.noWithdrawal ? NO_WITHDRAWAL_WORDS : null,
    openRequestId: facts.openRequestId,
    // B-PR-25: the production asks the customer's limits open (a closed one is listed, not open: the screen does not draw it).
    asks: PRODUCTION_REQUEST_KINDS.map((kind) => ({ kind, words: ORDER_REQUEST_KIND_WORDS[kind], open: isAskOpen(kind, facts.production.limits), verdict: askVerdict(kind, verdictFactsOf(facts, kind)), waitingRequestId: facts.production.waiting.get(kind)?.id ?? null })),
    frozen: { deliveryDate: freezeOf(freeze.rules, 'DELIVERY_DATE', freeze.stages.order.stage), shipTo: freezeOf(freeze.rules, 'SHIP_TO', freeze.stages.order.stage) },
    live: { events: [...LIVE_EVENTS] },
  }
}

export interface AskBody {
  // B-PR-25: every kind (the production asks beside change and cancel).
  readonly kind: OrderRequestKind
  readonly cells?: readonly { readonly lineId: string; readonly size: string; readonly quantity: number }[] | undefined
  readonly requestedDate?: BusinessDate | null | undefined
  readonly shipToAddressId?: string | null | undefined
  readonly lineIds?: readonly string[] | undefined
  readonly reasonCode?: string | undefined
  readonly note?: string | null | undefined
  /** B-PR-25: a sample round's line and kind. */
  readonly lineId?: string | null | undefined
  readonly sampleKind?: AskSampleKind | null | undefined
  /** B-PR-27a: a change: lines in another colourway of their style. */
  readonly colourways?: readonly { readonly lineId: string; readonly colourwayId: string }[] | undefined
}

// B-PR-25: a production ask's refusal by the order's state names its code too (body/NOT_OPEN, body/WAITING, …).
const VERDICT_PATH = new RegExp(`/(${[...new Set([...VERDICT_CODES, ...ASK_VERDICT_CODES])].filter((code) => code !== 'FREE').join('|')})$`)

/** A refusal by the cut-off rules is a 409 (the order's state says no); anything else a 400. */
function refused(issues: Issue[]): DomainError {
  const rule = issues.find((issue) => VERDICT_PATH.test(issue.path))
  if (rule) return new DomainError('invalid_state', rule.message, issues)
  return new ValidationError(issues.length === 1 ? issues[0]!.message : 'This request cannot be sent like this.', issues)
}

const blankToNull = (value: string | null | undefined): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** The fields of the other kind are refused in words (one body for both pop-ups). */
function shapeProblems(body: AskBody): Issue[] {
  const issues: Issue[] = []
  // B-PR-25: a production ask names no lines to cancel and no address (its own fields are its rules': productionAskProblems).
  // B-PR-27a: another colourway only on a change.
  if (body.kind !== 'CHANGE' && (body.colourways ?? []).length > 0) issues.push({ path: 'body/colourways', message: 'Only a change asks another colourway.' })
  if (isProductionKind(body.kind)) {
    if (body.lineIds !== undefined) issues.push({ path: 'body/lineIds', message: 'Only a cancel names lines to cancel.' })
    if ((body.shipToAddressId ?? null) !== null) issues.push({ path: 'body/shipToAddressId', message: 'Only a change asks another delivery address.' })
    return issues
  }
  if ((body.lineId ?? null) !== null) issues.push({ path: 'body/lineId', message: 'Only a sample round names one line.' })
  if ((body.sampleKind ?? null) !== null) issues.push({ path: 'body/sampleKind', message: 'Only a sample round names the kind of sample.' })
  if (body.kind === 'CHANGE') {
    if (body.lineIds !== undefined) issues.push({ path: 'body/lineIds', message: 'A change names sizes (cells), not lines.' })
    if (body.reasonCode !== undefined) issues.push({ path: 'body/reasonCode', message: 'A change has no cancel reason.' })
  } else {
    if ((body.cells ?? []).length > 0) issues.push({ path: 'body/cells', message: 'A cancel names lines, not sizes.' })
    if ((body.requestedDate ?? null) !== null || (body.shipToAddressId ?? null) !== null) issues.push({ path: 'body', message: 'A cancel asks no date and no address.' })
    if (body.reasonCode === undefined) issues.push({ path: 'body/reasonCode', message: 'Pick a reason.' })
  }
  return issues
}

/** B-PR-25: what an ask writes: its cells and its own columns (each only on its kind; the database refuses the rest). */
interface PreparedAsk {
  readonly cells: AskedCell[]
  readonly requestedDate: BusinessDate | null
  readonly shipToAddressId: string | null
  readonly reasonCode: string | null
  readonly reason: string | null
  readonly sampleKind: AskSampleKind | null
}

/** B-PR-25: the ask checked by its kind's rules (else refused in words) and what it writes. */
function preparedAsk(body: AskBody, facts: AskFacts): PreparedAsk {
  if (isProductionKind(body.kind)) {
    const ask = { kind: body.kind, requestedDate: body.requestedDate ?? null, reasonCode: body.reasonCode ?? null, note: body.note, cells: body.cells, lineId: body.lineId ?? null, sampleKind: body.sampleKind ?? null }
    // No pause reason list is offered yet: a pause says why in its words.
    const problems = productionAskProblems(ask, { ...verdictFactsOf(facts, body.kind), today: facts.today })
    if (problems.length > 0) throw refused(problems)
    const columns = productionColumnsOf(ask)
    return { cells: productionCellsOf(ask, facts.rule), requestedDate: columns.requestedDate, shipToAddressId: null, reasonCode: columns.reasonCode, reason: columns.reason, sampleKind: columns.sampleKind }
  }
  const cells = askedCells(body as AskBody & { readonly kind: RequestKind }, facts)
  return {
    cells,
    requestedDate: body.kind === 'CHANGE' ? (body.requestedDate ?? null) : null,
    shipToAddressId: body.kind === 'CHANGE' ? (body.shipToAddressId ?? null) : null,
    reasonCode: body.kind === 'CANCEL' ? body.reasonCode! : null,
    reason: blankToNull(body.note),
    sampleKind: null,
  }
}

/**
 * B-PR-25: the impact of the ask on the customer's own order (factory-domain impactOf): the freeze rules against its cells'
 * stages and planning's date only, read in the tenant's scope as the person after the partner read found the order.
 */
async function impactOfAsk(reader: PortalReader, facts: AskFacts, kind: OrderRequestKind, prepared: PreparedAsk, now: Date, requestId: string): Promise<Impact> {
  const goods = facts.lines.filter((line) => line.kind !== 'FEE')
  const open = goods.filter((line) => line.closedShortQuantity === null).map((line) => line.id)
  const ask = impactAskOf(kind, prepared.cells, { requestedDate: prepared.requestedDate, shipToAddressId: prepared.shipToAddressId })
  const planning = earliestAskOf(kind, prepared.cells, prepared.requestedDate, open)
  return reader.inTenant(async (client) => {
    const reads = await readImpactFacts(client, facts.order, goods.map((line) => line.id))
    const earliest = planning ? await earliestOf(client, { tenantId: reader.session.tenantId, requestId, order: facts.order, lines: reads.lines, ask: planning, now }) : null
    return impactFrom(ask, impactLinesOf(goods, reads.stages), reads, facts.cancelFeePct, earliest)
  })
}

/** The cells asked, once the cut-off rules let them through (else the refusal in words). */
function askedCells(body: AskBody & { readonly kind: RequestKind }, facts: AskFacts): AskedCell[] {
  if (body.kind === 'CHANGE') {
    // B-PR-27a: and the lines asked in another colourway (checked against the other colourways of their style).
    const ask = { cells: body.cells ?? [], requestedDate: body.requestedDate ?? null, shipToAddressId: body.shipToAddressId ?? null, note: body.note, colourways: body.colourways ?? [] }
    const offered = new Map([...facts.catalogue.entries()].map(([lineId, entry]) => [lineId, entry.offered]))
    const colourways = new Map([...facts.colourways].map(([lineId, entries]) => [lineId, new Map(entries.map((entry) => [entry.id, entry.sizes]))]))
    const addressOk = ask.shipToAddressId === null ? null : facts.addresses.some((row) => row.id === ask.shipToAddressId)
    const problems = changeProblems(ask, { order: facts.rule, cutoffs: facts.cutoffs, today: facts.today, requestedDate: dayOrNull(facts.order.requestedDate), offered, addressOk, colourways })
    if (problems.length > 0) throw refused(problems)
    return changeCellsOf(ask, facts.rule)
  }
  const ask = { lineIds: body.lineIds, reasonCode: body.reasonCode!, note: body.note }
  const reasons = new Map(facts.reasons.map((reason) => [reason.code, { needsNote: reason.needsNote }]))
  const problems = cancelProblems(ask, { order: facts.rule, cutoffs: facts.cutoffs, today: facts.today, reasons })
  if (problems.length > 0) throw refused(problems)
  return cancelCellsOf(ask, facts.rule)
}

export async function askRequest(app: FastifyInstance, request: FastifyRequest, orderId: string, body: AskBody, idempotencyKey: string | undefined) {
  const reader = portalReader(app, request)
  if (reader.session.preview) throw new ForbiddenError('A preview reads only.')
  const shape = shapeProblems(body)
  if (shape.length > 0) throw refused(shape)
  const session = reader.session
  const requestId = newId()
  // The rules are read and checked inside the command's work: a repeated Idempotency-Key answers from its receipt
  // before any of it runs (the request it made would otherwise be "another one waiting").
  const { result } = await commandOn(app, request, { name: 'portal.askOrderChange', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const facts = await askFacts(request, reader, orderId, tools.now)
    // B-PR-25: the ask by its kind's rules, its impact as the customer saw it before Send; a part that cannot change any more
    // is refused in words (409, the field in the path).
    const prepared = preparedAsk(body, facts)
    const impact = await impactOfAsk(reader, facts, body.kind, prepared, tools.now, tools.context.requestId)
    const blocked = blockedProblems(impact)
    if (blocked.length > 0) throw new DomainError('invalid_state', blocked[0]!.message, blocked)
    await askInCommand(tools, { requestId, order: facts.order, body, prepared, impact, partnerUserId: session.userId })
    return { requestId }
  })
  const order = await partnerOrder(request, reader, orderId)
  return { request: await partnerRequestView(request, reader, order, result.requestId) }
}

/**
 * The request written (the customer's scope): serialised per order, one that waits at a time (B-PR-25: per kind; a change and a
 * cancel keep one between them), the order still askable for its kind.
 */
async function askInCommand(tools: CommandTools, input: { readonly requestId: string; readonly order: PortalOrderRow; readonly body: AskBody; readonly prepared: PreparedAsk; readonly impact: Impact; readonly partnerUserId: string }) {
  const { tx, now } = tools
  const { order, body, prepared } = input
  const cells = prepared.cells
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`factory.order-change-request|${order.id}`}::text))`
  // B-PR-23: one change or cancel that waits per order (OPEN, or COUNTERED); a production ask of the order never blocks it.
  // B-PR-25 (R-14): one production ask that waits per order and kind.
  const production = isProductionKind(body.kind)
  const kinds: OrderRequestKind[] = production ? [body.kind] : [...REQUEST_KINDS]
  const open = await tx.orderChangeRequest.findFirst({ where: { orderId: order.id, kind: { in: kinds }, status: { in: [...WAITING_REQUEST_STATUSES] } }, select: { id: true, createdAt: true } })
  if (open) throw new DomainError('invalid_state', production ? 'This ask waits for our answer already: withdraw it first, or wait for the answer.' : 'A request on this order waits for our answer: withdraw it first, or wait for the answer.', [{ path: production ? 'body/WAITING' : 'body/OPEN_REQUEST', message: 'A request waits.' }])
  const current = await tx.salesOrder.findUnique({ where: { id: order.id }, select: { status: true } })
  // B-PR-26: each kind's own statuses (a cancel of what is still to ship is asked of a PARTLY_SHIPPED order too).
  const statuses: readonly string[] = ASK_RULES[body.kind].statuses
  if (!current || !statuses.includes(current.status)) throw new DomainError('invalid_state', production ? 'The order can no longer take this ask from the portal.' : 'The order can no longer be changed or cancelled from the portal.', [{ path: 'body/NOT_ASKABLE', message: 'The order moved on.' }])
  // B-PR-25: the impact kept as shown (the database checks it holds no number: never an amount).
  const kept = impactKeepable(input.impact) ? (input.impact as unknown as Prisma.InputJsonObject) : undefined
  await tx.orderChangeRequest.create({
    data: {
      id: input.requestId,
      companyId: order.companyId,
      partyId: order.partyId,
      orderId: order.id,
      kind: body.kind,
      reasonCode: prepared.reasonCode,
      reason: prepared.reason,
      requestedDate: prepared.requestedDate ? asDay(prepared.requestedDate) : null,
      shipToAddressId: prepared.shipToAddressId,
      // B-PR-25
      sampleKind: prepared.sampleKind,
      ...(kept ? { impact: kept } : {}),
      createdAt: now,
      updatedAt: now,
      createdById: input.partnerUserId,
    },
    select: { id: true },
  })
  if (cells.length > 0) {
    // B-PR-27a: a cell of a line asked in another colourway names that colourway with the line's style (its reference key).
    const styleOf = new Map((await tx.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true, styleId: true } })).map((line) => [line.id, line.styleId]))
    await tx.orderChangeRequestLine.createMany({
      data: cells.map((cell) => ({
        id: newId(),
        partyId: order.partyId,
        requestId: input.requestId,
        orderLineId: cell.orderLineId,
        size: cell.size,
        quantityBefore: cell.quantityBefore,
        quantity: cell.quantity,
        ...(cell.colourwayId ? { styleId: styleOf.get(cell.orderLineId) ?? null, colourwayId: cell.colourwayId } : {}),
        createdAt: now,
        createdById: input.partnerUserId,
      })),
    })
  }
  const whole = askedSummary(body.kind, cells, { requestedDate: prepared.requestedDate, shipToAddressId: prepared.shipToAddressId }).wholeOrder
  const asked = {
    kind: body.kind,
    cells: cells.map((cell) => ({ lineId: cell.orderLineId, size: cell.size, before: cell.quantityBefore, asked: cell.quantity, ...(cell.colourwayId ? { colourwayId: cell.colourwayId } : {}) /* B-PR-27a */ })),
    wholeOrder: whole,
    requestedDate: prepared.requestedDate,
    shipToAddressId: prepared.shipToAddressId,
    reasonCode: prepared.reasonCode,
    // B-PR-25
    ...(production ? { sampleKind: prepared.sampleKind } : {}),
    impactKept: kept !== undefined,
  }
  tools.audit({ action: 'portal.askOrderChange', recordType: 'OrderChangeRequest', recordId: input.requestId, companyId: order.companyId, after: { orderId: order.id, status: 'OPEN', ...asked } })
  // The order's timeline (its Activity) shows what the customer asked.
  tools.audit({ action: 'orders.changeRequestAsked', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { requestId: input.requestId, ...asked } })
  tools.emit({ type: 'order_change_request.asked', subject: input.requestId, companyId: order.companyId, payload: { requestId: input.requestId, orderId: order.id, partyId: order.partyId, kind: body.kind, lines: new Set(cells.map((cell) => cell.orderLineId)).size, wholeOrder: whole } })
}

/**
 * B-PR-25: POST /portal/sales-orders/:orderId/change-requests/impact — the impact of an ask before Send: the same checks as
 * Send (refused the same way), nothing written. A cancel's fee only for a reader with the price grain (the amounts AND the
 * percent); every reader reads the impact's "A price may apply" when it is priced.
 */
export async function askImpact(app: FastifyInstance, request: FastifyRequest, orderId: string, body: AskBody, now: Date) {
  const reader = portalReader(app, request)
  const shape = shapeProblems(body)
  if (shape.length > 0) throw refused(shape)
  const facts = await askFacts(request, reader, orderId, now)
  const prepared = preparedAsk(body, facts)
  const impact = await impactOfAsk(reader, facts, body.kind, prepared, now, newId())
  const fee = body.kind === 'CANCEL' && reader.seesPrices ? feeView(cancelFeeFor(feeLinesOf(facts.lines), prepared.cells.map((cell) => cell.orderLineId), facts.cancelFeePct, facts.order.currency)) : null
  return {
    asOf: toUtcIso(now),
    order: { id: facts.order.id, number: facts.order.number, customerRef: facts.order.customerRef },
    impact: impactOut(impact),
    ...(fee ? { cancelFee: fee } : {}),
  }
}

/** The facts every view of the order's requests needs (the names in the tenant's scope). */
async function viewFacts(request: FastifyRequest, reader: PortalReader, order: PortalOrderRow, rows: readonly RequestRow[]) {
  const lines = await request.withClient((client) => readLines(client, [order.id]))
  const cells = await request.withClient((client) => readCells(client, rows.map((row) => row.id)))
  const addresses = await request.withClient((client) => addressesOf(client, rows.map((row) => row.shipToAddressId)))
  // B-PR-26: where each of our counter-offers stands (the customer reads its own approval requests).
  const counters = await request.withClient((client) => readCounterStates(client, rows))
  const tenant = await reader.inTenant(async (client) => ({
    catalogue: await readCatalogue(client, lines),
    reasons: await reasonWordsOf(client, rows.flatMap((row) => (row.reasonCode ? [row.reasonCode] : []))),
    // B-W2b-F14: the cancel fee in force (a waiting cancel shows it). B-PR-25: only to a reader with prices.
    cancelFeePct: reader.seesPrices && rows.some((row) => row.kind === 'CANCEL' && row.status === 'OPEN') ? (await readCutoffs(client, reader.session.tenantId, order.companyId)).cancelFeePct : null,
  }))
  const styles = new Map<string, { code: string; name: string }>()
  const colourways = new Map<string, { code: string; name: string }>()
  for (const line of lines) {
    const entry = tenant.catalogue.get(line.id)
    if (entry?.style) styles.set(line.styleId, entry.style)
    if (entry?.colourway) colourways.set(line.colourwayId, entry.colourway)
  }
  // B-PR-27a: the colourways its changes ask (of its own lines' styles), by name.
  for (const [colourwayId, name] of await reader.inTenant((client) => askedColourwayNames(client, cells.values()))) colourways.set(colourwayId, name)
  return {
    cells,
    facts: {
      orderNumber: order.number,
      customerRef: order.customerRef,
      lines: new Map(lines.map((line) => [line.id, line])),
      names: { styles, colourways },
      addresses,
      reasons: tenant.reasons,
      // B-PR-25: a reader without prices (the Production role) reads no fee at all (neither the amounts nor the percent).
      fee: reader.seesPrices ? { pct: tenant.cancelFeePct, currency: order.currency, lines: feeLinesOf(lines) } : null,
      // B-PR-26: our counter-offers, in the customer's words (its fee a price: dropped without the grain).
      counters,
      audience: 'customer' as const,
    },
  }
}

async function partnerRequestView(request: FastifyRequest, reader: PortalReader, order: PortalOrderRow, requestId: string) {
  const row = await request.withClient((client) => client.orderChangeRequest.findUnique({ where: { id: requestId }, select: REQUEST_COLUMNS }))
  if (!row || row.orderId !== order.id) throw new NotFoundError('Request not found.')
  const { cells, facts } = await viewFacts(request, reader, order, [row])
  return { ...requestView(row, cells.get(row.id) ?? [], facts), mine: row.createdById === reader.session.userId }
}

export async function partnerList(app: FastifyInstance, request: FastifyRequest, orderId: string, now: Date) {
  const reader = portalReader(app, request)
  const order = await partnerOrder(request, reader, orderId)
  const rows = await request.withClient((client) => client.orderChangeRequest.findMany({ where: { orderId: order.id }, select: REQUEST_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 }))
  const { cells, facts } = await viewFacts(request, reader, order, rows)
  return {
    asOf: toUtcIso(now),
    items: rows.map((row) => ({ ...requestView(row, cells.get(row.id) ?? [], facts), mine: row.createdById === reader.session.userId })),
    live: { events: [...LIVE_EVENTS] },
  }
}

export async function withdrawRequest(app: FastifyInstance, request: FastifyRequest, orderId: string, requestId: string, version: number, idempotencyKey: string | undefined) {
  const reader = portalReader(app, request)
  if (reader.session.preview) throw new ForbiddenError('A preview reads only.')
  const order = await partnerOrder(request, reader, orderId)
  await commandOn(app, request, { name: 'portal.withdrawOrderChange', idempotencyKey, input: { orderId, requestId, version } }, async (tools) => {
    const { tx, now } = tools
    await lockRequest(tx, requestId)
    const row = await tx.orderChangeRequest.findUnique({ where: { id: requestId }, select: REQUEST_COLUMNS })
    if (!row || row.orderId !== order.id) throw new NotFoundError('Request not found.')
    // B-PR-25: a production ask is withdrawn here too while it waits (B-PR-23 sent it to the order's thread until then).
    // B-PR-26: a countered request is answered through our counter-offer (Waiting for you): yes carries it out, no withdraws it.
    if (row.status === 'COUNTERED') throw new InvalidStateError('We sent you a counter-offer on this request: answer it in Waiting for you (no withdraws the request).')
    if (row.status !== 'OPEN') throw new InvalidStateError(row.status === 'WITHDRAWN' ? 'This request was already withdrawn.' : 'We already answered this request: it can no longer be withdrawn.')
    if (row.version !== version) throw new ConflictError(`This request changed since you read it (now version ${row.version}). Read it again.`)
    await tx.orderChangeRequest.update({ where: { id: requestId }, data: { status: 'WITHDRAWN', withdrawnAt: now, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'portal.withdrawOrderChange', recordType: 'OrderChangeRequest', recordId: requestId, companyId: order.companyId, before: { status: 'OPEN' }, after: { status: 'WITHDRAWN', withdrawnAt: toUtcIso(now) } })
    tools.audit({ action: 'orders.changeRequestWithdrawn', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { requestId, kind: row.kind } })
    tools.emit({ type: 'order_change_request.withdrawn', subject: requestId, companyId: order.companyId, payload: { requestId, orderId: order.id, partyId: order.partyId, kind: row.kind } })
    return null
  })
  return { request: await partnerRequestView(request, reader, order, requestId) }
}
