import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { words, type SubcontractCan, type Words } from '../model'
import type { Loaded } from '../record/record-model'
import type { Ageing, AgeingRow, BalanceFlag, BalanceLine, CostEntry, CostKind, OpenBalance, OrderBalance, OrderCost, OrderTerms } from './api'

/**
 * Subcontracting in depth on screen (B-W2b-344; design purchasing.subcontracting: the record's Material balance and Cost
 * tabs, the written terms link of Operations & quantities, days out in Stock at subcontractors, the Balance open tile),
 * pure: what each part shows, the balance's and the cost's bridges, every flag and every held act in this app's words
 * from the facts the part read (never the API's English), the dialogs' drafts, what holds them and the bodies they send,
 * what a booking moves (the ActionConfirm's lines), and every refusal by the field it names. Words are keys of the
 * `purchasing-subcontracting-depth` catalogue (`DEPTH`), with nested `@key` parameters.
 */

export const DEPTH = 'purchasing-subcontracting-depth'

// ---- quantities as the API writes them ("42.6000") ----------------------------------------------------------------------

const decimal = (text: string | null | undefined): Decimal => {
  try {
    return new Dec((text ?? '').trim() === '' ? '0' : (text as string).trim())
  } catch {
    return new Dec(0)
  }
}
const q4 = (value: Decimal): string => value.toFixed(4)

/** "42.6000" → "42.6", "-0.1000" → "-0.1" (what the person reads and types). */
export const plain = (text: string): string => {
  const value = decimal(text)
  return value.isZero() ? '0' : value.toFixed(4).replace(/\.?0+$/, '')
}

/** A typed quantity → the API's plain decimal (a comma allowed; at most 4 decimals), or null. Signed: '+' / '-' allowed. */
export function typedQuantity(text: string, signed = false): string | null {
  const value = text.trim().replace(',', '.')
  if (!(signed ? /^[-+]?\d{1,14}(\.\d{1,4})?$/ : /^\d{1,14}(\.\d{1,4})?$/).test(value)) return null
  return value.replace(/^\+/, '')
}

/** A typed price → the API's plain decimal (at most 6 decimals), or null. */
export function typedPrice(text: string): string | null {
  const value = text.trim().replace(',', '.')
  return /^\d{1,12}(\.\d{1,6})?$/.test(value) ? value : null
}

/** quantity × price, rounded once (half up) to cents: what the API books (the preview's amount, minor units). */
export function amountOf(quantity: string, price: string): number {
  return decimal(quantity).times(decimal(price)).times(100).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toNumber()
}

// ---- what this person may do here --------------------------------------------------------------------------------------

export interface DepthCan {
  /** purchasing.subcontract.balance: book the workshop's declaration and adjust it (the buyer, the warehouse). */
  balance: boolean
  /** purchasing.subcontract.cost: book a workshop's charge and take one back (the buyer; with the cost grain). */
  costBook: boolean
  /** money.cost: prices, amounts and the cost bridge (never drawn as '—' without it: not drawn). */
  cost: boolean
  /** files.read: the signed terms' file. */
  files: boolean
}

export function depthCan(permissions: readonly string[], can: Pick<SubcontractCan, 'cost' | 'files'>): DepthCan {
  const held = new Set(permissions)
  return { balance: held.has('purchasing.subcontract.balance'), costBook: held.has('purchasing.subcontract.cost'), cost: can.cost, files: can.files }
}

// ---- failures in words ----------------------------------------------------------------------------------------------------

/** A failed read, as a key of the catalogue. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'unavailable') return 'problem.offline'
  if (error.kind === 'not_found') return 'problem.gone'
  return 'problem.read'
}

/** A refused write by its kind (a path the dialog knows comes first). */
export function kindProblem(error: unknown): Words {
  if (!isApiError(error)) return words('problem.write')
  switch (error.kind) {
    case 'conflict':
      return words('problem.changed')
    case 'forbidden':
    case 'step_up':
      return words('problem.forbidden')
    case 'not_found':
      return words('problem.gone')
    case 'invalid':
      return words('problem.invalid')
    case 'rate_limited':
      return words('problem.slowDown')
    case 'unavailable':
      return words('problem.offline')
    default:
      return words('problem.write')
  }
}

const pathsOf = (error: unknown): string[] => (isApiError(error) ? error.issues.map(issuePath).map((path) => path.replace(/\./g, '/')) : [])
const has = (paths: readonly string[], part: string) => paths.some((path) => path.includes(part))
/** The sentence of a refusal is read only to classify it (never drawn). */
const sentence = (error: unknown): string => (isApiError(error) ? error.message.toLowerCase() : '')
const periodLocked = (error: unknown, paths: readonly string[]) => has(paths, 'periodLock') || /period/.test(sentence(error))

// ---- the written terms (SCM-049) ---------------------------------------------------------------------------------------------

/** Why no written terms cover the order, from the revisions the workshop has (the API's `words` say only THAT). */
export type TermsGap = { kind: 'draft'; revision: number } | { kind: 'none' } | { kind: 'otherDays' }

export function termsGap(terms: Pick<OrderTerms, 'covering' | 'revisions'>): TermsGap | null {
  if (terms.covering) return null
  const draft = terms.revisions.filter((revision) => revision.status === 'DRAFT').sort((a, b) => b.revision - a.revision)[0]
  if (draft) return { kind: 'draft', revision: draft.revision }
  return terms.revisions.some((revision) => revision.status !== 'DRAFT' && revision.signedAt !== null) ? { kind: 'otherDays' } : { kind: 'none' }
}

/** Why "Download the signed terms" is held, or null. */
export function downloadHeld(terms: Pick<OrderTerms, 'covering'>, can: Pick<DepthCan, 'files'>): Words | null {
  const file = terms.covering?.file
  if (!file) return words('terms.held.noFile')
  if (!can.files) return words('held.permission', { permission: 'files.read' })
  if (file.status !== 'AVAILABLE') return words('terms.held.notReady')
  return null
}

export interface TermsModel {
  terms: Loaded<OrderTerms>
  can: DepthCan
  problem: Words | null
  timeZone: string
  slow?: boolean
}

export interface TermsActions {
  onRetry?: () => void
  onDownload?: (fileId: string) => void
}

// ---- the material balance (SCM-143, SCM-144) -----------------------------------------------------------------------------

/** A line's bridge: sent → in the garments → returned unused → scrapped → still open (the design's equation). */
export interface BalanceRung {
  key: 'sent' | 'used' | 'returned' | 'scrapped' | 'open'
  quantity: string
  /** The open rest once every piece is back: a loss until it is booked. */
  alarm?: boolean
}

export function balanceRungs(line: Pick<BalanceLine, 'sent' | 'used' | 'returned' | 'scrapped' | 'open'>, order: Pick<OrderBalance['order'], 'allBack'>): BalanceRung[] {
  return [
    { key: 'sent', quantity: line.sent },
    { key: 'used', quantity: line.used },
    { key: 'returned', quantity: line.returned },
    { key: 'scrapped', quantity: line.scrapped },
    { key: 'open', quantity: line.open, alarm: order.allBack && decimal(line.open).greaterThan(0) },
  ]
}

/** A flag of a line in this app's words, from the line's own facts. */
export function flagWords(flag: BalanceFlag, line: BalanceLine): Words {
  const uom = `@uom.${line.uom}`
  switch (flag) {
    case 'SHORT_AT_WORKSHOP':
      return words('balance.flag.SHORT_AT_WORKSHOP', { checked: plain(line.checkedByWorkshop?.quantity ?? '0'), sent: plain(line.sent), short: plain(decimal(line.short).abs().toFixed(4)), uom })
    case 'NOT_DECLARED':
      return words('balance.flag.NOT_DECLARED')
    case 'RETURN_NOT_BACK':
      return words('balance.flag.RETURN_NOT_BACK', { returned: plain(line.returned), back: plain(line.backInOurPlaces), uom })
    case 'BACK_NOT_DECLARED':
      return words('balance.flag.BACK_NOT_DECLARED', { returned: plain(line.returned), back: plain(line.backInOurPlaces), uom })
    case 'OPEN_AFTER_BACK':
      return words('balance.flag.OPEN_AFTER_BACK', { open: plain(line.open), uom })
  }
}

export const FLAG_TONE: Readonly<Record<BalanceFlag, 'warning' | 'danger' | 'info'>> = {
  SHORT_AT_WORKSHOP: 'warning',
  NOT_DECLARED: 'info',
  RETURN_NOT_BACK: 'warning',
  BACK_NOT_DECLARED: 'warning',
  OPEN_AFTER_BACK: 'danger',
}

const declared = (line: Pick<BalanceLine, 'rows'>) => line.rows.some((row) => row.kind === 'DECLARED')
const isOpen = (line: Pick<BalanceLine, 'open'>) => decimal(line.open).greaterThan(0)

/** Why "Book the workshop's declaration" is held for the order, or null (the facts, then the API's whether). */
export function declareHeld(balance: OrderBalance, can: Pick<DepthCan, 'balance'>): Words | null {
  if (!can.balance) return words('held.permission', { permission: 'purchasing.subcontract.balance' })
  if (balance.lines.length === 0) return words('balance.held.nothingSent')
  if (!balance.lines.some(isOpen)) return words('balance.held.nothingOpen')
  return balance.actions.declare === null ? null : words('balance.held.server')
}

/** Why "Book over- or under-consumption" is held for a line, or null. */
export function adjustHeld(balance: OrderBalance, line: BalanceLine, can: Pick<DepthCan, 'balance'>): Words | null {
  if (!can.balance) return words('held.permission', { permission: 'purchasing.subcontract.balance' })
  if (!declared(line)) return words('balance.held.notDeclared')
  return line.actions.adjust === null && balance.actions.adjust === null ? null : words('balance.held.server')
}

/** The workshop's declaration: per open line what it used, returned unused and scrapped (prefilled from `suggestion`). */
export interface DeclareLineDraft {
  kitLineId: string
  used: string
  returned: string
  scrapped: string
}

export interface DeclareDraft {
  receiptId: string
  lines: DeclareLineDraft[]
  note: string
}

/** A fresh declaration: every open line, prefilled with what the balance expects now; the newest receipt named. */
export function declareDraftOf(balance: OrderBalance): DeclareDraft {
  const receipt = [...balance.receipts].sort((a, b) => b.seq - a.seq)[0]
  return {
    receiptId: receipt?.id ?? '',
    lines: balance.lines.filter(isOpen).map((line) => ({ kitLineId: line.kitLineId, used: plain(line.suggestion.used), returned: plain(line.suggestion.returned), scrapped: plain(line.suggestion.scrapped) })),
    note: '',
  }
}

const lineOf = (balance: OrderBalance, kitLineId: string) => balance.lines.find((line) => line.kitLineId === kitLineId)

export function declareHeldDraft(draft: DeclareDraft, balance: OrderBalance): Words | null {
  let any = false
  for (const entry of draft.lines) {
    const line = lineOf(balance, entry.kitLineId)
    if (!line) continue
    const values = [entry.used, entry.returned, entry.scrapped].map((text) => (text.trim() === '' ? '0' : typedQuantity(text)))
    if (values.some((value) => value === null)) return words('balance.declare.held.number', { line: line.seq })
    const sum = values.reduce((total, value) => total.plus(decimal(value)), new Dec(0))
    if (sum.greaterThan(decimal(line.open))) return words('balance.declare.held.open', { line: line.seq, open: plain(line.open), uom: `@uom.${line.uom}` })
    if (sum.greaterThan(0)) any = true
  }
  if (!any) return words('balance.declare.held.nothing')
  if (draft.note.trim().length > 2000) return words('balance.held.reasonLong')
  return null
}

export function declareBody(draft: DeclareDraft, version: number) {
  const lines = draft.lines
    .map((entry) => ({ kitLineId: entry.kitLineId, used: typedQuantity(entry.used.trim() || '0') ?? '0', returned: typedQuantity(entry.returned.trim() || '0') ?? '0', scrapped: typedQuantity(entry.scrapped.trim() || '0') ?? '0' }))
    .filter((entry) => decimal(entry.used).plus(decimal(entry.returned)).plus(decimal(entry.scrapped)).greaterThan(0))
    .map((entry) => (draft.note.trim() ? { ...entry, reason: draft.note.trim() } : entry))
  return { version, ...(draft.receiptId ? { receiptId: draft.receiptId } : {}), lines }
}

/** What a declaration moves, line by line (the ActionConfirm's lines). */
export function declareMoves(draft: DeclareDraft, balance: OrderBalance, workOrder: string): Words[] {
  const out: Words[] = []
  for (const entry of declareBody(draft, 0).lines) {
    const line = lineOf(balance, entry.kitLineId)
    if (!line) continue
    out.push(...movesOf(line, { used: entry.used, returned: entry.returned, scrapped: entry.scrapped }, workOrder))
  }
  return out
}

/** The stock a row books, in words: used leaves the workshop's place to the work order, scrap is written off there. */
export function movesOf(line: Pick<BalanceLine, 'seq' | 'item' | 'uom'>, change: { used: string; returned: string; scrapped: string }, workOrder: string): Words[] {
  const out: Words[] = []
  const at = { line: line.seq, item: line.item.code, uom: `@uom.${line.uom}`, workOrder }
  const used = decimal(change.used)
  const scrapped = decimal(change.scrapped)
  const returned = decimal(change.returned)
  if (used.greaterThan(0)) out.push(words('balance.move.issue', { ...at, quantity: plain(q4(used)) }))
  if (used.lessThan(0)) out.push(words('balance.move.giveBack', { ...at, quantity: plain(q4(used.abs())) }))
  if (scrapped.greaterThan(0)) out.push(words('balance.move.scrap', { ...at, quantity: plain(q4(scrapped)) }))
  if (scrapped.lessThan(0)) out.push(words('balance.move.unscrap', { ...at, quantity: plain(q4(scrapped.abs())) }))
  if (!returned.isZero()) out.push(words('balance.move.returned', { ...at, quantity: plain(q4(returned)) }))
  return out
}

/** Over- or under-consumption after the receipt (SCM-143): signed changes and the reason. */
export interface AdjustDraft {
  kitLineId: string
  used: string
  returned: string
  scrapped: string
  reason: string
}

export const adjustDraftOf = (kitLineId: string): AdjustDraft => ({ kitLineId, used: '', returned: '', scrapped: '', reason: '' })

/** The line's sums after the change (null: a change is not a number). */
export function adjustAfter(draft: AdjustDraft, line: BalanceLine): { used: string; returned: string; scrapped: string; open: string } | null {
  const change = [draft.used, draft.returned, draft.scrapped].map((text) => (text.trim() === '' ? '0' : typedQuantity(text, true)))
  if (change.some((value) => value === null)) return null
  const [used, returned, scrapped] = change.map((value) => decimal(value))
  const after = { used: decimal(line.used).plus(used!), returned: decimal(line.returned).plus(returned!), scrapped: decimal(line.scrapped).plus(scrapped!) }
  const open = decimal(line.sent).minus(after.used).minus(after.returned).minus(after.scrapped)
  return { used: q4(after.used), returned: q4(after.returned), scrapped: q4(after.scrapped), open: q4(open) }
}

export function adjustHeldDraft(draft: AdjustDraft, line: BalanceLine): Words | null {
  const after = adjustAfter(draft, line)
  if (!after) return words('balance.adjust.held.number')
  if ([draft.used, draft.returned, draft.scrapped].every((text) => decimal(typedQuantity(text.trim() || '0', true)).isZero())) return words('balance.adjust.held.nothing')
  for (const field of ['used', 'returned', 'scrapped'] as const) {
    if (decimal(after[field]).lessThan(0)) return words('balance.adjust.held.belowZero', { what: `@balance.rung.${field}`, now: plain(line[field]), uom: `@uom.${line.uom}` })
  }
  if (decimal(after.open).lessThan(0)) return words('balance.adjust.held.moreThanSent', { sent: plain(line.sent), uom: `@uom.${line.uom}` })
  if (draft.reason.trim() === '') return words('balance.adjust.held.reason')
  if (draft.reason.trim().length > 2000) return words('balance.held.reasonLong')
  return null
}

export function adjustBody(draft: AdjustDraft, version: number) {
  const signed = (text: string) => {
    const value = typedQuantity(text.trim() || '0', true) ?? '0'
    return decimal(value).isZero() ? undefined : value
  }
  const used = signed(draft.used)
  const returned = signed(draft.returned)
  const scrapped = signed(draft.scrapped)
  return { version, kitLineId: draft.kitLineId, ...(used ? { used } : {}), ...(returned ? { returned } : {}), ...(scrapped ? { scrapped } : {}), reason: draft.reason.trim() }
}

/** A refused declaration or adjustment, by the field it names. */
export function balanceRefusal(error: unknown): Words {
  const paths = pathsOf(error)
  if (periodLocked(error, paths)) return words('balance.refused.period')
  if (has(paths, 'reportedAt')) return words('balance.refused.reportedAt')
  if (has(paths, 'receiptId')) return words('balance.refused.receipt')
  if (has(paths, 'kitLineId')) return words('balance.refused.notDeclared')
  if (has(paths, 'reason')) return words('balance.refused.reason')
  if (has(paths, 'used') || has(paths, 'returned') || has(paths, 'scrapped')) return words(/below 0/.test(sentence(error)) ? 'balance.refused.belowZero' : 'balance.refused.open')
  return kindProblem(error)
}

export type BalanceDialog = { kind: 'declare'; draft: DeclareDraft } | { kind: 'adjust'; draft: AdjustDraft }

export interface BalanceModel {
  balance: Loaded<OrderBalance>
  can: DepthCan
  /** The work order's number (the moves' destination, in words). */
  workOrder: string
  busy: boolean
  dialog: BalanceDialog | null
  problem: Words | null
  notice: { tone: 'success' | 'danger' | 'info'; words: Words } | null
  timeZone: string
  slow?: boolean
}

export interface BalanceActions {
  onRetry?: () => void
  onDialog?: (dialog: BalanceDialog | null) => void
  onDeclare?: () => void
  onAdjust?: () => void
  onDismissNotice?: () => void
}

/** The answer of a booking in words: rows and moves, and the work order's cost that followed (with the cost grain). */
export function bookedWords(answer: { rowIds: readonly string[]; moveIds: readonly string[]; ledger: { posted: number; waiting: readonly string[] } }, can: Pick<DepthCan, 'cost'>): Words {
  if (can.cost && answer.ledger.waiting.length > 0) return words('balance.bookedWaiting', { count: answer.moveIds.length })
  return words('balance.booked', { count: answer.moveIds.length })
}

// ---- the cost on the work order (SCM-146) -----------------------------------------------------------------------------------

export interface CostRung {
  key: 'earnedFee' | 'feeAtWorkshopPrice' | 'transport' | 'material' | 'other' | 'orderCost'
  amount: number
}

/** The cost bridge (the cost grain only): earned fee + fees at the workshop's price + transport + material + other = the order's cost. */
export function costRungs(cost: Pick<OrderCost, 'bridge'>): CostRung[] | null {
  const { earnedFee, feeAtWorkshopPrice, transport, material, other, orderCost } = cost.bridge
  if ([earnedFee, feeAtWorkshopPrice, transport, material, other, orderCost].some((value) => value === undefined)) return null
  const rungs: CostRung[] = [{ key: 'earnedFee', amount: earnedFee! }]
  // A kind with nothing booked stays out of the bridge (the order's cost says the whole).
  if (feeAtWorkshopPrice !== 0) rungs.push({ key: 'feeAtWorkshopPrice', amount: feeAtWorkshopPrice! })
  if (transport !== 0) rungs.push({ key: 'transport', amount: transport! })
  if (material !== 0) rungs.push({ key: 'material', amount: material! })
  if (other !== 0) rungs.push({ key: 'other', amount: other! })
  rungs.push({ key: 'orderCost', amount: orderCost! })
  return rungs
}

/** Nothing costs anything yet: no piece back good and no entry ("No cost yet — booked when goods come back"). */
export const noCostYet = (cost: Pick<OrderCost, 'operations' | 'entries'>): boolean => cost.entries.length === 0 && cost.operations.every((operation) => operation.piecesBackGood === 0)

/** The work order's ledger in words: what it holds, or why nothing posts (another currency: no exchange rates). */
export function ledgerWords(cost: OrderCost): Words | null {
  if (cost.workOrder.waiting.length > 0) return words('cost.ledger.currency', { order: cost.order.number, currency: cost.order.currency, workOrder: cost.order.workOrder.number, woCurrency: cost.order.workOrder.currency })
  return null
}

const COSTED = new Set(['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED'])

/** Why "Book a charge" is held, or null. */
export function bookHeld(cost: Pick<OrderCost, 'order' | 'actions'>, can: Pick<DepthCan, 'costBook' | 'cost'>): Words | null {
  if (!can.costBook) return words('held.permission', { permission: 'purchasing.subcontract.cost' })
  if (!can.cost) return words('held.permission', { permission: 'money.cost' })
  if (!COSTED.has(cost.order.status)) return words(cost.order.status === 'DRAFT' ? 'cost.held.draft' : 'cost.held.cancelled')
  return cost.actions.book === null ? null : words('cost.held.server')
}

/** Why "Take back" is held for an entry, or null. */
export function reverseHeld(cost: Pick<OrderCost, 'order' | 'actions'>, entry: CostEntry, can: Pick<DepthCan, 'costBook' | 'cost'>): Words | null {
  if (entry.reversalOfId) return words('cost.held.isReversal')
  if (entry.reversedById) return words('cost.held.takenBack')
  const held = bookHeld(cost, can)
  if (held) return held
  return cost.actions.reverse === null ? null : words('cost.held.server')
}

export interface BookDraft {
  kind: CostKind
  operationId: string
  quantity: string
  unitPrice: string
  receiptId: string
  reason: string
}

/** A fresh charge: transport by default (a fee needs a line with pieces to book), one of it. */
export function bookDraftOf(cost: OrderCost, kind: CostKind = 'TRANSPORT'): BookDraft {
  if (kind === 'FEE') {
    const operation = cost.operations.find((row) => row.bookable > 0)
    return { kind, operationId: operation?.id ?? '', quantity: operation ? String(operation.bookable) : '', unitPrice: operation?.pricePerPiece ? plainPrice(operation.pricePerPiece) : '', receiptId: '', reason: '' }
  }
  return { kind, operationId: '', quantity: '1', unitPrice: '', receiptId: '', reason: '' }
}

/** "7.000000" → "7.00" (two decimals at least, more only when there are). */
export const plainPrice = (text: string): string => {
  const [whole, fraction = ''] = text.split('.')
  return `${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`
}

export function bookHeldDraft(draft: BookDraft, cost: OrderCost): Words | null {
  if (draft.kind === 'FEE') {
    const operation = cost.operations.find((row) => row.id === draft.operationId)
    if (!operation) return words('cost.book.held.operation')
    if (!/^\d+$/.test(draft.quantity.trim()) || Number(draft.quantity) < 1) return words('cost.book.held.pieces')
    if (Number(draft.quantity) > operation.bookable) return words('cost.book.held.bookable', { line: operation.seq, count: operation.bookable })
  } else {
    const quantity = typedQuantity(draft.quantity)
    if (!quantity || !decimal(quantity).greaterThan(0)) return words('cost.book.held.quantity')
  }
  if (!typedPrice(draft.unitPrice)) return words('cost.book.held.price')
  if (draft.kind === 'OTHER' && draft.reason.trim() === '') return words('cost.book.held.what')
  if (draft.reason.trim().length > 2000) return words('balance.held.reasonLong')
  return null
}

export function bookBody(draft: BookDraft, version: number) {
  return {
    version,
    kind: draft.kind,
    ...(draft.kind === 'FEE' ? { subcontractOperationId: draft.operationId } : {}),
    ...(draft.receiptId ? { receiptId: draft.receiptId } : {}),
    quantity: draft.kind === 'FEE' ? draft.quantity.trim() : (typedQuantity(draft.quantity) ?? draft.quantity.trim()),
    unitPrice: typedPrice(draft.unitPrice) ?? draft.unitPrice.trim(),
    ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
  }
}

/** A refused charge or take-back, by the field it names. */
export function costRefusal(error: unknown): Words {
  const paths = pathsOf(error)
  if (has(paths, 'entryId')) return words('cost.refused.entry')
  if (has(paths, 'subcontractOperationId')) return words('cost.refused.operation')
  if (has(paths, 'quantity')) return words(/whole/.test(sentence(error)) ? 'cost.book.held.pieces' : /back good/.test(sentence(error)) ? 'cost.refused.bookable' : 'cost.book.held.quantity')
  if (has(paths, 'unitPrice')) return words('cost.book.held.price')
  if (has(paths, 'reason')) return words('cost.refused.reason')
  if (has(paths, 'occurredAt')) return words('cost.refused.occurredAt')
  if (has(paths, 'receiptId')) return words('cost.refused.receipt')
  return kindProblem(error)
}

/** What an entry is, in words: a fee for a line's pieces, a transport, material the workshop supplied, a charge. */
export function entryWords(entry: CostEntry, entries: readonly CostEntry[]): Words {
  const kind = `@cost.kind.${entry.kind}`
  if (entry.reversalOfId) {
    const of = entries.find((other) => other.id === entry.reversalOfId)
    return words('cost.entry.reversal', { kind: of ? `@cost.kind.${of.kind}` : kind })
  }
  if (entry.kind === 'FEE' && entry.operation) return words('cost.entry.fee', { line: entry.operation.seq, count: Number(plain(entry.quantity)) })
  return decimal(entry.quantity).equals(1) ? words('cost.entry.one', { kind }) : words('cost.entry.many', { kind, quantity: plain(entry.quantity) })
}

/** What booking the charge does (the ActionConfirm's lines; the view formats the money): quantity × price = amount → the work order. */
export function bookPreview(draft: BookDraft, cost: OrderCost): { quantity: string; price: string; amount: number; workOrder: string; feeLine: number | null } {
  const quantity = draft.kind === 'FEE' ? draft.quantity.trim() : (typedQuantity(draft.quantity) ?? '0')
  const price = typedPrice(draft.unitPrice) ?? '0'
  const operation = draft.kind === 'FEE' ? cost.operations.find((row) => row.id === draft.operationId) : undefined
  return { quantity: plain(/^\d/.test(quantity) ? quantity : '0'), price, amount: amountOf(/^\d/.test(quantity) ? quantity : '0', price), workOrder: cost.order.workOrder.number, feeLine: operation?.seq ?? null }
}

export type CostDialog = { kind: 'book'; draft: BookDraft } | { kind: 'reverse'; entryId: string; reason: string }

export interface CostModel {
  cost: Loaded<OrderCost>
  can: DepthCan
  /** The order's receipts (a charge may name the goods back it came with). */
  receipts: readonly { id: string; seq: number; receivedAt: string }[]
  busy: boolean
  dialog: CostDialog | null
  problem: Words | null
  notice: { tone: 'success' | 'danger' | 'info'; words: Words } | null
  timeZone: string
  slow?: boolean
}

export interface CostActions {
  onRetry?: () => void
  onDialog?: (dialog: CostDialog | null) => void
  onBook?: () => void
  onReverse?: () => void
  onDismissNotice?: () => void
}


// ---- days out at the workshops (SCM-150) ---------------------------------------------------------------------------------

/** A stock line's key: the workshop's place, the material, its colour, lot and hide (as the stock section keys its rows). */
export const ageingKey = (row: Pick<AgeingRow, 'location' | 'item' | 'colour' | 'lot' | 'hide'>): string => [row.location.id, row.item.id, row.colour?.id ?? '-', row.lot?.id ?? '-', row.hide?.id ?? '-'].join('|')

/** The days out of each stock line, by the stock section's key. */
export function daysOutBy(ageing: Pick<Ageing, 'rows'> | null): ReadonlyMap<string, Pick<AgeingRow, 'daysOut' | 'since' | 'longOut' | 'buckets'>> {
  return new Map((ageing?.rows ?? []).map((row) => [ageingKey(row), row]))
}

/** A workshop's oldest days out and its lines out longer than the long-out days. */
export function workshopAgeing(ageing: Pick<Ageing, 'workshops'> | null, locationId: string): { oldest: number | null; longOut: number } | null {
  const entry = ageing?.workshops.find((row) => row.location.id === locationId)
  return entry ? { oldest: entry.oldestDaysOut, longOut: entry.longOut } : null
}

// ---- the open balances (the "Balance open" tile and its saved view) -----------------------------------------------------

/** "6.5 m · 12 pcs": the open rest of a job per unit. */
export function openText(open: OpenBalance['open'], unit: (uom: string) => string, number: (text: string) => string): string {
  return open.map((entry) => `${number(entry.quantity)} ${unit(entry.uom)}`).join(' · ')
}

/** The saved view's rows after its search (number, workshop, work order) over what was read. */
export function balanceRowsOf(rows: readonly OpenBalance[], q: string): OpenBalance[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return [...rows]
  return rows.filter((row) => [row.order.number, row.order.workshop.code, row.order.workshop.name, row.order.workOrder.number].some((text) => text.toLowerCase().includes(needle)))
}

/** The open rest of each order (the orders grid's "Balance open" column). */
export const openByOrder = (balances: { items: readonly OpenBalance[] } | null): ReadonlyMap<string, OpenBalance> => new Map((balances?.items ?? []).map((item) => [item.order.id, item]))
