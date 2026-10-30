import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { Dec, parseDecimal, ZERO, type Decimal } from '../../tax/decimal'
import type { VatTreatment } from '../../tax/vat-treatment'
import type { IssueProblem } from '../checks'
import { lineProblems, type CoreLine } from '../invoices'

/**
 * Shipped, not invoiced (B-W1-51; FIN-054, FIN-116; A1 §2.4 G), pure. "Shipped" is the garments on the lines of SHIPPED
 * or DELIVERED shipments (B-W1-46), each shipment with its live DDT (B-W1-47: one at a time; a cancelled one is
 * replaced); "invoiced" is the quantity on the GOODS lines of issued TD01 and TD24 invoices that name the same DDT, order
 * line and size (a credit note does not un-invoice goods: a return is a credit note and the goods coming back). What a
 * DRAFT invoice holds is shown apart ("in a draft") and is not invoiced yet; a new draft takes only what neither an
 * issued invoice nor another draft holds, so one DDT is never billed twice. The issue checks it again under the DDT's
 * lock (ddtInvoiceProblems): the issued invoices of a DDT never bill more than it carried.
 */

/** The goods of one (DDT, order line, size): what the shipment carried. */
export interface ShippedQuantity {
  readonly ddtId: string
  readonly salesOrderLineId: string
  readonly size: string
  /** Garments (whole pieces). */
  readonly quantity: number
}

/** A GOODS line of a TD01/TD24 that names a DDT, an order line and a size. */
export interface InvoicedQuantity {
  readonly invoiceId: string
  /** The invoice's number, or null while it is a DRAFT. */
  readonly number: string | null
  readonly draft: boolean
  readonly ddtId: string
  readonly salesOrderLineId: string
  readonly size: string
  /** Decimal(18,4) as a string. */
  readonly quantity: string
}

export const shippedKey = (ddtId: string, salesOrderLineId: string, size: string): string => `${ddtId}|${salesOrderLineId}|${size}`

export interface NotInvoicedRow {
  readonly ddtId: string
  readonly salesOrderLineId: string
  readonly size: string
  readonly shipped: Decimal
  /** On issued invoices. */
  readonly invoiced: Decimal
  /** On draft invoices. */
  readonly inDraft: Decimal
  /** Shipped less invoiced (the list's "not invoiced"). */
  readonly notInvoiced: Decimal
  /** Shipped less invoiced less in drafts: what a new draft takes. */
  readonly toInvoice: Decimal
  /** The issued invoices and the drafts that hold some of it. */
  readonly invoices: readonly { readonly invoiceId: string; readonly number: string | null; readonly draft: boolean }[]
}

const nonNegative = (value: Decimal): Decimal => (value.isNegative() ? ZERO : value)

/** Per (DDT, order line, size): shipped, invoiced, in drafts, and what is left. */
export function notInvoiced(shipped: readonly ShippedQuantity[], invoiced: readonly InvoicedQuantity[]): NotInvoicedRow[] {
  const rows = new Map<string, { ddtId: string; salesOrderLineId: string; size: string; shipped: Decimal; invoiced: Decimal; inDraft: Decimal; invoices: Map<string, { invoiceId: string; number: string | null; draft: boolean }> }>()
  for (const line of shipped) {
    const key = shippedKey(line.ddtId, line.salesOrderLineId, line.size)
    const row = rows.get(key) ?? { ddtId: line.ddtId, salesOrderLineId: line.salesOrderLineId, size: line.size, shipped: ZERO, invoiced: ZERO, inDraft: ZERO, invoices: new Map() }
    row.shipped = row.shipped.plus(line.quantity)
    rows.set(key, row)
  }
  for (const line of invoiced) {
    const row = rows.get(shippedKey(line.ddtId, line.salesOrderLineId, line.size))
    if (!row) continue
    const quantity = parseDecimal(line.quantity) ?? ZERO
    if (line.draft) row.inDraft = row.inDraft.plus(quantity)
    else row.invoiced = row.invoiced.plus(quantity)
    row.invoices.set(line.invoiceId, { invoiceId: line.invoiceId, number: line.number, draft: line.draft })
  }
  return [...rows.values()].map((row) => ({
    ddtId: row.ddtId,
    salesOrderLineId: row.salesOrderLineId,
    size: row.size,
    shipped: row.shipped,
    invoiced: row.invoiced,
    inDraft: row.inDraft,
    notInvoiced: nonNegative(row.shipped.minus(row.invoiced)),
    toInvoice: nonNegative(row.shipped.minus(row.invoiced).minus(row.inDraft)),
    invoices: [...row.invoices.values()],
  }))
}

// ---- part of a shipment (B-W2a-54; FIN-058) -------------------------------------------------------------------------

/** A part the office asks to invoice now: so many garments of a DDT's order line and size. */
export interface AskedPart {
  readonly ddtId: string
  readonly salesOrderLineId: string
  readonly size: string
  /** Whole garments, above 0. */
  readonly quantity: number
}

/**
 * Partial invoicing per shipment (FIN-058): of what is left to invoice (`rows`, notInvoiced), only the parts asked, each
 * at most what is left of it (neither issued invoices nor other drafts hold it). The rest stays shipped, not invoiced,
 * with its deadline. Problems (paths `body/lines/<i>`): a part the DDTs did not carry, asked twice, or above what is left.
 */
export function pickPart(rows: readonly NotInvoicedRow[], asked: readonly AskedPart[], ddtNumbers: ReadonlyMap<string, string>): { readonly rows: NotInvoicedRow[]; readonly problems: Issue[] } {
  const problems: Issue[] = []
  const byKey = new Map(rows.map((row) => [shippedKey(row.ddtId, row.salesOrderLineId, row.size), row]))
  const seen = new Set<string>()
  const picked: NotInvoicedRow[] = []
  asked.forEach((part, index) => {
    const at = `body/lines/${index}`
    const key = shippedKey(part.ddtId, part.salesOrderLineId, part.size)
    const label = `DDT ${ddtNumbers.get(part.ddtId) ?? '?'} size ${part.size}`
    const row = byKey.get(key)
    if (!Number.isInteger(part.quantity) || part.quantity <= 0) problems.push({ path: `${at}/quantity`, message: 'Whole garments, 1 or more.' })
    else if (seen.has(key)) problems.push({ path: at, message: `${label} of this order line is asked twice: ask it once, with the garments to invoice.` })
    else if (!row) problems.push({ path: at, message: `${label}: the DDTs chosen did not carry this order line and size.` })
    else if (row.toInvoice.lt(part.quantity)) {
      problems.push({ path: `${at}/quantity`, message: `${label}: ${row.toInvoice.toString()} left to invoice (shipped ${row.shipped.toString()}, invoiced ${row.invoiced.toString()}, in drafts ${row.inDraft.toString()}); asked ${part.quantity}.` })
    } else picked.push({ ...row, toInvoice: new Dec(part.quantity) })
    seen.add(key)
  })
  return { rows: picked, problems }
}

// ---- the goods lines of a draft from DDTs --------------------------------------------------------------------------

/** An order line's price as the order holds it (net, Decimal(18,6)), and the size's own price when it has one. */
export interface OrderLinePrice {
  readonly salesOrderLineId: string
  readonly orderId: string
  readonly orderNumber: string
  /** What the line says (the style and colourway), for the invoice's Descrizione. */
  readonly description: string
  /** The style and colourway codes, for CodiceArticolo with the size. */
  readonly itemCode: string | null
  readonly unitPrice: string
  readonly sizePrices: Readonly<Record<string, string | null>>
  /** The order line's VAT rate when it is taxed ("22.00"), else null (zero-rated as accepted). */
  readonly vatRatePct: string | null
}

export interface DraftSource {
  readonly ddtId: string
  readonly ddtNumber: string
  readonly ddtDate: BusinessDate
  readonly salesOrderLineId: string
  readonly size: string
  readonly quantity: Decimal
}

/** A goods line of the draft, with what it bills. */
export interface DraftGoodsLine {
  readonly core: CoreLine
  readonly salesOrderLineId: string
  readonly size: string
  readonly ddtId: string
}

/**
 * The GOODS lines of an invoice of shipped goods: one per (DDT, order line, size), in DDT then order then size order,
 * priced from the order (the size's own price, else the line's; net), taxed as `vatOf` decides for the buyer today
 * (FIN-098: the VAT rules on the order line's rate). Problems: a line without a price on its order.
 */
export function draftGoodsLines(sources: readonly DraftSource[], prices: ReadonlyMap<string, OrderLinePrice>, vatOf: (line: OrderLinePrice) => VatTreatment | Issue): { readonly lines: DraftGoodsLine[]; readonly problems: Issue[] } {
  const problems: Issue[] = []
  const sorted = [...sources].sort((a, b) => {
    const pa = prices.get(a.salesOrderLineId)
    const pb = prices.get(b.salesOrderLineId)
    return (
      a.ddtDate.localeCompare(b.ddtDate) ||
      a.ddtNumber.localeCompare(b.ddtNumber, undefined, { numeric: true }) ||
      (pa?.orderNumber ?? '').localeCompare(pb?.orderNumber ?? '') ||
      (pa?.description ?? '').localeCompare(pb?.description ?? '') ||
      a.size.localeCompare(b.size, undefined, { numeric: true })
    )
  })
  const lines: DraftGoodsLine[] = []
  for (const source of sorted) {
    if (source.quantity.lte(ZERO)) continue
    const price = prices.get(source.salesOrderLineId)
    if (!price) {
      problems.push({ path: 'ddtIds', message: `An order line shipped with DDT ${source.ddtNumber} is not found: it cannot be priced.` })
      continue
    }
    const vat = vatOf(price)
    if ('path' in vat) {
      problems.push(vat)
      continue
    }
    const unitPrice = price.sizePrices[source.size] ?? price.unitPrice
    const description = `${price.description}, taglia ${source.size}`.slice(0, 1000)
    const itemCode = price.itemCode ? `${price.itemCode}-${source.size}`.slice(0, 35) : null
    const core: CoreLine = { kind: 'GOODS', description, itemCode, quantity: source.quantity.toFixed(4), uom: 'PZ', unitPrice: new Dec(unitPrice).toFixed(6), discountPct: null, vat }
    const issues = lineProblems(core, `lines/${lines.length}`)
    if (issues.length > 0) problems.push(...issues)
    else lines.push({ core, salesOrderLineId: source.salesOrderLineId, size: source.size, ddtId: source.ddtId })
  }
  return { lines, problems }
}

// ---- the issue's check of the DDTs an invoice bills ----------------------------------------------------------------

/** What the issue knows of a DDT an invoice line names. */
export interface DdtFacts {
  readonly id: string
  readonly number: string
  readonly cancelled: boolean
  /** The shipment's status: SHIPPED or DELIVERED are shipped goods. */
  readonly shipmentStatus: string
}

/** A line of the invoice being issued. */
export interface BilledLine {
  readonly seq: number
  readonly kind: string
  readonly ddtId: string | null
  readonly salesOrderLineId: string | null
  readonly size: string | null
  readonly quantity: string
}

const SHIPPED_STATES = new Set(['SHIPPED', 'DELIVERED'])
export const isShippedState = (status: string): boolean => SHIPPED_STATES.has(status)

/**
 * The problems of an invoice's DDT lines at issue (TD01/TD24; paths `lines/<i>`): a DDT cancelled or whose goods have not
 * left, and goods billed beyond what the DDT carried less what OTHER issued invoices bill (`others`: issued invoices
 * only, never this one). Lines without a DDT, order line and size are not counted here (the generic draft's free lines).
 */
export function ddtInvoiceProblems(lines: readonly BilledLine[], ddts: ReadonlyMap<string, DdtFacts>, shipped: readonly ShippedQuantity[], others: readonly InvoicedQuantity[]): IssueProblem[] {
  const problems: IssueProblem[] = []
  const add = (code: string, path: string, message: string) => problems.push({ code, path, message })
  const reported = new Set<string>()
  lines.forEach((line, index) => {
    if (!line.ddtId) return
    const ddt = ddts.get(line.ddtId)
    if (!ddt || reported.has(line.ddtId)) return
    if (ddt.cancelled) {
      reported.add(line.ddtId)
      add('DDT_CANCELLED', `lines/${index}/ddtId`, `DDT ${ddt.number} was cancelled: bill the goods with the DDT that replaced it (make the draft again from its DDTs).`)
    } else if (!isShippedState(ddt.shipmentStatus)) {
      reported.add(line.ddtId)
      add('DDT_NOT_SHIPPED', `lines/${index}/ddtId`, `The goods of DDT ${ddt.number} have not left yet (the shipment is ${ddt.shipmentStatus}): invoice them once they are shipped.`)
    }
  })
  const rows = new Map(notInvoiced(shipped, others).map((row) => [shippedKey(row.ddtId, row.salesOrderLineId, row.size), row]))
  const billed = new Map<string, { index: number; quantity: Decimal }>()
  lines.forEach((line, index) => {
    if (line.kind !== 'GOODS' || !line.ddtId || !line.salesOrderLineId || !line.size) return
    const key = shippedKey(line.ddtId, line.salesOrderLineId, line.size)
    const entry = billed.get(key) ?? { index, quantity: ZERO }
    entry.quantity = entry.quantity.plus(parseDecimal(line.quantity) ?? ZERO)
    billed.set(key, entry)
  })
  for (const [key, entry] of billed) {
    const [ddtId, , size] = key.split('|') as [string, string, string]
    const ddt = ddts.get(ddtId)
    const label = ddt ? `DDT ${ddt.number}` : 'its DDT'
    const row = rows.get(key)
    if (!row) {
      add('DDT_NOT_CARRIED', `lines/${entry.index}/quantity`, `Line ${entry.index + 1} bills size ${size} of an order line that ${label} did not carry.`)
      continue
    }
    if (entry.quantity.gt(row.notInvoiced)) {
      const by = row.invoices.filter((invoice) => !invoice.draft && invoice.number).map((invoice) => invoice.number)
      add(
        'DDT_INVOICED',
        `lines/${entry.index}/quantity`,
        `${label} carried ${row.shipped.toString()} of size ${size} of this order line and ${row.invoiced.toString()} ${row.invoiced.eq(1) ? 'is' : 'are'} invoiced already${by.length > 0 ? ` (${by.join(', ')})` : ''}: line ${entry.index + 1} bills ${entry.quantity.toString()}. Shipped goods are invoiced once; a correction is a credit note.`,
      )
    }
  }
  return problems
}
