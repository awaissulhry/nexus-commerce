import type { FastifyInstance, FastifyRequest } from 'fastify'
import { businessDate } from '@nexus/factory-domain/core/time'
import { isMarkedJson } from '@nexus/factory-domain/money/marked'
import type { OrderChip } from '@nexus/factory-domain/sales/portal-orders/status'
import type { ExportCell, ExportLocale } from '@nexus/factory-domain/views/exports'
import { writeExport } from '../../../platform/exports/writer'
import { portalRowValues, type PortalCell, type PortalColumn } from '../../../platform/fields/portal-rows'
import { portalReader } from './access'
import { listOrders, type ListQuery } from './orders'

/**
 * The customer's own sheet in its portal (B-TH-061; threads plan TH-4, SHEET-G10, Owner decision 13; design SHEET.portal-sheet,
 * P-CUS-ORD-LIST.list; wall W10, W17, W39 / T39):
 *
 *   GET /portal/sales-orders/sheet            the rows of Portal › Orders (the same chips, search and page as GET
 *                                             /portal/sales-orders) with the columns the office ticked for the portal: the
 *                                             portal-shown custom values of each order (platform/fields/portal-rows: every
 *                                             customer's fields and this customer's own, never another's)
 *   GET /portal/sales-orders/sheet/download   "Download all (Excel)": EVERY row of the chip and search (not only the loaded page),
 *                                             written by the server here, in the partner's own scope, as Excel or CSV in the
 *                                             customer's language — never through the export job (Owner decision 13: no job, no
 *                                             office route, no stored file)
 *
 * Both read the partner's rows only (its party's row-level security, the portal's company), then its own orders' custom values;
 * so the sheet and its file hold only the customer's own rows and columns (T39). Counts do not leak (plan §0.5): the customer reads
 * its OWN order numbers ("Your order 7"), never the office's series — the sheet answers no office number for an order and the file
 * writes none. A price only with the price grain (a role without it: no value column, and the file says so).
 */

const DOWNLOAD_MAX_ROWS = 100_000

type Words = { readonly it: string; readonly en: string }

/** The file's headings in the customer's language (the portal speaks Italian and English). */
const HEADINGS = {
  yourOrder: { it: 'Il vostro ordine n.', en: 'Your order no.' },
  kind: { it: 'Tipo', en: 'Kind' },
  customerRef: { it: 'Vostro riferimento (PO)', en: 'Your reference (PO)' },
  orderedOn: { it: 'Ordinato il', en: 'Ordered on' },
  status: { it: 'Stato', en: 'Status' },
  requestedDate: { it: 'Data richiesta', en: 'Requested date' },
  promiseDate: { it: 'Data promessa', en: 'Promised date' },
  firstPromise: { it: 'Prima data promessa', en: 'First promised date' },
  ordered: { it: 'Pezzi ordinati', en: 'Pieces ordered' },
  shipped: { it: 'Pezzi spediti', en: 'Pieces shipped' },
  open: { it: 'Pezzi da spedire', en: 'Pieces still to ship' },
  value: { it: 'Valore netto', en: 'Net value' },
  nextShipment: { it: 'Prossima spedizione', en: 'Next shipment' },
} as const satisfies Record<string, Words>
const KIND_WORDS = { ORDER: { it: 'Ordine', en: 'Order' }, REQUEST: { it: 'Richiesta', en: 'Request' } } as const satisfies Record<string, Words>
const TITLE: Words = { it: 'I vostri ordini', en: 'Your orders' }
const NO_PRICES: Words = { it: 'I prezzi non fanno parte del vostro accesso: il valore non è nel file.', en: 'Prices are not part of your access: the value is not in this file.' }
const ROWS_WORDS = (count: number): Words => ({ it: `${count} ${count === 1 ? 'riga' : 'righe'}`, en: `${count} ${count === 1 ? 'row' : 'rows'}` })

/** GET /portal/sales-orders/sheet: the page of Portal › Orders with its portal columns (see the module's head). */
export async function orderSheet(app: FastifyInstance, request: FastifyRequest, query: ListQuery, now: Date) {
  const reader = portalReader(app, request)
  const list = await listOrders(app, request, query, now)
  const { columns, rows } = await portalRowValues(request, 'ORDER', list.items.filter((item) => item.kind === 'ORDER').map((item) => item.id), reader.session.company.id)
  return {
    ...list,
    columns,
    // Plan §0.5: an order shows the customer's own number only (`yourNumber`), never the office's series.
    items: list.items.map((item) => ({ ...item, number: item.kind === 'ORDER' ? null : item.number, values: rows.get(item.id) ?? {} })),
  }
}

/** A value as stored, without its grain mark (platform/fields markedValue marks a money field's value and its amount). */
const unmarked = (value: unknown): unknown => (isMarkedJson(value) ? value.value : value)

/** A custom value as one cell of the file: a number as a number, a day as a day, an amount with its currency, else its words. */
function cellOf(column: PortalColumn, cell: PortalCell | undefined, locale: ExportLocale): ExportCell {
  if (!cell) return null
  const words = locale === 'it' ? cell.wordsIt : cell.wordsEn
  if (words !== null) return words
  const raw = unmarked(cell.value)
  if (column.type === 'MONEY') {
    const money = raw !== null && typeof raw === 'object' ? (raw as { amount?: unknown; currency?: unknown }) : null
    const amount = unmarked(money?.amount)
    return typeof amount === 'number' ? { minor: amount, currency: typeof money?.currency === 'string' ? money.currency : null } : null
  }
  if (column.type === 'DATE' && typeof raw === 'string') return { day: raw }
  if (column.type === 'YES_NO' && typeof raw === 'boolean') return raw ? (locale === 'it' ? 'Sì' : 'Yes') : 'No'
  if (typeof raw === 'number' || typeof raw === 'string') return raw
  return null
}

/** GET /portal/sales-orders/sheet/download: every row of the chip and search, as a file written here (see the module's head). */
export async function orderSheetFile(app: FastifyInstance, request: FastifyRequest, query: { readonly chip: OrderChip; readonly q?: string | undefined; readonly format: 'XLSX' | 'CSV'; readonly locale?: ExportLocale | undefined }, now: Date): Promise<{ bytes: Uint8Array; fileName: string; contentType: string }> {
  const reader = portalReader(app, request)
  const locale: ExportLocale = query.locale ?? (reader.session.person.locale === 'it' ? 'it' : 'en')
  const list = await listOrders(app, request, { chip: query.chip, q: query.q, progress: 'false', limit: DOWNLOAD_MAX_ROWS, offset: 0 }, now)
  const { columns, rows } = await portalRowValues(request, 'ORDER', list.items.filter((item) => item.kind === 'ORDER').map((item) => item.id), reader.session.company.id)
  const prices = reader.seesPrices
  const say = (words: Words) => words[locale]
  const headings = [
    say(HEADINGS.yourOrder),
    say(HEADINGS.kind),
    say(HEADINGS.customerRef),
    say(HEADINGS.orderedOn),
    say(HEADINGS.status),
    say(HEADINGS.requestedDate),
    say(HEADINGS.promiseDate),
    say(HEADINGS.firstPromise),
    say(HEADINGS.ordered),
    say(HEADINGS.shipped),
    say(HEADINGS.open),
    ...(prices ? [say(HEADINGS.value)] : []),
    say(HEADINGS.nextShipment),
    ...columns.map((column) => (locale === 'it' ? column.labelIt : column.labelEn) + (column.unit ? ` (${column.unit})` : '')),
  ]
  const day = (value: string | null): ExportCell => (value ? { day: value } : null)
  const body: ExportCell[][] = list.items.map((item) => [
    item.yourNumber?.seq ?? null,
    say(KIND_WORDS[item.kind]),
    item.customerRef,
    day(item.orderedOn),
    say(item.words),
    day(item.requestedDate),
    day(item.promiseDate),
    item.promiseMoved ? day(item.originalPromiseDate) : null,
    item.pieces.ordered,
    item.pieces.shipped,
    item.pieces.open,
    ...(prices ? [item.netAmount === null || item.netAmount === undefined ? null : { minor: Number(item.netAmount), currency: item.currency }] : []),
    item.nextShipment ? `${say(item.nextShipment.words)}${item.nextShipment.date ? ` · ${item.nextShipment.date}` : ''}` : null,
    ...columns.map((column) => cellOf(column, rows.get(item.id)?.[column.columnId], locale)),
  ])
  const bytes = await writeExport({ format: query.format, locale, title: say(TITLE), note: prices ? null : say(NO_PRICES), headings, rows: body, tail: say(ROWS_WORDS(body.length)) })
  const stamp = businessDate(now)
  const extension = query.format === 'XLSX' ? 'xlsx' : 'csv'
  return {
    bytes,
    fileName: `${say(TITLE)} ${stamp}.${extension}`,
    contentType: query.format === 'XLSX' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8',
  }
}
