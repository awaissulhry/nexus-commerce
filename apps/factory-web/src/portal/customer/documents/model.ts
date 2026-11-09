import type { Locale } from '../../../lib/i18n/locales'
import type { ApiErrorKind, ApiIssue } from '../../../lib/api/errors'
import type { CustomerDocument, DocumentFile } from './preview/api'
import { isPreviewable, mainFileOf, orderWords } from './preview/model'
import type { CardOffer, ConformityStyle, DocRef, IntentStatus, LibraryChip, LibraryRead, OpenItemsRead, PaymentIntent, PayMethod, ReceivedState } from './api'

/**
 * SCR-186 — the customer's Documents (design portal.customer.documents; SAL-086, SAL-087, SAL-092, FIN-118, QHS-111), pure:
 * the chips of the groups the role sees and which sections a chip shows, the library's rows (kind, title, what it is for,
 * the fixed version and its fingerprint, NEW, "replaced by"), grouping by order or by style, the open items to pay with
 * their due and SDI words, why Pay waits, the payment's state as the PaymentPanel shows it, refusals in our words, the
 * conformity rows per style received, and the address's terms. Money is written only where the person has the price
 * grain (To pay); the library carries no amount. Never cost.
 */

export const NS = 'portal-documents'

/** The kinds of the library (factory-domain sales/portal-documents KIND_RULES), each with our words (`kind.<KIND>`). */
export const DOCUMENT_KINDS = [
  'DDT',
  'PACKING_LIST',
  'PROOF_OF_DELIVERY',
  'CMR',
  'DECLARATION_OF_CONFORMITY',
  'USER_INFORMATION',
  'CERTIFICATE_OF_CONFORMITY',
  'INSPECTION_REPORT',
  'TEST_REPORT',
  'CERTIFICATE',
  'DECLARATION',
  'QUALITY_REPORT',
  'INVOICE',
  'DEPOSIT_INVOICE',
  'CREDIT_NOTE',
  'STATEMENT',
  'FISCAL_DOCUMENT',
  'ORDER_CONFIRMATION',
  'QUOTE',
  'PROOF',
  'OTHER',
] as const
/** A kind's words key; a kind this page does not know yet reads as a plain document. */
export const kindKey = (kind: string): string => ((DOCUMENT_KINDS as readonly string[]).includes(kind) ? `kind.${kind}` : 'kind.OTHER')

// ── the address ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const GROUPINGS = ['newest', 'order', 'style'] as const
export type Grouping = (typeof GROUPINGS)[number]
export const isGrouping = (value: unknown): value is Grouping => typeof value === 'string' && (GROUPINGS as readonly string[]).includes(value)

export interface DocumentsAddress {
  group: LibraryChip
  q: string
  by: Grouping
  versions: 'current' | 'all'
  /** `?invoice=<id>`: an invoice's record opens here (RECORD_PAGES) — its Pay pop-up when it can be paid. */
  invoice: string | null
  /** `?tab=messages` with an invoice: its conversation. */
  messages: boolean
}

const UUID = /^[0-9a-f-]{36}$/i

export function addressOf(params: { get(name: string): string | null } | null | undefined, isChip: (value: unknown) => value is LibraryChip): DocumentsAddress {
  const group = params?.get('group') ?? null
  const by = params?.get('by') ?? null
  const invoice = params?.get('invoice') ?? null
  return {
    group: isChip(group) ? group : 'ALL',
    q: (params?.get('q') ?? '').slice(0, 80),
    by: isGrouping(by) ? by : 'newest',
    versions: params?.get('versions') === 'all' ? 'all' : 'current',
    invoice: invoice && UUID.test(invoice) ? invoice : null,
    messages: params?.get('tab') === 'messages',
  }
}

/** The address of a state of the page (defaults left out). */
export function addressQuery(address: Pick<DocumentsAddress, 'group' | 'q' | 'by' | 'versions'>): string {
  const params = new URLSearchParams()
  if (address.group !== 'ALL') params.set('group', address.group)
  if (address.q.trim()) params.set('q', address.q.trim())
  if (address.by !== 'newest') params.set('by', address.by)
  if (address.versions === 'all') params.set('versions', 'all')
  const text = params.toString()
  return text ? `?${text}` : ''
}

// ── which documents ───────────────────────────────────────────────────────────────────────────────────────────────────
export interface ChipView {
  readonly chip: LibraryChip
  readonly count: number
}

/** ALL and the groups the role sees, in the API's order (a group the role does not see never shows). */
export const chipsOf = (read: Pick<LibraryRead, 'chips'> | null): ChipView[] => (read ? read.chips.map((entry) => ({ chip: entry.chip, count: entry.count })) : [])

/** What a chip shows besides the library: To pay with Invoices & statements, conformity with Conformity, both with All. */
export function sectionsOf(group: LibraryChip, can: { toPay: boolean; conformity: boolean }): { toPay: boolean; conformity: boolean } {
  return { toPay: can.toPay && (group === 'ALL' || group === 'FINANCE'), conformity: can.conformity && (group === 'ALL' || group === 'CONFORMITY') }
}

// ── all documents ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface LibraryRow {
  readonly id: string
  readonly kind: string
  readonly group: string
  readonly title: string
  /** Their PO first, our number ("PO-77 · SO-2026-0042"), and the order's id. */
  readonly order: { readonly id: string; readonly words: string } | null
  /** The record it is of when that is not an order (a shipment, an invoice, a style). */
  readonly forLabel: string | null
  readonly forType: string | null
  readonly style: { readonly code: string; readonly name: string } | null
  readonly date: string
  readonly version: number
  readonly fingerprint: string
  readonly language: string | null
  readonly isNew: boolean
  readonly current: boolean
  readonly replacedBy: { readonly id: string | null; readonly version: number } | null
  readonly expiresOn: string | null
  readonly files: readonly DocumentFile[]
  /** A PDF (or a picture) previews in place; anything else is downloaded. */
  readonly previewable: boolean
  readonly fileName: string
  readonly sizeBytes: number | null
}

export function libraryRowOf(document: CustomerDocument, locale: Locale, opened: ReadonlySet<string>): LibraryRow {
  const file = mainFileOf(document)
  const order = document.for?.order ?? null
  const forType = document.for?.type ?? null
  return {
    id: document.id,
    kind: document.kind,
    group: document.group,
    title: document.title[locale],
    order: order ? { id: order.id, words: orderWords(order) } : null,
    // An order's own document names the order only; a shipment's, an invoice's names it beside the order.
    forLabel: forType === 'SalesOrder' ? null : (document.for?.label ?? null),
    forType,
    style: document.style ?? null,
    date: document.date,
    version: document.version,
    fingerprint: document.fingerprint,
    language: document.language,
    isNew: document.new && !opened.has(document.id),
    current: document.current,
    replacedBy: document.replacedBy ? { id: document.replacedBy.id, version: document.replacedBy.version } : null,
    expiresOn: document.expiresOn ?? null,
    files: document.files,
    previewable: file ? isPreviewable(file.contentType) : false,
    fileName: file?.name ?? document.title[locale],
    sizeBytes: file?.sizeBytes ?? null,
  }
}

/**
 * The loaded rows in the page's grouping: newest first (the API's order); by order (each order's documents together, the
 * newest order first, documents of no order last); by style (likewise). The list is loaded 50 at a time: a grouping
 * gathers what is loaded.
 */
export function groupedRows(rows: readonly LibraryRow[], by: Grouping): LibraryRow[] {
  if (by === 'newest') return [...rows]
  const keyOf = (row: LibraryRow) => (by === 'order' ? (row.order?.words ?? null) : row.style ? `${row.style.code}` : null)
  const first = new Map<string, number>()
  rows.forEach((row, index) => {
    const key = keyOf(row)
    if (key !== null && !first.has(key)) first.set(key, index)
  })
  return rows
    .map((row, index) => ({ row, index, key: keyOf(row) }))
    .sort((a, b) => {
      if (a.key === null || b.key === null) return a.key === b.key ? a.index - b.index : a.key === null ? 1 : -1
      return first.get(a.key)! - first.get(b.key)! || a.index - b.index
    })
    .map((entry) => entry.row)
}

/** At most this many documents are downloaded at once (one logged download each; a zip of several is Later, SAL-091). */
export const BULK_DOWNLOAD_MAX = 20

/** Why "Download N" waits, as a key of `portal-documents` (null: it can go). */
export function bulkDownloadHeld(count: number, held: string | null): { key: string; params?: Record<string, number> } | null {
  if (held) return { key: held }
  if (count > BULK_DOWNLOAD_MAX) return { key: 'bulk.tooMany', params: { max: BULK_DOWNLOAD_MAX } }
  return null
}

// ── to pay ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface PayRow {
  /** `invoice:<id>` or `deposit:<id>`. */
  readonly key: string
  readonly target: { readonly kind: 'invoice' | 'deposit'; readonly id: string }
  /** The invoice's number, else the deposit's order (or quote). */
  readonly number: string
  readonly docType: string | null
  readonly orderNumber: string | null
  readonly issueDate: string | null
  readonly dueDate: string
  readonly dueDateKnown: boolean
  readonly daysLate: number
  /** Minor units (price grain only; null without it). */
  readonly open: number | null
  readonly total: number | null
  readonly currency: string
  readonly sdiStatus: string | null
  readonly pdfFileId: string | null
  readonly xmlFileId: string | null
  /** The latest online payment of it. */
  readonly payment: PaymentIntent | null
  readonly canPay: boolean
}

export function payRowsOf(read: OpenItemsRead | null): PayRow[] {
  if (!read) return []
  const invoices: PayRow[] = read.invoices.map((row) => ({
    key: `invoice:${row.invoiceId}`,
    target: { kind: 'invoice', id: row.invoiceId },
    number: row.number,
    docType: row.docType,
    orderNumber: null,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    dueDateKnown: row.dueDateKnown,
    daysLate: row.daysLate,
    open: row.open ?? null,
    total: row.total ?? null,
    currency: row.currency,
    sdiStatus: row.sdiStatus,
    pdfFileId: row.pdfFileId,
    xmlFileId: row.xmlFileId,
    payment: row.payment,
    canPay: row.canPay,
  }))
  const deposits: PayRow[] = read.deposits.map((row) => ({
    key: `deposit:${row.depositRequestId}`,
    target: { kind: 'deposit', id: row.depositRequestId },
    number: row.orderNumber ?? row.quoteDocument ?? '—',
    docType: null,
    orderNumber: row.orderNumber,
    issueDate: null,
    dueDate: row.dueDate,
    dueDateKnown: true,
    daysLate: row.daysLate,
    open: row.open ?? null,
    total: row.total ?? null,
    currency: row.currency,
    sdiStatus: null,
    pdfFileId: null,
    xmlFileId: null,
    payment: row.payment,
    canPay: row.canPay,
  }))
  // The most overdue first, then by due date.
  return [...invoices, ...deposits].sort((a, b) => b.daysLate - a.daysLate || a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number))
}

/** The SDI state's tone (delivered is done; not deliverable still counts: it sits in the customer's tax drawer). */
export function sdiTone(status: string | null): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'DELIVERED':
      return 'success'
    case 'NOT_DELIVERABLE':
      return 'warning'
    case 'ERROR':
      return 'danger'
    case 'SENT':
      return 'info'
    default:
      return 'neutral'
  }
}

export const SDI_STATUSES = ['ISSUED', 'SENT', 'DELIVERED', 'NOT_DELIVERABLE', 'ERROR'] as const

/** "Overdue by 3 days" / "Due today" / "Due on 12 Nov": the due date in words (`due.*` keys). */
export function dueWords(row: Pick<PayRow, 'daysLate' | 'dueDate' | 'dueDateKnown'>, today: string): { key: string; params?: Record<string, string | number>; tone: 'danger' | 'warning' | 'neutral' } {
  if (row.daysLate > 0) return { key: 'due.overdue', params: { count: row.daysLate }, tone: 'danger' }
  if (row.dueDate.slice(0, 10) === today) return { key: 'due.today', tone: 'warning' }
  return { key: row.dueDateKnown ? 'due.on' : 'due.onIssue', params: { date: row.dueDate.slice(0, 10) }, tone: 'neutral' }
}

/** What is open, per currency (the band of To pay): "€ 2,480.00 to pay · € 1,240.00 overdue". */
export function totalsOf(read: OpenItemsRead | null): { currency: string; open: number; overdue: number }[] {
  return (read?.byCurrency ?? []).filter((row) => row.open !== undefined && row.open > 0).map((row) => ({ currency: row.currency, open: row.open!, overdue: row.overdue ?? 0 }))
}

/** A payment under way (the bank decides, or someone started it): Pay opens it where it stands. */
export const isLive = (status: IntentStatus | null | undefined): boolean => status === 'CREATED' || status === 'WAITING'

/** The facts Pay waits on. */
export interface PayFacts {
  readonly preview: boolean
  readonly offline: boolean
  readonly mayPay: boolean
  readonly card: Pick<CardOffer, 'available' | 'reason'> | null
}

/** Why Pay waits on a row, as a key of `portal-documents` (null: it may be paid). The bank transfer is always there. */
export function payHeld(row: Pick<PayRow, 'canPay' | 'currency' | 'open'>, facts: PayFacts): string | null {
  if (facts.preview) return 'held.preview'
  if (!facts.mayPay) return 'held.mayPay'
  if (facts.offline) return 'held.offline'
  if (row.open !== null && row.open <= 0) return 'held.nothingOpen'
  if (facts.card && !facts.card.available) return `unavailable.${facts.card.reason ?? 'NO_ACCOUNT'}`
  if (row.currency !== 'EUR') return 'held.currency'
  if (!row.canPay) return 'held.notPayable'
  return null
}

export const UNAVAILABLE_REASONS = ['NO_ACCOUNT', 'NOT_A_PAYMENT_ACCOUNT', 'NOT_ACTIVE', 'GATE_SPEND', 'FAKE_IN_PRODUCTION', 'FAKE_PROVIDER_LIVE'] as const

// ── the Pay pop-up ────────────────────────────────────────────────────────────────────────────────────────────────────
/** The PaymentPanel's state for a payment as it stands. */
export type PanelState = 'idle' | 'starting' | 'ready' | 'paying' | 'waiting' | 'succeeded' | 'failed'

/**
 * The panel's state once a payment is started (or taken up again): the provider holds it and waits for the payer (our
 * status WAITING from the start on), so its fields are shown; a payment already finished says so.
 */
export function panelStateAfterStart(status: IntentStatus): PanelState {
  switch (status) {
    case 'SUCCEEDED':
      return 'succeeded'
    case 'FAILED':
    case 'CANCELLED':
      return 'failed'
    default:
      return 'ready'
  }
}

/** Which FAKE answers the tester may give now: a card's first answer, the bank's confirmation, a SEPA mandate, its outcome. */
export function fakeStageOf(method: PayMethod, state: PanelState, providerState: string | null): 'CARD' | 'CARD_CONFIRM' | 'SEPA_DEBIT' | 'SEPA_WAITING' | null {
  if (state === 'ready') return method === 'CARD' ? 'CARD' : 'SEPA_DEBIT'
  if (state === 'waiting') {
    if (method === 'CARD') return providerState === 'requires_action' ? 'CARD_CONFIRM' : null
    return 'SEPA_WAITING'
  }
  return null
}

/** The provider's reason in our words (`failure.<code>`, else the default). */
export const FAILURE_CODES = [
  'card_declined',
  'insufficient_funds',
  'expired_card',
  'incorrect_cvc',
  'authentication_failed',
  'payment_intent_authentication_failure',
  'debit_not_authorized',
  'insufficient_funds_sepa',
  'provider_unavailable',
  'provider_refused',
] as const
export const failureKey = (code: string | null): string => (code && (FAILURE_CODES as readonly string[]).includes(code) ? `failure.${code}` : 'failure.default')

/** The refusals of starting a payment (409 `payment/<CODE>`), in our words. */
export const START_REFUSALS = ['NOT_OPEN', 'NO_PROVIDER', 'CURRENCY', 'NOT_PAYABLE', 'PROVIDER', 'IN_PROGRESS'] as const

export function startRefusal(error: { kind: ApiErrorKind; issues: readonly ApiIssue[] } | null): string {
  if (!error) return 'refusal.failed'
  const code = error.issues.map((issue) => (typeof issue.path === 'string' ? issue.path : '')).find((path) => path.startsWith('payment/'))?.slice('payment/'.length)
  if (code && (START_REFUSALS as readonly string[]).includes(code)) return `refusal.${code}`
  switch (error.kind) {
    case 'forbidden':
      return 'refusal.forbidden'
    case 'not_found':
      return 'refusal.gone'
    case 'unavailable':
    case 'rate_limited':
      return 'refusal.unavailable'
    default:
      return 'refusal.failed'
  }
}

/** How often the pop-up asks how the payment stands while the bank decides (ms). */
export const POLL_MS = 2500

// ── conformity per style received ─────────────────────────────────────────────────────────────────────────────────────
export interface ConformityDoc {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly version: number
  readonly fingerprint: string
  readonly language: string | null
  readonly isNew: boolean
}

export interface ReceivedRow {
  readonly key: string
  readonly shipment: string
  readonly order: string | null
  readonly orderId: string | null
  readonly shippedOn: string
  readonly revision: number | null
  readonly pieces: number
  readonly state: ReceivedState
  readonly declaration: ConformityDoc | null
  readonly userInformation: ConformityDoc | null
  readonly certificate: ConformityStyle['received'][number]['certificate']
  readonly reports: readonly ConformityDoc[]
  /** Every document of the shipment's row (Download all). */
  readonly documents: readonly ConformityDoc[]
}

export interface ConformityStyleRow {
  readonly code: string
  readonly name: string
  readonly ppe: boolean
  readonly certificateRequired: boolean
  readonly standard: string | null
  readonly ppeClass: string | null
  readonly received: readonly ReceivedRow[]
  /** Every document of the style, each once (Download all of a style). */
  readonly documents: readonly ConformityDoc[]
  /** A row misses a document. */
  readonly incomplete: boolean
}

const docOf = (ref: DocRef | null, locale: Locale, opened: ReadonlySet<string>): ConformityDoc | null =>
  ref ? { id: ref.id, kind: ref.kind, title: ref.title[locale], version: ref.version, fingerprint: ref.fingerprint, language: ref.language, isNew: ref.new && !opened.has(ref.id) } : null

export function conformityRowsOf(styles: readonly ConformityStyle[], locale: Locale, opened: ReadonlySet<string> = new Set()): ConformityStyleRow[] {
  return styles.map((style) => {
    const received = style.received.map((row): ReceivedRow => {
      const declaration = docOf(row.declaration, locale, opened)
      const userInformation = docOf(row.userInformation, locale, opened)
      const reports = row.reports.map((ref) => docOf(ref, locale, opened)!)
      return {
        key: `${row.shipment.id}:${style.style.code}`,
        shipment: row.shipment.number,
        order: row.order ? orderWords(row.order) : null,
        orderId: row.order?.id ?? null,
        shippedOn: row.shippedOn,
        revision: row.revision,
        pieces: row.pieces,
        state: row.state,
        declaration,
        userInformation,
        certificate: row.certificate,
        reports,
        documents: [declaration, userInformation, ...reports].filter((entry): entry is ConformityDoc => entry !== null),
      }
    })
    const seen = new Set<string>()
    const documents = received.flatMap((row) => row.documents).filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)))
    return {
      code: style.style.code,
      name: style.style.name,
      ppe: style.ppe,
      certificateRequired: style.certificateRequired,
      standard: style.standard,
      ppeClass: style.ppeClass,
      received,
      documents,
      incomplete: received.some((row) => row.state === 'INCOMPLETE'),
    }
  })
}

/** The received state's tone. */
export const receivedTone = (state: ReceivedState): 'success' | 'warning' | 'neutral' => (state === 'COMPLETE' ? 'success' : state === 'INCOMPLETE' ? 'warning' : 'neutral')
