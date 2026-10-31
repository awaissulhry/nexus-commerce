import { ITEM_KINDS, type ItemKind } from '@nexus/factory-domain/product/materials/rules'
import { PRODUCT_MATERIALS_VIEW } from '@nexus/factory-domain/product/materials/permissions'
import { decimalText } from '@nexus/factory-domain/views/exports'
import type { ListMaterialsFilters } from '../../../modules/product/materials/contract'
import { listMaterials } from '../../../modules/product/materials/materials'
import { defineExportSource } from '../source'

/**
 * Products › Materials & trims (SCR-047, `/products/materials`): the export of the list as the screen shows it. The
 * address is the list's own (apps/factory-web areas/products/materials MaterialsPage filtersOf + model.ts listQuery):
 * `?view=open|leather|textiles|trims|protectors|labels|missingCost|crvi|ppe|archived|all` (nothing: open = the active
 * materials), `?kind=` (one kind, narrowed inside the view's kinds) and `?q=`. Read through the module's listMaterials
 * (product.materials.view, its companies), which also counts the view before the run. The standard cost is the cost
 * grain (a decimal per base unit, as the record keeps it): absent from the file without it; listMaterials refuses the
 * "Missing cost" view to a person without the grain, in words.
 *
 * "Full file for re-import (XLSX)": the material importer's layout (product.materials, key: the code).
 */

type Row = Awaited<ReturnType<typeof listMaterials>>['materials'][number]
type Query = Omit<ListMaterialsFilters, 'cursor' | 'limit'>

const KIND_GROUPS: Readonly<Record<string, readonly ItemKind[]>> = Object.freeze({
  leather: ['LEATHER'],
  textiles: ['TEXTILE', 'LINING', 'MEMBRANE', 'PADDING'],
  trims: ['TRIM', 'HARDWARE', 'THREAD', 'COMPONENT'],
  protectors: ['PROTECTOR'],
  labels: ['LABEL', 'PACKAGING'],
})

const isKind = (value: string | null): value is ItemKind => value !== null && (ITEM_KINDS as readonly string[]).includes(value)

/** The view's own filters (web model.ts viewQuery). */
function viewFilters(view: string): Partial<Query> & Pick<Query, 'status'> {
  const kinds = Object.hasOwn(KIND_GROUPS, view) ? KIND_GROUPS[view] : undefined
  if (kinds) return { status: 'ACTIVE', kind: [...kinds] }
  switch (view) {
    case 'missingCost':
      return { status: 'ACTIVE', missingCost: true }
    case 'crvi':
      return { status: 'ACTIVE', requiresCrViTest: true }
    case 'ppe':
      return { status: 'ACTIVE', ppeComponent: true }
    case 'archived':
      return { status: 'ARCHIVED' }
    case 'all':
      return { status: 'ALL' }
    default:
      return { status: 'ACTIVE' }
  }
}

/** Bought → stocked → used, a unit shown once when two in a row are the same ("hide → ft² → dm²"). */
function unitsText(row: Row, words: (code: string) => string): string {
  const units = [row.purchaseUom, row.baseUom, row.consumptionUom].filter((uom, index, all) => index === 0 || uom !== all[index - 1]).map((uom) => words(`uom.${uom}`))
  return `${units.join(' → ')} · ${words(`tracking.${row.tracking}`)}`
}

const with_ = (template: string, name: string, value: string): string => template.replace(`{${name}}`, value)

export const materials = defineExportSource<Query, Row>({
  listKey: 'products.materials',
  permission: PRODUCT_MATERIALS_VIEW,
  query(address) {
    const base = viewFilters(address.get('view') ?? 'open')
    const kind = address.get('kind')
    const narrowed = isKind(kind) ? (base.kind ? (base.kind.includes(kind) ? [kind] : base.kind) : [kind]) : base.kind
    const q = address.get('q')?.trim().slice(0, 100) || undefined
    return { ...base, kind: narrowed, q }
  },
  async read(caller, query, cursor, limit) {
    const page = await listMaterials(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.materials, next: page.nextCursor }
  },
  async count(caller, query) {
    return (await listMaterials(caller, { ...query, limit: 1 })).count
  },
  columns: {
    code: { value: (row) => `${row.code} · ${row.name}` },
    kind: { value: (row, words) => `${words(`kind.${row.kind}`)} · ${words(`sourcing.${row.sourcing}`)}` },
    units: { value: (row, words) => unitsText(row, words) },
    supplier: {
      value: (row, words) =>
        row.defaultSupplier
          ? `${row.defaultSupplier.name} · ${row.supplierArticleCode ? with_(words('list.theirCode'), 'code', row.supplierArticleCode) : row.defaultSupplier.code}`
          : row.sourcing === 'MAKE'
            ? words('list.made')
            : words('list.noSupplier'),
    },
    colours: { value: (row) => row.colourCount },
    cost: { grain: 'cost', value: (row) => (typeof row.standardCost === 'string' ? { decimal: row.standardCost } : null) },
    compliance: {
      value: (row, words) => {
        const lang = words('lang') === 'en' ? 'en' : 'it'
        const parts: string[] = []
        if (row.requiresCrViTest && row.crViLimitMgKg) parts.push(with_(words('list.crvi'), 'limit', `≤ ${decimalText(row.crViLimitMgKg, lang)} mg/kg`))
        if (row.isPpeComponent) parts.push(words('list.ppe'))
        return parts.length > 0 ? parts.join(', ') : null
      },
    },
    status: { value: (row, words) => words(`status.${row.status}`) },
  },
  reimport: { importer: 'product.materials', key: (row) => ({ code: row.code }) },
  words: {
    it: {
      lang: 'it',
      'kind.LEATHER': 'Pelle',
      'kind.TEXTILE': 'Tessuto',
      'kind.LINING': 'Fodera',
      'kind.MEMBRANE': 'Membrana',
      'kind.PADDING': 'Imbottitura',
      'kind.THREAD': 'Filo',
      'kind.TRIM': 'Accessorio',
      'kind.HARDWARE': 'Minuteria',
      'kind.PROTECTOR': 'Protezione',
      'kind.LABEL': 'Etichetta',
      'kind.PACKAGING': 'Imballo',
      'kind.COMPONENT': 'Componente',
      'sourcing.BUY': 'Acquistato',
      'sourcing.MAKE': 'Prodotto internamente',
      'sourcing.MAKE_OR_BUY': 'Prodotto o acquistato',
      'tracking.NONE': 'Non tracciato',
      'tracking.LOT': 'A lotto',
      'tracking.HIDE': 'Pelle per pelle',
      'tracking.SERIAL': 'A matricola',
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
      'uom.HIDE': 'pelle',
      'uom.SIDE': 'mezzina',
      'uom.ROLL': 'rotolo',
      'uom.CONE': 'cono',
      'uom.BOX': 'scatola',
      'list.theirCode': 'loro codice {code}',
      'list.made': 'Prodotto internamente',
      'list.noSupplier': 'Nessun fornitore predefinito',
      'list.crvi': 'Cr VI {limit}',
      'list.ppe': 'Componente DPI',
      'status.ACTIVE': 'Attivo',
      'status.ARCHIVED': 'Archiviato',
    },
    en: {
      lang: 'en',
      'kind.LEATHER': 'Leather',
      'kind.TEXTILE': 'Fabric',
      'kind.LINING': 'Lining',
      'kind.MEMBRANE': 'Membrane',
      'kind.PADDING': 'Padding',
      'kind.THREAD': 'Thread',
      'kind.TRIM': 'Trim',
      'kind.HARDWARE': 'Hardware',
      'kind.PROTECTOR': 'Protector',
      'kind.LABEL': 'Label',
      'kind.PACKAGING': 'Packaging',
      'kind.COMPONENT': 'Component',
      'sourcing.BUY': 'Bought',
      'sourcing.MAKE': 'Made here',
      'sourcing.MAKE_OR_BUY': 'Made or bought',
      'tracking.NONE': 'Not traced',
      'tracking.LOT': 'By lot',
      'tracking.HIDE': 'Hide by hide',
      'tracking.SERIAL': 'By serial',
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
      'uom.HIDE': 'hide',
      'uom.SIDE': 'side',
      'uom.ROLL': 'roll',
      'uom.CONE': 'cone',
      'uom.BOX': 'box',
      'list.theirCode': 'their code {code}',
      'list.made': 'Made here',
      'list.noSupplier': 'No default supplier',
      'list.crvi': 'Cr VI {limit}',
      'list.ppe': 'PPE component',
      'status.ACTIVE': 'Active',
      'status.ARCHIVED': 'Archived',
    },
  },
})
