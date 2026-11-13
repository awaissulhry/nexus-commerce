import { cell, type CellValue } from '../../imports/cells'
import { defineImporter, type RowIssue, type RowValues } from '../../imports/importer'
import type { TemplateExample } from '../../imports/templates'
import { ORDERS_DEPTH_LIMITS, SALES_ORDER_PRIORITY_LEVELS, type SalesOrderPriorityLevel } from '../orders-depth/rules'

/**
 * Import orders from a sheet (B-W2b-303; SAL-215 "order import for repeat brand business"; design sales.orders pop
 * orders.import "ImportFlow: upload → dry run → diff with counts and reasons → Apply"), pure: one row per order, style,
 * colour and size. The rows of one `order` (the sheet's own reference: 1, 2 … or the customer's PO) make ONE order typed as
 * the office types one (POST /sales/orders/manual: the customer's terms, list price unless a price is given, the line rules,
 * the credit check, a SALES_ORDER rule that may make it wait); its rows say the same customer, PO, dates, season and priority
 * (or leave them blank on all but one).
 *
 * The importer (the imports registry's `sales.orders`): the engine reads, maps and parses the sheet; the dry run judges
 * every row (apps/factory-api modules/sales/order-import): the customer, its style, colour and size, a PO number its terms
 * require, an order already imported with that PO. Only new orders: a row is never an update. The apply is ONE batch (one
 * command): every order or none.
 */

export const ORDER_IMPORT_KEY = 'sales.orders'
export const ORDER_IMPORT_LIMITS = Object.freeze({ rows: 1000, orders: 100, reference: 40, size: 20, quantity: 100_000 })

const PRIORITY_ALIASES = { bassa: 'LOW', normale: 'NORMAL', alta: 'HIGH', urgente: 'URGENT', low: 'LOW', normal: 'NORMAL', high: 'HIGH', urgent: 'URGENT' } as const satisfies Record<string, SalesOrderPriorityLevel>

export const orderImporter = defineImporter({
  key: ORDER_IMPORT_KEY,
  label: 'Sales orders',
  description: 'Orders typed in a sheet, one row per order, style, colour and size: the rows of one order reference make one order with the customer\'s terms and prices. Dry run first; the apply makes every order or none.',
  columns: {
    order: { label: 'Order', aliases: ['ordine', 'rif ordine', 'riferimento', 'n ordine', 'order ref', 'order reference', 'reference'], required: true, type: cell.code({ max: ORDER_IMPORT_LIMITS.reference }), description: 'Your reference for the order in this sheet (1, 2 … or the customer\'s PO): its rows make one order.' },
    customer: { label: 'Customer', aliases: ['cliente', 'codice cliente', 'customer code', 'client'], required: true, type: cell.code({ max: 40, upper: true }), description: "The customer's code: the same on every row of the order." },
    style: { label: 'Style', aliases: ['modello', 'codice', 'codice articolo', 'articolo', 'style code'], required: true, type: cell.code({ max: 64, upper: true }), description: 'Our style code.' },
    colour: { label: 'Colour', aliases: ['color', 'colore', 'colourway', 'variante', 'colour code'], required: true, type: cell.text({ max: 100 }), description: "The colourway's code or name." },
    size: { label: 'Size', aliases: ['taglia', 'misura'], required: true, type: cell.text({ max: ORDER_IMPORT_LIMITS.size }) },
    quantity: { label: 'Quantity', aliases: ['qty', 'pieces', 'quantità', 'quantita', 'pezzi', 'qta'], required: true, type: cell.integer({ min: 1, max: ORDER_IMPORT_LIMITS.quantity }) },
    unitPrice: { label: 'Unit price', aliases: ['prezzo', 'prezzo unitario', 'price'], type: cell.decimal({ precision: 18, scale: 6, min: '0' }), grain: 'price', description: "A price of your own on the order's basis; blank: the customer's list price. The same on every row of a style and colour." },
    customerPo: { label: 'Customer PO', aliases: ['po cliente', 'ordine cliente', 'vs ordine', 'po', 'po number', 'customer order'], type: cell.text({ max: 100 }), description: "The customer's purchase order number." },
    requestedDate: { label: 'Requested date', aliases: ['data richiesta', 'consegna richiesta', 'requested'], type: cell.date() },
    promiseDate: { label: 'Promise date', aliases: ['data promessa', 'consegna promessa', 'promised', 'promise'], type: cell.date() },
    season: { label: 'Season', aliases: ['stagione', 'season code'], type: cell.code({ max: 20 }), description: 'An open season of the company, by its code (FW27).' },
    priority: { label: 'Priority', aliases: ['priorità', 'priorita'], type: cell.oneOf(SALES_ORDER_PRIORITY_LEVELS, PRIORITY_ALIASES), description: 'LOW, NORMAL, HIGH or URGENT; blank: NORMAL.' },
    urgentReason: { label: 'Urgent reason', aliases: ['motivo urgenza', 'perché urgente', 'why urgent'], type: cell.text({ max: ORDERS_DEPTH_LIMITS.urgentReason }), description: 'Why it is urgent (needed with URGENT, only then).' },
    note: { label: 'Note', aliases: ['nota', 'note riga', 'line note'], type: cell.text({ max: 2000 }), description: 'Kept on the line of the style and colour.' },
  },
  keyColumns: ['order', 'style', 'colour', 'size'],
  maxRows: ORDER_IMPORT_LIMITS.rows,
  // Every order or none: the apply is ONE batch (one command).
  batchSize: ORDER_IMPORT_LIMITS.rows,
  validateRow: (values: RowValues): RowIssue[] => {
    const issues: RowIssue[] = []
    if (values.urgentReason !== undefined && values.priority !== 'URGENT') issues.push({ column: 'urgentReason', message: 'A reason goes with URGENT only.' })
    return issues
  },
  // Only new orders: a row is never an update (the adapter's load finds none; an order imported before is refused by its check).
  plan: (values) => ({ action: 'CREATE', after: values }),
})

/** Made-up example rows of the template (never business data). */
export const ORDER_IMPORT_EXAMPLES: readonly TemplateExample[] = Object.freeze<TemplateExample[]>([
  { order: '1', customer: 'CLI-001', style: 'JK-210', colour: 'BLK', size: '50', quantity: '4', customerPo: 'PO-ESEMPIO-7', promiseDate: '2027-03-15', season: 'FW27' },
  { order: '1', customer: 'CLI-001', style: 'JK-210', colour: 'BLK', size: '52', quantity: '6', customerPo: 'PO-ESEMPIO-7', promiseDate: '2027-03-15', season: 'FW27' },
  { order: '2', customer: 'CLI-002', style: 'JK-210', colour: 'RED', size: '48', quantity: '2', unitPrice: '440', priority: 'URGENT', urgentReason: 'Made-up race weekend' },
])

const HEADER_COLUMNS = ['customer', 'customerPo', 'requestedDate', 'promiseDate', 'season', 'priority', 'urgentReason'] as const
type HeaderColumn = (typeof HEADER_COLUMNS)[number]

export interface ImportRow {
  readonly rowNumber: number
  readonly values: RowValues
}

export interface ImportLine {
  readonly style: string
  readonly colour: string
  readonly unitPrice: string | null
  readonly note: string | null
  readonly sizes: readonly { readonly size: string; readonly quantity: number; readonly rowNumber: number }[]
}

export interface ImportOrder {
  readonly reference: string
  readonly rowNumbers: readonly number[]
  readonly header: Readonly<Record<HeaderColumn, CellValue | null>>
  readonly lines: readonly ImportLine[]
}

const text = (value: CellValue | undefined): string | null => (value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim())

/**
 * The rows grouped into orders (by `order`, in the sheet's order) with one issue list per row (in the order given): the
 * header cells must agree across an order's rows (a blank says nothing), a style and colour's price and note too; at most
 * ORDER_IMPORT_LIMITS.orders orders.
 */
export function groupOrders(rows: readonly ImportRow[]): { readonly orders: readonly ImportOrder[]; readonly issues: readonly RowIssue[][] } {
  const issues = rows.map((): RowIssue[] => [])
  const groups = new Map<string, number[]>()
  rows.forEach((row, index) => {
    const reference = text(row.values.order) ?? ''
    groups.set(reference, [...(groups.get(reference) ?? []), index])
  })
  const orders: ImportOrder[] = []
  for (const [reference, indexes] of groups) {
    const header = Object.fromEntries(HEADER_COLUMNS.map((column) => [column, null])) as Record<HeaderColumn, CellValue | null>
    for (const column of HEADER_COLUMNS) {
      const given = indexes.flatMap((index) => (text(rows[index]!.values[column]) === null ? [] : [{ index, value: rows[index]!.values[column]! }]))
      const distinct = [...new Set(given.map((entry) => String(entry.value)))]
      if (distinct.length > 1) for (const entry of given) issues[entry.index]!.push({ column, message: `The rows of order ${reference} give different values here (${distinct.join(', ')}): one order has one.` })
      else if (given.length > 0) header[column] = given[0]!.value
    }
    const lines = new Map<string, { style: string; colour: string; prices: Set<string>; notes: Set<string>; sizes: { size: string; quantity: number; rowNumber: number }[]; indexes: number[] }>()
    for (const index of indexes) {
      const values = rows[index]!.values
      const style = text(values.style)?.toUpperCase() ?? ''
      const colour = text(values.colour) ?? ''
      const key = `${style}\u0000${colour.toLowerCase()}`
      const line = lines.get(key) ?? { style, colour, prices: new Set<string>(), notes: new Set<string>(), sizes: [], indexes: [] }
      const price = text(values.unitPrice)
      if (price !== null) line.prices.add(price)
      const note = text(values.note)
      if (note !== null) line.notes.add(note)
      line.sizes.push({ size: text(values.size) ?? '', quantity: typeof values.quantity === 'number' ? values.quantity : Number.parseInt(String(values.quantity ?? '0'), 10) || 0, rowNumber: rows[index]!.rowNumber })
      line.indexes.push(index)
      lines.set(key, line)
    }
    for (const line of lines.values()) {
      if (line.prices.size > 1) for (const index of line.indexes) issues[index]!.push({ column: 'unitPrice', message: `${line.style} ${line.colour} has more than one price in order ${reference}: one price per style and colour (a size's own price is the price list's).` })
      if (line.notes.size > 1) for (const index of line.indexes) issues[index]!.push({ column: 'note', message: `${line.style} ${line.colour} has more than one note in order ${reference}.` })
    }
    if (header.priority === 'URGENT' && text(header.urgentReason ?? undefined) === null) for (const index of indexes) issues[index]!.push({ column: 'urgentReason', message: `Order ${reference} is URGENT: say why on one of its rows.` })
    orders.push({
      reference,
      rowNumbers: indexes.map((index) => rows[index]!.rowNumber),
      header,
      lines: [...lines.values()].map((line) => ({ style: line.style, colour: line.colour, unitPrice: line.prices.size === 1 ? [...line.prices][0]! : null, note: line.notes.size === 1 ? [...line.notes][0]! : null, sizes: line.sizes })),
    })
  }
  if (orders.length > ORDER_IMPORT_LIMITS.orders) issues.forEach((list) => list.push({ column: 'order', message: `One sheet makes at most ${ORDER_IMPORT_LIMITS.orders} orders: split it.` }))
  return { orders, issues }
}
