import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { listHides, type HideQuery } from '../../../modules/inventory/stock/hides'
import { defineExportSource } from '../source'

/**
 * Warehouse › Hides (SCR-200, `/warehouse/hides`): the export of the list as the screen shows it. The address is the
 * list's own (apps/factory-web areas/warehouse/hides model.ts hideViewOf / filtersOf / hideQuery): `?view=inStock|full|
 * partlyCut|remnants|quarantine|reserved|consumed|all` (or the API's own `?state=REMNANT|CONSUMED`, `?quality=QUARANTINE`,
 * `?reserved=true`, `?inStock=true`; nothing: the hides in stock), `?site=`, `?q=`, `?lot=`, `?grade=`, `?shade=`,
 * `?location=`. Read through the module's listHides (inventory.stock.view, its companies and sites), a page at a time.
 * No money. Areas and what is left are decimals in the hide's unit of entry and the item's base unit (the screen names
 * the unit beside each number; the file writes the number).
 */

type Row = Awaited<ReturnType<typeof listHides>>['hides'][number]
type Query = Omit<HideQuery, 'cursor' | 'limit'>

const VIEWS = ['inStock', 'full', 'partlyCut', 'remnants', 'quarantine', 'reserved', 'consumed', 'all'] as const
type View = (typeof VIEWS)[number]

function viewOf(address: URLSearchParams): View {
  const asked = address.get('view') ?? ''
  if ((VIEWS as readonly string[]).includes(asked)) return asked as View
  if (address.get('state') === 'REMNANT') return 'remnants'
  if (address.get('state') === 'CONSUMED') return 'consumed'
  if (address.get('quality') === 'QUARANTINE') return 'quarantine'
  if (address.get('reserved') === 'true') return 'reserved'
  return 'inStock'
}

const VIEW_FILTER: Readonly<Record<View, Query>> = {
  inStock: { inStock: true },
  full: { state: 'FULL' },
  partlyCut: { state: 'PARTLY_CUT' },
  remnants: { state: 'REMNANT' },
  quarantine: { inStock: true, quality: 'QUARANTINE' },
  reserved: { reserved: true },
  consumed: { state: 'CONSUMED' },
  all: {},
}

/** An id term of the address: a uuid, or the list refuses it as the API would. */
function idTerm(address: URLSearchParams, name: string): string | undefined {
  const value = address.get(name) || undefined
  if (value && !isUuid(value)) throw new ValidationError(`Not a ${name}.`, [{ path: `query/${name}`, message: 'An id.' }])
  return value
}

const text = (address: URLSearchParams, name: string, max: number): string | undefined => address.get(name)?.trim().slice(0, max) || undefined

export const hides = defineExportSource<Query, Row>({
  listKey: 'warehouse.hides',
  permission: INVENTORY_STOCK_VIEW,
  query(address) {
    return {
      ...VIEW_FILTER[viewOf(address)],
      siteId: idTerm(address, 'site'),
      lotId: idTerm(address, 'lot'),
      locationId: idTerm(address, 'location'),
      grade: text(address, 'grade', 20),
      shade: text(address, 'shade', 40),
      q: text(address, 'q', 80),
    }
  },
  async read(caller, query, cursor, limit) {
    const page = await listHides(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.hides, next: page.nextCursor }
  },
  columns: {
    tag: { value: (row) => row.code },
    article: { value: (row) => `${row.item.code} · ${row.item.name}` },
    lot: { value: (row) => row.lot.code },
    batch: { value: (row) => row.lot.dyeBatch },
    grade: { value: (row) => row.grade },
    area: { value: (row) => ({ decimal: row.area }) },
    left: { value: (row) => ({ decimal: row.left }) },
    state: { value: (row, words) => words(`hideState.${row.state}`) },
    place: { value: (row, words) => (row.location ? row.location.code : row.state === 'CONSUMED' || row.state === 'SCRAPPED' ? null : words('noPlace')) },
    thickness: { value: (row) => (row.thicknessMm ? { decimal: row.thicknessMm } : null) },
    defects: { value: (row) => row.defects },
    reservedFor: { value: (row) => (row.reservedFor ? (row.reservedFor.demand.type === 'WorkOrder' ? row.reservedFor.demand.number : `${row.reservedFor.demand.orderNumber} · ${row.reservedFor.demand.seq}`) : null) },
    received: { value: (row) => (row.receivedAt ? { day: businessDate(new Date(row.receivedAt)) } : null) },
  },
  words: {
    it: {
      'hideState.FULL': 'Intera',
      'hideState.PARTLY_CUT': 'Tagliata in parte',
      'hideState.REMNANT': 'Ritaglio',
      'hideState.CONSUMED': 'Consumata',
      'hideState.SCRAPPED': 'Scartata',
      'hideState.RETURNED': 'Resa al fornitore',
      noPlace: 'Presso un ordine di lavoro',
    },
    en: {
      'hideState.FULL': 'Full',
      'hideState.PARTLY_CUT': 'Partly cut',
      'hideState.REMNANT': 'Remnant',
      'hideState.CONSUMED': 'Consumed',
      'hideState.SCRAPPED': 'Scrapped',
      'hideState.RETURNED': 'Sent back to the supplier',
      noPlace: 'At a work order',
    },
  },
})
