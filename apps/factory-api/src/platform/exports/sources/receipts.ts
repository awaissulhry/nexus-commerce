import { businessDate, businessDayStart } from '@nexus/factory-domain/core/time'
import { holds } from '@nexus/factory-domain/core/permissions'
import { INVENTORY_RECEIVE, INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { decimalText, type ExportLocale } from '@nexus/factory-domain/views/exports'
import { actorOf } from '../../../core/context'
import { expectedLines, listReceipts } from '../../../modules/inventory/receipts/read'
import { defineExportSource } from '../source'

/**
 * Warehouse › Receipts (SCR-062, `/warehouse/receipts`): the export of the list as the screen shows it. The address is
 * the list's own (apps/factory-web areas/warehouse/receipts model.ts receiptViewOf / receiptQuery): `?view=expected|
 * posted|today|waiting|discrepancies|reversed|all` (or the API's own `?status=POSTED|REVERSED`, `?waiting=true`,
 * `?discrepancies=open`; nothing: what is expected for a person who receives goods (inventory.receive), else every
 * receipt), `?q=`. The screen shows ONE list at a time under the same list key, so does the file:
 *   - Expected: the order lines still to receive (the module's expectedLines, the first 200 orders as the screen reads
 *     them; the search as the screen applies it: order, supplier, material, colour);
 *   - every other view: the goods receipts (the module's listReceipts, inventory.stock.view, a page at a time; "Posted
 *     today" from the start of the site's day, Europe/Rome).
 * The value is the cost grain: absent without it. Quantities are said per unit (never added across units).
 */

type Receipt = Awaited<ReturnType<typeof listReceipts>>['receipts'][number]
type Expected = Awaited<ReturnType<typeof expectedLines>>['lines'][number]
type Row = { readonly kind: 'receipt'; readonly receipt: Receipt; readonly locale: ExportLocale } | { readonly kind: 'expected'; readonly line: Expected }

const VIEWS = ['expected', 'posted', 'today', 'waiting', 'discrepancies', 'reversed', 'all'] as const
type View = (typeof VIEWS)[number]
/** `default`: the screen's first view, which depends on who looks (resolved in the read, as the person). */
type Query = { readonly view: View | 'default'; readonly q: string }

function viewOf(address: URLSearchParams): View | 'default' {
  const asked = address.get('view') ?? ''
  if ((VIEWS as readonly string[]).includes(asked)) return asked as View
  const status = address.get('status')
  if (status === 'POSTED') return 'posted'
  if (status === 'REVERSED') return 'reversed'
  if (address.get('waiting') === 'true') return 'waiting'
  if (address.get('discrepancies') === 'open') return 'discrepancies'
  return 'default'
}

const fill = (template: string, values: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''))
const plural = (count: number): string => (count === 1 ? 'one' : 'other')

/** The expected lines the screen's search keeps (order, supplier, material, colour; any case). */
function searched(line: Expected, q: string): boolean {
  const needle = q.trim().toLowerCase()
  return !needle || [line.number, line.supplier.name, line.item.code, line.item.name, line.colour?.name].some((text) => !!text && text.toLowerCase().includes(needle))
}

export const receipts = defineExportSource<Query, Row>({
  listKey: 'warehouse.receipts',
  permission: INVENTORY_STOCK_VIEW,
  query(address) {
    return { view: viewOf(address), q: (address.get('q') ?? '').trim().slice(0, 60) }
  },
  async read(caller, query, cursor, limit, options) {
    const context = caller.factoryContext
    const view: View = query.view !== 'default' ? query.view : context && holds(actorOf(context), INVENTORY_RECEIVE) ? 'expected' : 'all'
    if (view === 'expected') {
      if (cursor !== null) return { rows: [], next: null }
      const answer = await expectedLines(caller, { limit: 200 })
      return { rows: answer.lines.filter((line) => searched(line, query.q)).map((line) => ({ kind: 'expected' as const, line })), next: null }
    }
    const page = await listReceipts(caller, {
      ...(view === 'posted' || view === 'today' ? { status: 'POSTED' as const } : view === 'reversed' ? { status: 'REVERSED' as const } : {}),
      ...(view === 'waiting' ? { waiting: true } : {}),
      ...(view === 'discrepancies' ? { discrepancies: 'open' as const } : {}),
      ...(view === 'today' ? { postedFrom: businessDayStart(businessDate(new Date())).toISOString() } : {}),
      q: query.q || undefined,
      cursor: cursor ?? undefined,
      limit,
    })
    const locale: ExportLocale = options?.locale ?? 'it'
    return { rows: page.receipts.map((receipt) => ({ kind: 'receipt' as const, receipt, locale })), next: page.nextCursor }
  },
  columns: {
    // Both lists
    order: {
      value: (row, words) =>
        row.kind === 'receipt'
          ? `${row.receipt.supplier.name} · ${row.receipt.purchaseOrder ? row.receipt.purchaseOrder.number : words('noOrder')}`
          : `${row.line.number} · ${fill(words('lineSeq'), { seq: row.line.seq })} · ${row.line.supplier.name}`,
    },
    status: { value: (row, words) => (row.kind === 'receipt' ? words(`rcStatus.${row.receipt.status}`) : words(`poStatus.${row.line.status}`)) },
    // The receipts
    number: { value: (row) => (row.kind === 'receipt' ? row.receipt.number : null) },
    ddt: {
      value: (row, words) => {
        if (row.kind !== 'receipt') return null
        return row.receipt.supplierDdtNumber ? fill(words('ddt'), { number: row.receipt.supplierDdtNumber, date: row.receipt.supplierDdtDate ?? '—' }) : words('noDdt')
      },
    },
    lines: { value: (row) => (row.kind === 'receipt' ? row.receipt.lines : null) },
    lots: {
      value: (row, words) => {
        if (row.kind !== 'receipt') return null
        return row.receipt.lots === 0 ? words('noLots') : fill(words(`lotsReleased_${plural(row.receipt.lots)}`), { released: row.receipt.lotsReleased, count: row.receipt.lots })
      },
    },
    discrepancies: {
      value: (row, words) => {
        if (row.kind !== 'receipt') return null
        const counts = row.receipt.discrepancies
        if (counts.count === 0) return null
        return counts.open > 0 ? fill(words(`discOpen_${plural(counts.open)}`), { count: counts.open, unsent: counts.unsent }) : fill(words(`discClosed_${plural(counts.count)}`), { count: counts.count })
      },
    },
    quantity: {
      value: (row, words) => {
        if (row.kind !== 'receipt') return null
        const locale = row.locale
        return row.receipt.quantities.map((entry) => `${decimalText(entry.baseQuantity, locale)} ${words(`uom.${entry.uom}`)}`).join(' · ') || null
      },
    },
    value: { grain: 'cost', value: (row) => (row.kind === 'receipt' && row.receipt.value ? { minor: Number(row.receipt.value.valueAmount), currency: row.receipt.value.currency } : null) },
    // The expected lines
    material: { value: (row) => (row.kind === 'expected' ? `${row.line.item.code} · ${row.line.item.name}` : null) },
    open: { value: (row) => (row.kind === 'expected' ? { decimal: row.line.open } : null) },
    tolerance: { value: (row, words) => (row.kind === 'expected' ? (row.line.tolerancePct ? fill(words('tolerance'), { pct: row.line.tolerancePct }) : words('noTolerance')) : null) },
    due: { value: (row) => (row.kind === 'expected' ? { day: row.line.needDate } : null) },
  },
  words: {
    it: {
      'rcStatus.OPEN': 'Aperto',
      'rcStatus.POSTED': 'Registrato',
      'rcStatus.REVERSED': 'Stornato',
      'rcStatus.CANCELLED': 'Annullato',
      'poStatus.DRAFT': 'Bozza',
      'poStatus.SENT': 'Inviato',
      'poStatus.CHANGES_PROPOSED': 'Modifiche proposte',
      'poStatus.CONFIRMED': 'Confermato',
      'poStatus.DECLINED': 'Rifiutato',
      'poStatus.PARTLY_RECEIVED': 'Ricevuto in parte',
      'poStatus.RECEIVED': 'Ricevuto',
      'poStatus.CLOSED': 'Chiuso',
      'poStatus.CANCELLED': 'Annullato',
      ddt: 'DDT {number} del {date}',
      noDdt: 'Nessun DDT del fornitore',
      noOrder: 'senza ordine d’acquisto',
      lotsReleased_one: '{released} di {count} lotto rilasciato',
      lotsReleased_other: '{released} di {count} lotti rilasciati',
      noLots: 'Nessun lotto',
      discOpen_one: '{count} aperta · {unsent} da segnalare',
      discOpen_other: '{count} aperte · {unsent} da segnalare',
      discClosed_one: '{count} chiusa',
      discClosed_other: '{count} chiuse',
      lineSeq: 'riga {seq}',
      tolerance: '± {pct}%',
      noTolerance: 'nessuna tolleranza',
      'uom.PCS': 'pz',
      'uom.PAIR': 'paio',
      'uom.SET': 'set',
      'uom.M': 'm',
      'uom.CM': 'cm',
      'uom.MM': 'mm',
      'uom.M2': 'm²',
      'uom.DM2': 'dm²',
      'uom.FT2': 'ft²',
      'uom.KG': 'kg',
      'uom.G': 'g',
      'uom.L': 'l',
      'uom.HIDE': 'pelli',
      'uom.SIDE': 'mezze pelli',
      'uom.ROLL': 'rotoli',
      'uom.CONE': 'coni',
      'uom.BOX': 'scatole',
    },
    en: {
      'rcStatus.OPEN': 'Open',
      'rcStatus.POSTED': 'Posted',
      'rcStatus.REVERSED': 'Reversed',
      'rcStatus.CANCELLED': 'Cancelled',
      'poStatus.DRAFT': 'Draft',
      'poStatus.SENT': 'Sent',
      'poStatus.CHANGES_PROPOSED': 'Changes proposed',
      'poStatus.CONFIRMED': 'Confirmed',
      'poStatus.DECLINED': 'Declined',
      'poStatus.PARTLY_RECEIVED': 'Partly received',
      'poStatus.RECEIVED': 'Received',
      'poStatus.CLOSED': 'Closed',
      'poStatus.CANCELLED': 'Cancelled',
      ddt: 'DDT {number} of {date}',
      noDdt: 'No supplier DDT',
      noOrder: 'no purchase order',
      lotsReleased_one: '{released} of {count} lot released',
      lotsReleased_other: '{released} of {count} lots released',
      noLots: 'No lots',
      discOpen_one: '{count} open · {unsent} not reported',
      discOpen_other: '{count} open · {unsent} not reported',
      discClosed_one: '{count} closed',
      discClosed_other: '{count} closed',
      lineSeq: 'line {seq}',
      tolerance: '± {pct}%',
      noTolerance: 'no tolerance',
      'uom.PCS': 'pcs',
      'uom.PAIR': 'pair',
      'uom.SET': 'set',
      'uom.M': 'm',
      'uom.CM': 'cm',
      'uom.MM': 'mm',
      'uom.M2': 'm²',
      'uom.DM2': 'dm²',
      'uom.FT2': 'ft²',
      'uom.KG': 'kg',
      'uom.G': 'g',
      'uom.L': 'l',
      'uom.HIDE': 'hides',
      'uom.SIDE': 'sides',
      'uom.ROLL': 'rolls',
      'uom.CONE': 'cones',
      'uom.BOX': 'boxes',
    },
  },
})
