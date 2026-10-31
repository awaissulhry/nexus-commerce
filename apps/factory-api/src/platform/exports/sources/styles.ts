import type { ListStylesQuery } from '@nexus/factory-domain/product/styles/contracts'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { PPE_CATEGORIES, PRODUCT_TYPES } from '@nexus/factory-domain/product/styles/rules'
import { listStyles } from '../../../modules/product/styles/styles'
import { defineExportSource } from '../source'

/**
 * Products › Styles (SCR-040, `/products/styles`): the export of the style list as the screen shows it. The address is
 * the list's own (apps/factory-web areas/products/styles/list StylesPage filtersOf + model.ts viewQuery):
 * `?view=open|drafts|waiting|active|archived|all` (nothing: open = draft and active styles; waiting = open with a draft
 * revision waiting for its release), `?type=` (a product type), `?ppe=` (a PPE category) and `?q=`. Read through the
 * module's listStyles (product.styles.view, its companies), which also counts the view before the run. The list
 * carries no money: the screen's List price and Margin % columns come from the base price list, a read of their own,
 * and are not part of this file.
 */

type Row = Awaited<ReturnType<typeof listStyles>>['styles'][number]
type Query = Omit<ListStylesQuery, 'cursor' | 'limit'>
type ProductType = (typeof PRODUCT_TYPES)[number]
type PpeCategory = (typeof PPE_CATEGORIES)[number]

const isType = (value: string | null): value is ProductType => value !== null && (PRODUCT_TYPES as readonly string[]).includes(value)
const isPpe = (value: string | null): value is PpeCategory => value !== null && (PPE_CATEGORIES as readonly string[]).includes(value)

/** The view's own filters (web model.ts viewQuery). */
function viewFilters(view: string): Partial<Query> & Pick<Query, 'status'> {
  switch (view) {
    case 'drafts':
      return { status: 'DRAFT' }
    case 'waiting':
      return { status: 'OPEN', draftRevision: true }
    case 'active':
      return { status: 'ACTIVE' }
    case 'archived':
      return { status: 'ARCHIVED' }
    case 'all':
      return { status: 'ALL' }
    default:
      return { status: 'OPEN' }
  }
}

const with_ = (template: string, values: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (all, name: string) => (name in values ? String(values[name]) : all))

/** "44–64" for a range of codes (web model.ts rangeWords). */
const rangeWords = (sizes: readonly string[]): string => (sizes.length === 1 ? sizes[0]! : `${sizes[0]}–${sizes[sizes.length - 1]}`)

export const styles = defineExportSource<Query, Row>({
  listKey: 'products.styles',
  permission: PRODUCT_STYLES_VIEW,
  query(address) {
    const type = address.get('type')
    const ppe = address.get('ppe')
    const q = address.get('q')?.trim().slice(0, 100) || undefined
    return { ...viewFilters(address.get('view') ?? 'open'), productType: isType(type) ? [type] : undefined, ppeCategory: isPpe(ppe) ? [ppe] : undefined, q }
  },
  async read(caller, query, cursor, limit) {
    const page = await listStyles(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.styles, next: page.nextCursor }
  },
  async count(caller, query) {
    return (await listStyles(caller, { ...query, limit: 1 })).count
  },
  columns: {
    code: { value: (row) => `${row.code} · ${row.name}` },
    type: { value: (row, words) => [words(`productType.${row.productType}`), row.season, row.brand?.name].filter(Boolean).join(' · ') },
    status: { value: (row, words) => words(`status.${row.status}`) },
    revision: {
      value: (row, words) => {
        const chips = [
          ...(row.releasedRevision !== null ? [with_(words('rev.released'), { revision: row.releasedRevision })] : []),
          ...(row.draftRevision !== null ? [with_(words('rev.draft'), { revision: row.draftRevision })] : []),
        ]
        return chips.length > 0 ? chips.join(' · ') : words('noRevision')
      },
    },
    range: {
      value: (row, words) => {
        if (row.sizes.length === 0) return null
        return `${rangeWords(row.sizes)} · ${row.baseSize ? with_(words('base'), { size: row.baseSize }) : row.sizeScale.code}`
      },
    },
    skus: { value: (row) => row.skuCount },
    ppe: {
      value: (row, words) =>
        row.ppeCategory === 'NOT_PPE' ? words('ppe.NOT_PPE') : `${words(`ppe.${row.ppeCategory}`)} · ${[row.ppeStandard, row.ppeClass].filter(Boolean).join(' · ') || words('noStandard')}`,
    },
    ready: {
      value: (row, words) => {
        const entries = Object.values(row.completeness)
        return with_(words('ready'), { done: entries.filter(Boolean).length, of: entries.length })
      },
    },
    updated: { value: (row) => ({ at: row.updatedAt }) },
  },
  words: {
    it: {
      'productType.JACKET': 'Giacca',
      'productType.TROUSERS': 'Pantaloni',
      'productType.SUIT': 'Tuta',
      'productType.GLOVES': 'Guanti',
      'productType.VEST': 'Gilet',
      'productType.OTHER': 'Altro',
      'status.DRAFT': 'Bozza',
      'status.ACTIVE': 'Attivo',
      'status.ARCHIVED': 'Archiviato',
      'rev.released': 'Rev {revision} rilasciata',
      'rev.draft': 'Rev {revision} bozza',
      noRevision: 'Nessuna revisione',
      base: 'base {size}',
      'ppe.NOT_PPE': 'Non DPI',
      'ppe.CATEGORY_I': 'Cat. I',
      'ppe.CATEGORY_II': 'Cat. II',
      'ppe.CATEGORY_III': 'Cat. III',
      noStandard: 'norma non indicata',
      ready: '{done} su {of}',
    },
    en: {
      'productType.JACKET': 'Jacket',
      'productType.TROUSERS': 'Trousers',
      'productType.SUIT': 'Suit',
      'productType.GLOVES': 'Gloves',
      'productType.VEST': 'Vest',
      'productType.OTHER': 'Other',
      'status.DRAFT': 'Draft',
      'status.ACTIVE': 'Active',
      'status.ARCHIVED': 'Archived',
      'rev.released': 'Rev {revision} released',
      'rev.draft': 'Rev {revision} draft',
      noRevision: 'No revision',
      base: 'base {size}',
      'ppe.NOT_PPE': 'Not PPE',
      'ppe.CATEGORY_I': 'Cat. I',
      'ppe.CATEGORY_II': 'Cat. II',
      'ppe.CATEGORY_III': 'Cat. III',
      noStandard: 'standard not named',
      ready: '{done} of {of}',
    },
  },
})
