import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import { INVENTORY_LOCATIONS_VIEW, INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { decimalText, type ExportLocale } from '@nexus/factory-domain/views/exports'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { listLocations } from '../../../modules/inventory/locations/locations'
import { stockOverview } from '../../../modules/inventory/stock/stock'
import { defineExportSource } from '../source'

/**
 * Warehouse › Locations (`/warehouse/locations`): the export of the list as the screen shows it — ONE site's tree, in
 * the tree's order (depth first, children by code). The address is the list's own (apps/factory-web areas/warehouse/
 * locations model.ts listAddressOf / chosenSite / searchRows): `?site=` (nothing: the first site of the screen's company
 * by code), `?archived=1` (archived places too), `?q=` (the code, the name or a code above it). Read through the
 * module's listLocations (inventory.locations.view) and, for a person who sees stock (inventory.stock.view), what lies
 * in each place from the stock overview (on hand per unit, never added across units). No money.
 *
 * "Full file for re-import (XLSX)": the locations importer (`inventory.locations`), keyed by the site's code and the
 * place's code.
 */

type Site = Awaited<ReturnType<typeof listLocations>>['sites'][number]
type Location = Site['locations'][number]

interface Row {
  readonly site: { readonly code: string }
  readonly location: Location
  /** Active places directly inside it. */
  readonly inside: number
  /** What lies here (null: the person does not see stock): lines and on hand per unit. */
  readonly stock: { readonly lines: number; readonly quantities: readonly { readonly uom: string; readonly quantity: string }[] } | null
  readonly locale: ExportLocale
}

interface Query {
  readonly siteId: string | null
  readonly archived: boolean
  readonly q: string
}

/** What lies in each place of a site: its stock lines and its on hand per unit. */
async function stockByPlace(caller: CommandCaller, siteId: string): Promise<Map<string, { lines: number; sums: Map<string, Decimal> }>> {
  const overview = await stockOverview(caller, { siteId })
  const result = new Map<string, { lines: number; sums: Map<string, Decimal> }>()
  for (const row of overview.rows) {
    if (row.siteId !== siteId) continue
    const entry = result.get(row.location.id) ?? { lines: 0, sums: new Map<string, Decimal>() }
    entry.lines += 1
    entry.sums.set(row.item.baseUom, (entry.sums.get(row.item.baseUom) ?? new Dec(0)).plus(row.onHand))
    result.set(row.location.id, entry)
  }
  return result
}

export const locations = defineExportSource<Query, Row>({
  listKey: 'warehouse.locations',
  permission: INVENTORY_LOCATIONS_VIEW,
  query(address) {
    const siteId = address.get('site') || null
    if (siteId && !isUuid(siteId)) throw new ValidationError('Not a site.', [{ path: 'query/site', message: 'A site id.' }])
    return { siteId, archived: address.get('archived') === '1', q: (address.get('q') ?? '').trim().slice(0, 80) }
  },
  async read(caller, query, _cursor, _limit, options) {
    const context = caller.factoryContext
    const companyId = context?.audience === 'office' ? context.companyId : undefined
    const answer = await listLocations(caller, { includeArchived: query.archived })
    const sites = answer.sites.filter((site) => !companyId || site.companyId === companyId)
    const site = sites.find((entry) => entry.id === query.siteId) ?? [...sites].sort((a, b) => a.code.localeCompare(b.code))[0]
    if (!site) return { rows: [], next: null }
    const seesStock = context ? holds(actorOf(context), INVENTORY_STOCK_VIEW) : false
    const stock = seesStock ? await stockByPlace(caller, site.id) : null
    const byId = new Map(site.locations.map((location) => [location.id, location]))
    const locale: ExportLocale = options?.locale ?? 'it'
    const needle = query.q.toLowerCase()
    const rows: Row[] = []
    for (const location of site.locations) {
      const above: string[] = []
      for (let parent = location.parentId ? byId.get(location.parentId) : undefined; parent; parent = parent.parentId ? byId.get(parent.parentId) : undefined) above.unshift(parent.code)
      if (needle && ![location.code, location.name, ...above].some((text) => text.toLowerCase().includes(needle))) continue
      const here = stock?.get(location.id)
      rows.push({
        site: { code: site.code },
        location,
        inside: site.locations.filter((other) => other.parentId === location.id && other.status === 'ACTIVE').length,
        stock: stock ? { lines: here?.lines ?? 0, quantities: [...(here?.sums ?? new Map<string, Decimal>())].filter(([, value]) => !value.isZero()).map(([uom, value]) => ({ uom, quantity: value.toFixed(4) })) } : null,
        locale,
      })
    }
    return { rows, next: null }
  },
  columns: {
    place: { value: (row) => row.location.name },
    code: { value: (row) => row.location.code },
    kind: { value: (row, words) => words(`locationKind.${row.location.kind}`) },
    status: { value: (row, words) => words(`locationStatus.${row.location.status}`) },
    stock: {
      value: (row, words) => {
        if (!row.stock) return null
        if (row.stock.lines === 0 || row.stock.quantities.length === 0) return words('empty')
        return row.stock.quantities.map((entry) => `${decimalText(entry.quantity, row.locale)} ${words(`uom.${entry.uom}`)}`).join(' · ')
      },
    },
    inside: { value: (row) => (row.inside > 0 ? row.inside : null) },
  },
  reimport: {
    importer: 'inventory.locations',
    key: (row) => ({ site: row.site.code, code: row.location.code }),
  },
  words: {
    it: {
      'locationKind.WAREHOUSE': 'Magazzino',
      'locationKind.ZONE': 'Zona',
      'locationKind.BIN': 'Cella',
      'locationKind.RECEIVING': 'Ricevimento merci',
      'locationKind.QUARANTINE': 'Scaffale quarantena',
      'locationKind.PRODUCTION': 'Bordo linea',
      'locationKind.SHIPPING': 'Spedizioni',
      'locationKind.SUBCONTRACTOR': 'Terzista',
      'locationKind.FINISHED_GOODS': 'Prodotti finiti',
      'locationStatus.ACTIVE': 'Attiva',
      'locationStatus.ARCHIVED': 'Archiviata',
      empty: 'Vuota',
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
      'locationKind.WAREHOUSE': 'Warehouse',
      'locationKind.ZONE': 'Zone',
      'locationKind.BIN': 'Bin',
      'locationKind.RECEIVING': 'Goods in',
      'locationKind.QUARANTINE': 'Quarantine shelf',
      'locationKind.PRODUCTION': 'Line side',
      'locationKind.SHIPPING': 'Shipping',
      'locationKind.SUBCONTRACTOR': 'Subcontractor',
      'locationKind.FINISHED_GOODS': 'Finished goods',
      'locationStatus.ACTIVE': 'Active',
      'locationStatus.ARCHIVED': 'Archived',
      empty: 'Empty',
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
