import { isMarkedJson } from '../money/marked'
import { Dec } from '../tax/decimal'
import type { MatchStatus } from './match'

/**
 * The supplier invoices' rules (B-W2a-62; FIN-136, FIN-137; factory-db payables.prisma, whose …_money_w2a_guards hold
 * the same rules as the last word). The API says them first, in words. Pure.
 *
 *   RECEIVED → APPROVED | DISPUTED | VOIDED;  DISPUTED → RECEIVED | VOIDED;  APPROVED → PAID | RECEIVED (withdrawn)
 *   PAID and VOIDED are final; an invoice from SDI is a fiscal document: never voided (the supplier's credit note
 *   answers it), what it says never changes (only how its lines are mapped).
 */

export const INVOICE_STATUSES = ['RECEIVED', 'APPROVED', 'PAID', 'DISPUTED', 'VOIDED'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]
export const INVOICE_SOURCES = ['SDI', 'EMAIL', 'MANUAL'] as const
export type InvoiceSource = (typeof INVOICE_SOURCES)[number]
export const INVOICE_KINDS = ['INVOICE', 'CREDIT_NOTE'] as const
export type InvoiceKind = (typeof INVOICE_KINDS)[number]
export const TYPED_SOURCES = ['EMAIL', 'MANUAL'] as const

export const PAYABLES_LIMITS = Object.freeze({
  lines: 200,
  number: 20,
  description: 1000,
  note: 1000,
  reason: 500,
  paymentRef: 100,
  bulk: 50,
  /** How far back a pickup asks the intermediary for invoices it delivered (days). */
  pickupDays: 60,
})

/** The list's tiles (design finance.payables "To handle"): saved filters. */
export const TILES = ['NEW_FROM_SDI', 'DIFFERENCES', 'TO_APPROVE', 'DUE_THIS_WEEK'] as const
export type Tile = (typeof TILES)[number]

/** The states an invoice may still be matched in (its lines and match rows are written only then). */
export const OPEN_STATUSES: readonly InvoiceStatus[] = Object.freeze(['RECEIVED', 'DISPUTED'])
/** The match results an invoice may be approved with. */
export const APPROVABLE_MATCHES: readonly MatchStatus[] = Object.freeze(['MATCHED', 'DIFFERENCES', 'NO_PO'])

export const isTyped = (source: InvoiceSource): boolean => source !== 'SDI'

export interface InvoiceFacts {
  readonly number: string
  readonly status: InvoiceStatus
  readonly source: InvoiceSource
  readonly kind: InvoiceKind
  readonly matchStatus: MatchStatus
  readonly createdById: string | null
  /** The office people who mapped or matched one of its lines (preparersOf; left out: nobody). */
  readonly mappedByIds?: readonly string[]
  /** The office people who accepted one of its differences (preparersOf; left out: nobody). */
  readonly acceptedByIds?: readonly string[]
  readonly xmlFileId: string | null
  /** Differences outside the tolerance nobody accepted yet. */
  readonly unaccepted: number
  /** A typed invoice: its lines' net adds up to (minor units); null for SDI (SDI checked the file). */
  readonly linesNet: number | null
  readonly netTotal: number
  readonly lines: number
}

export type Refusal = { readonly code: string; readonly message: string }

/**
 * Why the invoice cannot be approved by this person now (empty: it can). The design: "Ready for approval once matched".
 * Four eyes (the lead's stricter rule, B-W2a-F7): whoever entered it (a typed one), mapped or matched one of its lines, or
 * accepted one of its differences does not approve it; an invoice SDI delivered has no one who entered it, but has its
 * mapping and acceptances. One refusal says it, the first that applies.
 */
export function approvalProblems(invoice: InvoiceFacts, approverId: string): Refusal[] {
  const problems: Refusal[] = []
  if (invoice.status !== 'RECEIVED') problems.push({ code: 'NOT_RECEIVED', message: `Invoice ${invoice.number} is ${invoice.status.toLowerCase()}: only a received invoice is approved.` })
  if (invoice.createdById !== null && invoice.createdById === approverId) problems.push({ code: 'OWN_INVOICE', message: 'You entered this invoice, so someone else approves it.' })
  else if (invoice.mappedByIds?.includes(approverId)) problems.push({ code: 'OWN_MAPPING', message: 'You mapped or matched its lines, so someone else approves it.' })
  else if (invoice.acceptedByIds?.includes(approverId)) problems.push({ code: 'OWN_ACCEPTANCE', message: 'You accepted one of its differences, so someone else approves it.' })
  if (invoice.lines === 0) problems.push({ code: 'NO_LINES', message: 'The invoice has no lines: add them from its PDF first.' })
  if (invoice.matchStatus === 'PENDING') problems.push({ code: 'NOT_MATCHED', message: 'Map every goods or subcontract line to its order (or mark it a service, for an invoice without PO) first.' })
  if (invoice.matchStatus === 'WAITING_GOODS') problems.push({ code: 'WAITING_GOODS', message: 'The goods invoiced have not all arrived yet: approve it once they are received (or accept each difference in words).' })
  if (invoice.unaccepted > 0 && invoice.matchStatus !== 'WAITING_GOODS') problems.push({ code: 'DIFFERENCES', message: `${invoice.unaccepted === 1 ? 'A difference' : `${invoice.unaccepted} differences`} outside the tolerance must be accepted in words, or the invoice disputed with the supplier.` })
  if (invoice.source === 'SDI' && invoice.xmlFileId === null) problems.push({ code: 'NO_XML', message: 'The XML SDI delivered is not stored yet: pick it up again before approving.' })
  if (invoice.linesNet !== null && invoice.lines > 0 && Math.abs(invoice.linesNet - invoice.netTotal) > invoice.lines) {
    problems.push({ code: 'LINES_DO_NOT_ADD_UP', message: "The lines' net does not add up to the invoice's taxable amount: correct the lines or the totals first." })
  }
  return problems
}

/** The audit actions on an invoice that prepare it for approval (payables API: invoices.ts, approval.ts). */
export const PREPARING_ACTIONS = ['payables.addLine', 'payables.changeLine', 'payables.withoutOrder', 'payables.acceptDifference'] as const

export interface PreparationFacts {
  /** Its lines and three-way match rows as stored (createdById: who wrote them; acceptedById: who accepted). */
  readonly lines: readonly { readonly createdById: string | null }[]
  readonly matches: readonly { readonly createdById: string | null; readonly acceptedById: string | null }[]
  /** Its office audit rows of PREPARING_ACTIONS (a line's mapping before and after, money-marked or plain). */
  readonly audit: readonly { readonly action: string; readonly actorId: string; readonly before: unknown; readonly after: unknown }[]
}

const plainOf = (value: unknown): Record<string, unknown> => {
  const unwrapped = isMarkedJson(value) ? value.value : value
  return unwrapped !== null && typeof unwrapped === 'object' && !Array.isArray(unwrapped) ? (unwrapped as Record<string, unknown>) : {}
}
const MAPPING_FIELDS = ['kind', 'purchaseOrderLineId', 'subcontractOrderId'] as const

/**
 * Who prepared the invoice for approval, from what is stored: a line entered with its mapping, a line's kind or order
 * changed, the lines marked services ("without order"), a match row written by a person's command (mapping it or matching
 * it again), and an accepted difference (the row's acceptedById, and the audit's acceptDifference: an acceptance a later
 * match dropped still counts). The system (the SDI pickup, the worker's match after the goods) is nobody.
 */
export function preparersOf(facts: PreparationFacts): { mappedByIds: string[]; acceptedByIds: string[] } {
  const mapped = new Set<string>()
  const accepted = new Set<string>()
  for (const line of facts.lines) if (line.createdById) mapped.add(line.createdById)
  for (const match of facts.matches) {
    if (match.createdById) mapped.add(match.createdById)
    if (match.acceptedById) accepted.add(match.acceptedById)
  }
  for (const row of facts.audit) {
    if (row.action === 'payables.acceptDifference') accepted.add(row.actorId)
    else if (row.action === 'payables.addLine' || row.action === 'payables.withoutOrder') mapped.add(row.actorId)
    else if (row.action === 'payables.changeLine') {
      const before = plainOf(row.before)
      const after = plainOf(row.after)
      if (MAPPING_FIELDS.some((field) => (before[field] ?? null) !== (after[field] ?? null))) mapped.add(row.actorId)
    }
  }
  return { mappedByIds: [...mapped].sort(), acceptedByIds: [...accepted].sort() }
}

/** What may be done to the invoice now, in words for the held actions (the record's band). */
export function actionProblems(invoice: Pick<InvoiceFacts, 'number' | 'status' | 'source'>): Record<'edit' | 'map' | 'dispute' | 'reopen' | 'withdraw' | 'pay' | 'void', string | null> {
  const open = OPEN_STATUSES.includes(invoice.status)
  const typed = isTyped(invoice.source)
  const state = invoice.status.toLowerCase()
  return {
    edit: !typed ? 'It came through SDI: what it says never changes (the supplier’s credit note corrects it).' : open ? null : `It is ${state}: a typed invoice is corrected while received or disputed.`,
    map: open ? null : `It is ${state}: its lines are mapped while it is received or disputed.`,
    dispute: invoice.status === 'RECEIVED' ? null : `It is ${state}: only a received invoice is disputed.`,
    reopen: invoice.status === 'DISPUTED' ? null : 'Only a disputed invoice is reopened.',
    withdraw: invoice.status === 'APPROVED' ? null : 'Only an approved invoice not paid yet has its approval withdrawn.',
    pay: invoice.status === 'APPROVED' ? null : `It is ${state}: an invoice is paid once approved.`,
    void: !typed ? 'It came through SDI: a fiscal document is never voided (the supplier’s credit note answers it).' : open ? null : `It is ${state}: only a received or disputed invoice is voided.`,
  }
}

/** Whether the invoice is "to approve" for the tile: received, matched, nothing left to accept. */
export const toApprove = (invoice: { status: InvoiceStatus; matchStatus: MatchStatus; unaccepted: number }): boolean =>
  invoice.status === 'RECEIVED' && APPROVABLE_MATCHES.includes(invoice.matchStatus) && invoice.unaccepted === 0

/**
 * An Italian supplier's invoice is the FatturaPA SDI delivers (DPR 633/1972 art. 21; e-invoicing between residents,
 * L. 205/2017 art. 1 c. 909): a PDF or paper copy is a courtesy copy, so it is not typed in (the SDI one would then be
 * refused as a duplicate of the same number and date). Typing is for foreign suppliers ("Add foreign invoice").
 */
export function typedSupplierProblem(country: string): string | null {
  return country.toUpperCase() === 'IT'
    ? "An Italian supplier's invoice arrives through SDI (the XML is the legal invoice; a PDF is a courtesy copy): pick it up from SDI instead of typing it."
    : null
}

// ---- mapping a line to an order -----------------------------------------------------------------------------------------

export interface MappingLine {
  readonly seq: number
  readonly itemCode: string | null
  readonly codes?: readonly string[]
}

export interface MappingRefs {
  /** DatiOrdineAcquisto: the order numbers (and line numbers) each invoice line refers to. */
  readonly orders: readonly { readonly lines: readonly number[]; readonly document: string | null; readonly item: string | null }[]
  /** DatiDDT: the supplier's delivery notes each invoice line refers to. */
  readonly ddts: readonly { readonly lines: readonly number[]; readonly number: string }[]
}

export interface OrderLineCandidate {
  readonly id: string
  readonly siteId: string
  readonly orderNumber: string
  readonly seq: number
  readonly supplierArticleCode: string | null
  readonly itemCode: string
  /** The supplier's delivery note numbers its POSTED receipts came with. */
  readonly ddtNumbers: readonly string[]
  /** Still open to invoice (not cancelled; the order sent, confirmed or received). */
  readonly open: boolean
}

export interface SubcontractCandidate {
  readonly id: string
  readonly siteId: string
  readonly number: string
}

export type Suggestion =
  | { readonly kind: 'GOODS'; readonly purchaseOrderLineId: string; readonly siteId: string; readonly how: 'ORDER_LINE' | 'ORDER_CODE' | 'ORDER_ONLY_LINE' | 'DDT_CODE' | 'DDT_ONLY_LINE' | 'CODE' }
  | { readonly kind: 'SUBCONTRACT'; readonly subcontractOrderId: string; readonly siteId: string; readonly how: 'ORDER' }

const tidy = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, '').toUpperCase()
const refersTo = (entry: { readonly lines: readonly number[] }, seq: number): boolean => entry.lines.length === 0 || entry.lines.includes(seq)

/**
 * The order line a received line most likely bills ("Supplier invoices arrive from SDI already matched"), or null: the
 * office maps it. In order: the purchase order the line names (its line number, else the article code), or the
 * subcontract order it names, else the only open line of the orders it names; the delivery notes it names (the receipts
 * with that DDT number: the article code, else their only open line); the article code among the supplier's open order
 * lines. Only one candidate is ever chosen; two equal ones (two orders named, each with one open line) leave it to a
 * person. A line that names an article never lands on an order line of another article (B-W2a-F7: an invoice naming two
 * orders without line numbers put every line on the first order's only line): it stays unmapped and the person maps it.
 */
export function suggestMapping(line: MappingLine, refs: MappingRefs, orderLines: readonly OrderLineCandidate[], subcontracts: readonly SubcontractCandidate[]): Suggestion | null {
  const codes = new Set([tidy(line.itemCode), ...(line.codes ?? []).map(tidy)].filter((code) => code !== ''))
  const matches = (candidate: OrderLineCandidate) => codes.has(tidy(candidate.supplierArticleCode)) || codes.has(tidy(candidate.itemCode))
  /** No article named, or this one: the only kind of line a suggestion may land on. */
  const fits = (candidate: OrderLineCandidate) => codes.size === 0 || matches(candidate)
  const byCode = (pool: readonly OrderLineCandidate[]) => pool.filter(matches)
  const one = <T>(pool: readonly T[]): T | null => (pool.length === 1 ? pool[0]! : null)
  const onlyOf = (pools: readonly (readonly OrderLineCandidate[])[]) => one([...new Set(pools.map((pool) => one(pool)).filter((only): only is OrderLineCandidate => only !== null && fits(only)))])
  const open = orderLines.filter((candidate) => candidate.open)

  const orders: OrderLineCandidate[][] = []
  for (const order of refs.orders.filter((entry) => refersTo(entry, line.seq) && entry.document !== null)) {
    const number = tidy(order.document)
    const subcontract = one(subcontracts.filter((candidate) => tidy(candidate.number) === number))
    if (subcontract) return { kind: 'SUBCONTRACT', subcontractOrderId: subcontract.id, siteId: subcontract.siteId, how: 'ORDER' }
    const ofOrder = open.filter((candidate) => tidy(candidate.orderNumber) === number)
    if (ofOrder.length === 0) continue
    const item = order.item !== null ? Number.parseInt(order.item, 10) : Number.NaN
    const bySeq = Number.isInteger(item) ? one(ofOrder.filter((candidate) => candidate.seq === item && fits(candidate))) : null
    if (bySeq) return { kind: 'GOODS', purchaseOrderLineId: bySeq.id, siteId: bySeq.siteId, how: 'ORDER_LINE' }
    const coded = one(byCode(ofOrder))
    if (coded) return { kind: 'GOODS', purchaseOrderLineId: coded.id, siteId: coded.siteId, how: 'ORDER_CODE' }
    orders.push(ofOrder)
  }
  const onlyOrdered = onlyOf(orders)
  if (onlyOrdered) return { kind: 'GOODS', purchaseOrderLineId: onlyOrdered.id, siteId: onlyOrdered.siteId, how: 'ORDER_ONLY_LINE' }
  const ddts: OrderLineCandidate[][] = []
  for (const ddt of refs.ddts.filter((entry) => refersTo(entry, line.seq))) {
    const number = tidy(ddt.number)
    const delivered = open.filter((candidate) => candidate.ddtNumbers.some((value) => tidy(value) === number))
    if (delivered.length === 0) continue
    const coded = one(byCode(delivered))
    if (coded) return { kind: 'GOODS', purchaseOrderLineId: coded.id, siteId: coded.siteId, how: 'DDT_CODE' }
    ddts.push(delivered)
  }
  const onlyDelivered = onlyOf(ddts)
  if (onlyDelivered) return { kind: 'GOODS', purchaseOrderLineId: onlyDelivered.id, siteId: onlyDelivered.siteId, how: 'DDT_ONLY_LINE' }
  if (codes.size > 0) {
    const coded = one(byCode(open))
    if (coded) return { kind: 'GOODS', purchaseOrderLineId: coded.id, siteId: coded.siteId, how: 'CODE' }
  }
  return null
}

/**
 * The kind a received line gets before a person looks: an accessory line (TipoCessionePrestazione AC: freight,
 * packaging) or a discount, premium or rebate (SC, PR, AB) is a CHARGE (landed cost, never matched against a receipt);
 * a line on a subcontract order is SUBCONTRACT; everything else GOODS (mapped to an order line, or marked a service).
 */
export function receivedLineKind(lineType: string | null, suggestion: Suggestion | null): 'GOODS' | 'SUBCONTRACT' | 'CHARGE' {
  if (lineType === 'AC' || lineType === 'SC' || lineType === 'PR' || lineType === 'AB') return 'CHARGE'
  return suggestion?.kind === 'SUBCONTRACT' ? 'SUBCONTRACT' : 'GOODS'
}

/** The VAT summary of typed lines: taxable per rate and nature, the VAT at the rate (half up). Minor units. */
export function vatSummaryOf(lines: readonly { readonly netAmount: number; readonly vatRatePct: string; readonly vatNature: string | null }[]): { rate: string; nature: string | null; taxable: number; vat: number }[] {
  const groups = new Map<string, { rate: string; nature: string | null; taxable: number }>()
  for (const line of lines) {
    const rate = new Dec(line.vatRatePct).toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2)
    const key = `${rate}|${line.vatNature ?? ''}`
    const group = groups.get(key) ?? { rate, nature: line.vatNature, taxable: 0 }
    group.taxable += line.netAmount
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => ({
    ...group,
    vat: Number.parseInt(new Dec(group.taxable).times(new Dec(group.rate)).dividedBy(100).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0), 10),
  }))
}
