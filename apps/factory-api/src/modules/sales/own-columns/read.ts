import { isUseOn, type OwnColumnKind } from '@nexus/factory-domain/sales/own-columns/rules'
import { COLUMN_SELECT, columnView, USE_SELECT, VALUE_SELECT, valueView, type OwnColumnView, type OwnValueView, type Reader } from './store'

/**
 * THE reader of the customer's own columns on records (owb- order workflow, S1 po1.4; exported for S2's office Lines tab and orders
 * sheet and S5's basket card — import it, never read the three tables yourself: a column switched off keeps its use row with a place
 * from USE_OFF_FROM on, see factory-domain sales/own-columns/rules).
 *
 *   ownColumnsOf(reader, { requestIds?, orderIds? })  →  Map<recordId, RecordOwnColumns>
 *
 * For every record asked (a portal order request — a Draft or Sent order — or a sales order): the columns ON it, in its order, and
 * the values of those columns on its LIVE lines (a draft line taken out counts nowhere), by line then by column. A record with none:
 * `{ used: [], values: {} }`. Read in the caller's scope: a portal session reads its party's rows only (row-level security), the office
 * its tenant's — the caller has checked the record is the reader's to see. The floor role reads none of these tables: a basket card
 * reads them through the API in the office or system scope. Never a price (own columns hold none).
 */

export interface RecordOwnColumns {
  readonly used: OwnColumnView[]
  /** lineId → columnId → value. */
  readonly values: Record<string, Record<string, OwnValueView>>
}

export const NO_OWN_COLUMNS: RecordOwnColumns = Object.freeze({ used: [], values: {} }) as RecordOwnColumns

export async function ownColumnsOf(reader: Reader, records: { readonly requestIds?: readonly string[]; readonly orderIds?: readonly string[] }): Promise<Map<string, RecordOwnColumns>> {
  const requestIds = [...new Set(records.requestIds ?? [])]
  const orderIds = [...new Set(records.orderIds ?? [])]
  const out = new Map<string, RecordOwnColumns>([...requestIds, ...orderIds].map((id) => [id, { used: [], values: {} }]))
  if (out.size === 0) return out
  const uses = (
    await reader.orderLineColumnUse.findMany({
      where: { OR: [...(requestIds.length > 0 ? [{ portalOrderRequestId: { in: requestIds } }] : []), ...(orderIds.length > 0 ? [{ salesOrderId: { in: orderIds } }] : [])] },
      select: USE_SELECT,
      orderBy: [{ seq: 'asc' }, { id: 'asc' }],
    })
  ).filter((use) => isUseOn(use.seq))
  if (uses.length === 0) return out
  const columns = new Map((await reader.partyLineColumn.findMany({ where: { id: { in: [...new Set(uses.map((use) => use.columnId))] } }, select: COLUMN_SELECT })).map((row) => [row.id, row]))
  const requestLines = requestIds.length > 0 ? await reader.portalOrderRequestLine.findMany({ where: { requestId: { in: requestIds }, removedAt: null }, select: { id: true, requestId: true } }) : []
  const orderLines = orderIds.length > 0 ? await reader.salesOrderLine.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true } }) : []
  const recordOfLine = new Map<string, string>([...requestLines.map((line) => [line.id, line.requestId] as const), ...orderLines.map((line) => [line.id, line.orderId] as const)])
  const usedOn = new Map<string, Set<string>>()
  for (const use of uses) {
    const recordId = use.portalOrderRequestId ?? use.salesOrderId
    const column = columns.get(use.columnId)
    if (!recordId || !column) continue
    out.get(recordId)?.used.push(columnView(column))
    usedOn.set(recordId, (usedOn.get(recordId) ?? new Set<string>()).add(use.columnId))
  }
  const lineIds = [...recordOfLine.keys()]
  if (lineIds.length === 0) return out
  const values = await reader.orderLineOwnValue.findMany({
    where: { columnId: { in: [...columns.keys()] }, OR: [...(requestLines.length > 0 ? [{ portalOrderRequestLineId: { in: requestLines.map((line) => line.id) } }] : []), ...(orderLines.length > 0 ? [{ salesOrderLineId: { in: orderLines.map((line) => line.id) } }] : [])] },
    select: VALUE_SELECT,
  })
  for (const value of values) {
    const lineId = value.portalOrderRequestLineId ?? value.salesOrderLineId
    const recordId = lineId ? recordOfLine.get(lineId) : undefined
    const column = columns.get(value.columnId)
    if (!lineId || !recordId || !column || !usedOn.get(recordId)?.has(value.columnId)) continue
    const record = out.get(recordId)!
    record.values[lineId] = { ...(record.values[lineId] ?? {}), [value.columnId]: valueView(column.kind as OwnColumnKind, value) }
  }
  return out
}

/** The columns any of these records uses, each once, in the records' order (the sheet's `ownColumns`). */
export function columnsUsedBy(records: Iterable<RecordOwnColumns>): OwnColumnView[] {
  const seen = new Map<string, OwnColumnView>()
  for (const record of records) for (const column of record.used) if (!seen.has(column.id)) seen.set(column.id, column)
  return [...seen.values()]
}
