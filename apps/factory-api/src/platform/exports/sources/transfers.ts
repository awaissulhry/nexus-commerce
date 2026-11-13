import { isUuid } from '@nexus/factory-domain/core/ids'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import type { ListQuery, TransferRow } from '@nexus/factory-domain/inventory/transfers/contracts'
import { TRANSFER_LIMITS, TRANSFER_STATUSES, TRANSFER_TILES } from '@nexus/factory-domain/inventory/transfers/rules'
import { listTransfers } from '../../../modules/inventory/transfers/transfers'
import { defineExportSource } from '../source'

/**
 * Warehouse › In the warehouse › Transfers (SCR-360, `/warehouse/transfers`; B-W2b-326's list, B-W2b-383 follow-up XF8:06):
 * the export of the list as the screen shows it, through the module's own listTransfers (inventory.stock.view at either end,
 * newest first). The address is the list's own (apps/factory-web areas/warehouse/transfers model.ts addressOf): `?tile=
 * IN_TRANSIT|ARRIVING_TODAY|WITH_DIFFERENCES`, `?status=`, `?from=` and `?to=` (site ids), `?q=`. The list has no pages: it
 * reads at most 200 transfers (the screen says "narrow the filters" beyond), and so does the file. Columns by the frame's
 * ids; the state is the screen's (in transit for a shipped one, closed for one received with nothing left to settle). Never
 * a quantity of goods, never a person.
 */

type Query = Omit<ListQuery, 'limit'>
type Row = TransferRow

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | undefined => ((values as readonly string[]).includes(value ?? '') ? (value as T) : undefined)
const siteOf = (value: string | null): string | undefined => (value && isUuid(value) ? value : undefined)

/** The screen's state of a row (web transfers model.ts lifecycleOf). */
function lifecycleOf(row: Pick<Row, 'status' | 'differences'>): string {
  if (row.status === 'SHIPPED') return 'IN_TRANSIT'
  if (row.status === 'RECEIVED') return row.differences > 0 ? 'RECEIVED' : 'CLOSED'
  return row.status
}

const siteText = (site: Row['from'], interCompany: boolean): string => [site.code, site.name && site.name !== site.code ? site.name : null, interCompany ? site.companyName : null].filter(Boolean).join(' · ')

export const transfers = defineExportSource<Query, Row>({
  listKey: 'warehouse.transfers',
  permission: INVENTORY_STOCK_VIEW,
  query(address) {
    const q = address.get('q')?.trim().slice(0, TRANSFER_LIMITS.search)
    return {
      ...(oneOf(TRANSFER_TILES, address.get('tile')) ? { tile: oneOf(TRANSFER_TILES, address.get('tile')) } : {}),
      ...(oneOf(TRANSFER_STATUSES, address.get('status')) ? { status: oneOf(TRANSFER_STATUSES, address.get('status')) } : {}),
      ...(siteOf(address.get('from')) ? { fromSiteId: siteOf(address.get('from')) } : {}),
      ...(siteOf(address.get('to')) ? { toSiteId: siteOf(address.get('to')) } : {}),
      ...(q ? { q } : {}),
    }
  },
  async read(caller, query, cursor, limit) {
    // One read, as the screen's: a cursor never comes back.
    if (cursor) return { rows: [], next: null }
    const list = await listTransfers(caller, { ...query, limit: Math.min(limit, TRANSFER_LIMITS.list) })
    return { rows: list.rows, next: null }
  },
  columns: {
    number: { value: (row, words) => (row.interCompany ? `${row.number} · ${words('row.interCompany')}` : row.number) },
    from: { value: (row) => siteText(row.from, row.interCompany) },
    to: { value: (row) => siteText(row.to, row.interCompany) },
    // A late one (in transit, expected before today) says so beside its state; the expected day stays a date of the file.
    status: { value: (row, words) => (row.late ? `${words(`lifecycle.${lifecycleOf(row)}`)} · ${words('row.late')}` : words(`lifecycle.${lifecycleOf(row)}`)) },
    lines: { value: (row) => row.lines },
    shipOn: { value: (row) => (row.shipOn ? { day: row.shipOn } : null) },
    expectedOn: { value: (row) => (row.expectedOn ? { day: row.expectedOn } : null) },
    ddt: { value: (row) => row.ddtNumber },
    differences: { value: (row) => row.differences },
  },
  words: {
    it: {
      'row.interCompany': 'tra due aziende',
      'row.late': 'in ritardo',
      'lifecycle.DRAFT': 'Bozza',
      'lifecycle.IN_TRANSIT': 'In viaggio',
      'lifecycle.PARTLY_RECEIVED': 'Ricevuto in parte',
      'lifecycle.RECEIVED': 'Ricevuto',
      'lifecycle.CLOSED': 'Chiuso',
      'lifecycle.CANCELLED': 'Annullato',
    },
    en: {
      'row.interCompany': 'between two companies',
      'row.late': 'late',
      'lifecycle.DRAFT': 'Draft',
      'lifecycle.IN_TRANSIT': 'In transit',
      'lifecycle.PARTLY_RECEIVED': 'Partly received',
      'lifecycle.RECEIVED': 'Received',
      'lifecycle.CLOSED': 'Closed',
      'lifecycle.CANCELLED': 'Cancelled',
    },
  },
})
