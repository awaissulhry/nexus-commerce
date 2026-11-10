import { COLOUR_VIEWS, type ColourView } from '@nexus/factory-domain/product/colours/rules'
import type { ColourLibraryQuery } from '@nexus/factory-domain/product/colours/contracts'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { listLibrary } from '../../../modules/product/colours/library'
import { defineExportSource } from '../source'

/**
 * Products › Libraries › Colours & artwork (SCR-118, `/products/colours`; B-W2b-247): the export of the colour library as
 * the screen shows it. The address is the list's own (apps/factory-web areas/products/colours model.ts addressOf):
 * `?view=active|unused|archived|all` (nothing: active), `?q=`, `?system=`, `?family=`. Read through the module's
 * listLibrary (product.styles.view, its companies), which also counts the view before the run. A "used by" count the reader
 * may not see (material colours without product.materials.view) is left empty. No money, no person.
 */

type Row = Awaited<ReturnType<typeof listLibrary>>['colours'][number]
type Query = Omit<ColourLibraryQuery, 'cursor' | 'limit'>

export const colours = defineExportSource<Query, Row>({
  listKey: 'products.colours',
  permission: PRODUCT_STYLES_VIEW,
  query(address) {
    const view = address.get('view') ?? 'active'
    const text = (key: string, max: number) => address.get(key)?.trim().slice(0, max) || undefined
    return { view: (COLOUR_VIEWS as readonly string[]).includes(view) ? (view as ColourView) : 'active', q: text('q', 100), system: text('system', 20), family: text('family', 40) }
  },
  async read(caller, query, cursor, limit) {
    const page = await listLibrary(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.colours, next: page.nextCursor }
  },
  async count(caller, query) {
    return (await listLibrary(caller, { ...query, limit: 1 })).count
  },
  columns: {
    code: { value: (row) => row.code },
    name: { value: (row) => [row.name, row.names.it, row.names.en].filter((name, index, all) => name && all.indexOf(name) === index).join(' / ') },
    reference: { value: (row, words) => (row.system ? `${words(`system.${row.system}`)}${row.reference ? ` ${row.reference}` : ''}` : null) },
    family: { value: (row) => row.family },
    hex: { value: (row) => row.hex },
    photo: { value: (row) => row.photo?.name ?? null },
    materials: { value: (row) => row.use.materialColours },
    colourways: { value: (row) => row.use.colourways },
    sets: { value: (row) => row.use.brandingSets },
    status: { value: (row, words) => words(`status.${row.status}`) },
  },
  words: {
    it: { 'status.ACTIVE': 'Attivo', 'status.ARCHIVED': 'Archiviato', 'system.PANTONE': 'Pantone', 'system.RAL': 'RAL', 'system.NCS': 'NCS', 'system.OWN': 'Nostro' },
    en: { 'status.ACTIVE': 'Active', 'status.ARCHIVED': 'Archived', 'system.PANTONE': 'Pantone', 'system.RAL': 'RAL', 'system.NCS': 'NCS', 'system.OWN': 'Our own' },
  },
})
