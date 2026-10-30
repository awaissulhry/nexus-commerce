import type { LocationView, SiteLocations, StockOverview, StockRow } from '../../../_shared/stock/api'
import { COLOURS, COMPANY, ITEMS, LOCATIONS, LOTS, SITE, SITE_SOUTH, at, named, stockRow, uid } from '../../../_shared/stock/fixtures'

/**
 * Made-up data of the Locations design cases (SCR-065): the demo site's tree (a warehouse with a rack and two bins, the
 * goods-in dock, the quarantine shelf, the cutting room's rack, an archived mezzanine), a second site with one store,
 * and what lies where. Nothing here is a real place, company or number. Design-only (fixtures and tests import it).
 */

export const ACTIVE_PLACES: LocationView[] = Object.values(LOCATIONS).filter((location) => location.status === 'ACTIVE')
export const ALL_PLACES: LocationView[] = Object.values(LOCATIONS)

export const NORTH: SiteLocations = { id: SITE.id, companyId: COMPANY, code: SITE.code, name: SITE.name, locations: ACTIVE_PLACES }
export const NORTH_ALL: SiteLocations = { ...NORTH, locations: ALL_PLACES }
export const SOUTH: SiteLocations = {
  id: SITE_SOUTH.id,
  companyId: COMPANY,
  code: SITE_SOUTH.code,
  name: SITE_SOUTH.name,
  locations: [
    {
      id: uid('2424', 1),
      companyId: COMPANY,
      siteId: SITE_SOUTH.id,
      parentId: null,
      code: 'S-MAG',
      name: 'Magazzino accessori',
      kind: 'WAREHOUSE',
      status: 'ACTIVE',
      depth: 0,
      path: ['S-MAG'],
      version: 2,
      createdAt: at(2, 8),
      updatedAt: at(9, 8),
    },
  ],
}
export const EMPTY_SITE: SiteLocations = { ...SOUTH, locations: [] }

const hide = (n: number) => ({ id: uid('8282', n), code: `HD-DEMO-${String(n).padStart(4, '0')}` })
const leather = (n: number, location: LocationView, area: string, lot: { id: string; code: string } = LOTS.nappa, status: 'RELEASED' | 'QUARANTINE' = 'RELEASED'): StockRow =>
  stockRow({ item: ITEMS.leather, location: named(location), colour: COLOURS.black, lot: { ...lot, qualityStatus: status }, hide: hide(n), onHand: area, held: status === 'RELEASED' ? '0.0000' : area, available: status === 'RELEASED' ? area : '0.0000', unitCost: '6.250000', value: Math.round(Number(area) * 625) })

export const STOCK_ROWS: StockRow[] = [
  leather(1, LOCATIONS.binA1, '48.0000'),
  leather(2, LOCATIONS.binA1, '49.3000'),
  leather(3, LOCATIONS.binA1, '50.6000'),
  leather(4, LOCATIONS.quarantine, '40.0000', LOTS.nappaQuarantine, 'QUARANTINE'),
  leather(5, LOCATIONS.cutting, '22.4000'),
  stockRow({ item: ITEMS.lining, location: named(LOCATIONS.binA2), colour: COLOURS.grey, lot: { ...LOTS.lining, qualityStatus: 'RELEASED' }, onHand: '120.0000', held: '0.0000', available: '120.0000', unitCost: '3.100000', value: 37_200 }),
  stockRow({ item: ITEMS.protector, location: named(LOCATIONS.binA2), lot: { ...LOTS.protector, qualityStatus: 'RELEASED' }, onHand: '40.0000', held: '0.0000', available: '40.0000', unitCost: '4.000000', value: 16_000 }),
  stockRow({ item: ITEMS.zip, location: named(LOCATIONS.receiving), onHand: '200.0000', held: '0.0000', available: '200.0000', unitCost: '0.850000', value: 17_000 }),
]

/** The overview as the API answers it (values only with the cost grain: strip them for a role without it). */
export function overviewOf(withCost: boolean, rows: readonly StockRow[] = STOCK_ROWS): StockOverview {
  const strip = (row: StockRow): StockRow => {
    if (withCost) return row
    return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'unitCost' && key !== 'value')) as StockRow
  }
  const currency = withCost ? { currency: 'EUR' } : {}
  const items = [...new Set(rows.map((row) => row.item.id))].map((itemId) => {
    const row = rows.find((entry) => entry.item.id === itemId)!
    return { itemId, itemColourId: row.colour?.id ?? null, item: row.item, colour: row.colour, onHand: '0', held: '0', available: '0', hides: 0, heldHides: 0, locations: 1, ...currency }
  })
  return { rows: rows.map(strip), items, truncated: false }
}
