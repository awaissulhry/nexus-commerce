import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import type { BomLine, BomView, BrandRow, ColourRow, CostDiffView, CostSheetView, MaterialView, OperationRow, RoutingView, ScaleRow, StyleComplianceView, StyleRow, StyleView } from '../api'
import type { Grains, StyleAbilities } from '../model'
import type { StyleRecordViewModel } from '../record/record-model'

/**
 * Made-up data for the Styles design cases (PLAN §3.1): an invented factory, jacket, colours, materials, operations,
 * certificate and people — never a real business record. Every figure is worked out by hand in the comments where a
 * screen adds them up. This file only exports builders (no screen of its own): the SCR-040 … SCR-045 fixtures use it.
 */

export const PREFIX = '/w/DEMO'
export const COMPANY_ID = '0190f0e2-1111-7000-8000-000000000001'
export const STYLE_ID = '0190f0e2-7777-7000-8000-000000000101'
const SCALE_ID = '0190f0e2-7777-7000-8000-000000000201'
const LETTERS_ID = '0190f0e2-7777-7000-8000-000000000202'
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`

// ---- who is looking -----------------------------------------------------------------------------------------------------

const NONE: StyleAbilities = {
  view: false,
  manage: false,
  bomView: false,
  bomManage: false,
  release: false,
  routingView: false,
  routingManage: false,
  costView: false,
  complianceView: false,
  declarations: false,
  labels: false,
  materials: false,
  brands: false,
  thread: false,
}

/** The Owner (every right, every grain), a product / technical office person (makes the style, sees cost), the production
 * manager (makes BOM and routing, no money), sales (reads the style and the cost structure, no cost figures). */
export const CAN: Record<'owner' | 'product' | 'production' | 'sales' | 'viewer', StyleAbilities> = {
  owner: { view: true, manage: true, bomView: true, bomManage: true, release: true, routingView: true, routingManage: true, costView: true, complianceView: true, declarations: true, labels: true, materials: true, brands: true, thread: true },
  product: { view: true, manage: true, bomView: true, bomManage: true, release: true, routingView: true, routingManage: true, costView: true, complianceView: true, declarations: false, labels: false, materials: true, brands: true, thread: true },
  production: { ...NONE, view: true, manage: true, bomView: true, bomManage: true, release: true, routingView: true, routingManage: true, costView: true, complianceView: true, materials: true, thread: true },
  sales: { ...NONE, view: true, costView: true, materials: true, brands: true, thread: true },
  viewer: { ...NONE, view: true, bomView: true, routingView: true, complianceView: true, materials: true, thread: true },
}

export const GRAINS: Record<'owner' | 'product' | 'production' | 'sales', Grains> = {
  owner: { cost: true, price: true, margin: true },
  product: { cost: true, price: false, margin: false },
  production: { cost: false, price: false, margin: false },
  sales: { cost: false, price: true, margin: true },
}

// ---- libraries ----------------------------------------------------------------------------------------------------------

export const SIZES = ['46', '48', '50', '52', '54', '56', '58']

export const SCALES: ScaleRow[] = [
  { id: SCALE_ID, companyId: null, code: 'EU-46-58', name: 'Giacche EU 46–58 (demo)', codes: ['44', ...SIZES, '60'], styleCount: 4, status: 'ACTIVE', version: 3, updatedAt: at(2, 9) },
  { id: LETTERS_ID, companyId: null, code: 'LETTERE', name: 'Lettere XS–3XL (demo)', codes: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'], styleCount: 2, status: 'ACTIVE', version: 1, updatedAt: at(2, 9) },
]

const colour = (n: number, code: string, name: string, hex: string): ColourRow => ({ id: uid('5555', n), companyId: null, code, name, hex, status: 'ACTIVE' })
export const COLOURS: ColourRow[] = [colour(1, 'NERO', 'Nero', '#1C1C1E'), colour(2, 'ANTR', 'Antracite', '#4A4D52'), colour(3, 'ROSSO', 'Rosso corsa', '#B3261E'), colour(4, 'SABB', 'Sabbia', '#C8B48A')]

export const BRANDS: BrandRow[] = [{ id: uid('6666', 1), code: 'BR-DEMO', legalName: 'Marchio Esempio S.r.l.', tradeName: 'Esempio Moto' }]

// ---- the style --------------------------------------------------------------------------------------------------------

const CW = { BLK: uid('7777', 11), ANT: uid('7777', 12), RED: uid('7777', 13), SND: uid('7777', 14) }
export const COLOURWAY_IDS = CW
export const REV = { r1: uid('7777', 21), r2: uid('7777', 22), r3: uid('7777', 23) }

type Revision = StyleView['revisions'][number]
const revision = (id: string, n: number, status: Revision['status'], extra: Partial<Revision> = {}): Revision => ({
  id,
  revision: n,
  status,
  changeNote: null,
  labelTemplateId: null,
  releasedAt: null,
  releasedById: null,
  version: 3,
  createdAt: at(1 + n * 3, 9),
  createdById: uid('3333', 1),
  updatedAt: at(1 + n * 3, 16),
  ...extra,
})

export const REVISIONS: Revision[] = [
  revision(REV.r3, 3, 'DRAFT', { changeNote: 'Ginocchiere e gomitiere livello 2; cerniera a contrasto.', version: 7 }),
  revision(REV.r2, 2, 'RELEASED', { releasedAt: at(12, 15), releasedById: uid('3333', 1), labelTemplateId: uid('8888', 1), changeNote: 'Membrana impermeabile in tutto il busto.' }),
  revision(REV.r1, 1, 'OBSOLETE', { releasedAt: at(5, 11), releasedById: uid('3333', 1) }),
]

interface StyleOptions {
  status?: StyleView['status']
  /** Cells left without a SKU (`BLK:58`). */
  missing?: string[]
  /** Cells switched off. */
  off?: string[]
  revisions?: Revision[]
  ppe?: Pick<StyleView, 'ppeCategory' | 'ppeStandard' | 'ppeClass'>
  extraColourway?: boolean
}

const COLOURWAYS: Array<{ key: keyof typeof CW; code: string; name: string; colour: ColourRow; description: string | null; status: 'ACTIVE' | 'ARCHIVED' }> = [
  { key: 'BLK', code: 'NERO', name: 'Nero', colour: COLOURS[0]!, description: 'Cuciture tono su tono, logo riflettente sul retro.', status: 'ACTIVE' },
  { key: 'ANT', code: 'ANTR', name: 'Antracite', colour: COLOURS[1]!, description: 'Pannelli spalla neri.', status: 'ACTIVE' },
  { key: 'RED', code: 'ROSSO', name: 'Rosso corsa', colour: COLOURS[2]!, description: 'Fianchi neri, cerniera nera.', status: 'ACTIVE' },
  { key: 'SND', code: 'SABB', name: 'Sabbia', colour: COLOURS[3]!, description: null, status: 'ARCHIVED' },
]

export function demoStyle(options: StyleOptions = {}): StyleView {
  const missing = new Set(options.missing ?? [])
  const off = new Set(options.off ?? ['ANTR:58'])
  const colourways = COLOURWAYS.filter((entry) => entry.key !== 'SND' || options.extraColourway !== false)
  const skuId = (code: string, size: string) => `0190f0e2-9${String(colourways.findIndex((entry) => entry.code === code)).padStart(3, '0')}-7000-8000-0000000000${size}`
  const skus: StyleView['skus'] = []
  for (const entry of colourways) {
    for (const size of SIZES) {
      const key = `${entry.code}:${size}`
      if (missing.has(key)) continue
      skus.push({
        id: skuId(entry.code, size),
        colourwayId: CW[entry.key],
        colourwayCode: entry.code,
        size,
        sku: `DEMO-JKT-01-${entry.code}-${size}`,
        gtin: entry.key === 'BLK' && size === '52' ? '8000000000017' : null,
        status: entry.status === 'ARCHIVED' || off.has(key) ? 'ARCHIVED' : 'ACTIVE',
        version: 2,
        offered: entry.status === 'ACTIVE',
        createdAt: at(4, 10),
        updatedAt: at(9, 10),
      })
    }
  }
  const active = skus.filter((sku) => sku.status === 'ACTIVE')
  const revisions = options.revisions ?? REVISIONS
  const ppe = options.ppe ?? { ppeCategory: 'CATEGORY_II' as const, ppeStandard: 'EN 17092-4:2020', ppeClass: 'A' }
  const missingCount = colourways.filter((entry) => entry.status === 'ACTIVE').reduce((sum, entry) => sum + SIZES.filter((size) => missing.has(`${entry.code}:${size}`)).length, 0)
  return {
    id: STYLE_ID,
    companyId: COMPANY_ID,
    code: 'DEMO-JKT-01',
    name: 'Giacca Touring Demo',
    nameI18n: null,
    productType: 'JACKET',
    season: 'FW27',
    brand: null,
    sizeScale: { id: SCALE_ID, code: 'EU-46-58', name: 'Giacche EU 46–58 (demo)' },
    sizes: [...SIZES],
    baseSize: '52',
    ...ppe,
    mtmAllowed: false,
    status: options.status ?? 'ACTIVE',
    version: 9,
    updatedAt: at(28, 16, 40),
    colourwayCount: colourways.filter((entry) => entry.status === 'ACTIVE').length,
    skuCount: active.length,
    revisionState: revisions.some((entry) => entry.status === 'RELEASED') ? 'RELEASED' : revisions.some((entry) => entry.status === 'DRAFT') ? 'DRAFT' : 'NONE',
    releasedRevision: revisions.find((entry) => entry.status === 'RELEASED')?.revision ?? null,
    draftRevision: revisions.find((entry) => entry.status === 'DRAFT')?.revision ?? null,
    completeness: { colourways: true, sizeRange: true, baseSize: true, skus: active.length > 0, releasedRevision: revisions.some((entry) => entry.status === 'RELEASED') },
    description: 'Giacca da turismo in pelle bovina 1,2 mm con membrana impermeabile e protezioni EN 1621-1 a spalle e gomiti.',
    measurementTemplate: null,
    tracking: ppe.ppeCategory === 'NOT_PPE' ? 'NONE' : 'LOT',
    garmentTracking: 'BATCH',
    range: SIZES.map((size, index) => ({
      code: size,
      label: size === '52' ? '52 (L)' : null,
      status: 'ACTIVE' as const,
      bodyMeasures: {
        torace: { min: String(90 + index * 4), max: String(93 + index * 4), unit: 'cm' as const },
        altezza: { min: String(170 + index * 2), max: String(176 + index * 2), unit: 'cm' as const },
      },
    })),
    colourways: colourways.map((entry) => ({
      id: CW[entry.key],
      code: entry.code,
      name: entry.name,
      colour: { id: entry.colour.id, code: entry.colour.code, name: entry.colour.name, hex: entry.colour.hex },
      description: entry.description,
      status: entry.status,
      version: 2,
      offeredSizes: entry.status === 'ACTIVE' ? SIZES.filter((size) => !off.has(`${entry.code}:${size}`) && !missing.has(`${entry.code}:${size}`)) : [],
      inUse: entry.key !== 'SND',
      createdAt: at(3, 10),
      updatedAt: at(9, 10),
    })),
    matrix: {
      sizes: SIZES.map((size) => ({ code: size, label: size === '52' ? '52 (L)' : size })),
      rows: colourways.map((entry) => ({
        colourwayId: CW[entry.key],
        code: entry.code,
        name: entry.name,
        status: entry.status,
        cells: SIZES.map((size) => {
          const sku = skus.find((row) => row.colourwayCode === entry.code && row.size === size)
          return { size, offered: entry.status === 'ACTIVE', sku: sku ? { id: sku.id, sku: sku.sku, gtin: sku.gtin, status: sku.status, version: sku.version } : null }
        }),
      })),
      generated: skus.length > 0,
      missing: missingCount,
    },
    skus,
    revisions,
    warnings: [
      ...(missingCount > 0 ? [{ code: 'SKUS_MISSING' as const, message: 'x' }] : []),
      ...(ppe.ppeCategory !== 'NOT_PPE' && !ppe.ppeStandard ? [{ code: 'NO_PPE_STANDARD' as const, message: 'x' }] : []),
    ],
    createdAt: at(3, 9),
    createdById: uid('3333', 1),
  }
}

/** A brand-new style: revision 1 empty, no colourway, no range yet. */
export function newStyle(): StyleView {
  const base = demoStyle({ revisions: [revision(REV.r1, 1, 'DRAFT', { version: 1 })] })
  return {
    ...base,
    code: 'DEMO-PNT-02',
    name: 'Pantalone Estivo Demo',
    productType: 'TROUSERS',
    status: 'DRAFT',
    sizes: [],
    baseSize: null,
    range: [],
    colourways: [],
    skus: [],
    skuCount: 0,
    colourwayCount: 0,
    matrix: { sizes: [], rows: [], generated: false, missing: 0 },
    revisionState: 'DRAFT',
    releasedRevision: null,
    draftRevision: 1,
    completeness: { colourways: false, sizeRange: false, baseSize: false, skus: false, releasedRevision: false },
    ppeStandard: null,
    ppeClass: null,
    description: null,
    warnings: [
      { code: 'NO_SIZE_RANGE', message: 'x' },
      { code: 'NO_COLOURWAY', message: 'x' },
      { code: 'NO_PPE_STANDARD', message: 'x' },
    ],
  }
}

// ---- the list rows ----------------------------------------------------------------------------------------------------

const row = (n: number, code: string, name: string, extra: Partial<StyleRow>): StyleRow => ({
  id: uid('7777', 300 + n),
  companyId: COMPANY_ID,
  code,
  name,
  nameI18n: null,
  productType: 'JACKET',
  season: 'FW27',
  brand: null,
  sizeScale: { id: SCALE_ID, code: 'EU-46-58', name: 'Giacche EU 46–58 (demo)' },
  sizes: SIZES,
  baseSize: '52',
  ppeCategory: 'CATEGORY_II',
  ppeStandard: 'EN 17092-4:2020',
  ppeClass: 'A',
  mtmAllowed: false,
  status: 'ACTIVE',
  version: 4,
  updatedAt: at(20 + (n % 8), 10 + (n % 6)),
  colourwayCount: 3,
  skuCount: 20,
  revisionState: 'RELEASED',
  releasedRevision: 2,
  draftRevision: null,
  completeness: { colourways: true, sizeRange: true, baseSize: true, skus: true, releasedRevision: true },
  ...extra,
})

export const ROWS: StyleRow[] = [
  { ...row(1, 'DEMO-JKT-01', 'Giacca Touring Demo', { releasedRevision: 2, draftRevision: 3 }), id: STYLE_ID },
  row(2, 'DEMO-JKT-02', 'Giacca Racing Demo', { ppeStandard: 'EN 17092-2:2020', ppeClass: 'AAA', skuCount: 14, colourwayCount: 2 }),
  row(3, 'DEMO-JKT-03', 'Giubbotto Urban Demo', { ppeStandard: 'EN 17092-5:2020', ppeClass: 'B', season: 'SS28', releasedRevision: 1, brand: { id: BRANDS[0]!.id, code: 'BR-DEMO', name: 'Esempio Moto' } }),
  row(4, 'DEMO-PNT-01', 'Pantalone Touring Demo', { productType: 'TROUSERS', ppeStandard: 'EN 17092-4:2020', ppeClass: 'A', skuCount: 12, colourwayCount: 2 }),
  row(5, 'DEMO-PNT-02', 'Pantalone Estivo Demo', {
    productType: 'TROUSERS',
    status: 'DRAFT',
    revisionState: 'DRAFT',
    releasedRevision: null,
    draftRevision: 1,
    sizes: [],
    baseSize: null,
    skuCount: 0,
    colourwayCount: 0,
    ppeStandard: null,
    ppeClass: null,
    completeness: { colourways: false, sizeRange: false, baseSize: false, skus: false, releasedRevision: false },
  }),
  row(6, 'DEMO-GLV-01', 'Guanto Sport Demo', { productType: 'GLOVES', ppeStandard: 'EN 13594:2015', ppeClass: '1KP', sizes: ['S', 'M', 'L', 'XL'], baseSize: 'L', sizeScale: { id: LETTERS_ID, code: 'LETTERE', name: 'Lettere XS–3XL (demo)' }, skuCount: 8, colourwayCount: 2 }),
  row(7, 'DEMO-SUT-01', 'Tuta Pista Demo', { productType: 'SUIT', ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-2:2020', ppeClass: 'AAA', status: 'DRAFT', revisionState: 'DRAFT', releasedRevision: null, draftRevision: 2, completeness: { colourways: true, sizeRange: true, baseSize: true, skus: true, releasedRevision: false } }),
  row(8, 'DEMO-VST-01', 'Gilet Alta Visibilità Demo', { productType: 'VEST', ppeCategory: 'NOT_PPE', ppeStandard: null, ppeClass: null, season: 'SS28', skuCount: 6, colourwayCount: 1 }),
  row(9, 'DEMO-JKT-90', 'Giacca Vintage Demo', { status: 'ARCHIVED', season: 'FW24', releasedRevision: 4 }),
]

// ---- the BOM of revision 3 ----------------------------------------------------------------------------------------------

type Uom = BomLine['uom']
interface LineSpec {
  n: number
  code: string
  name: string
  kind: BomLine['item']['kind']
  baseUom: Uom
  uom?: Uom
  placement: string
  qty: string
  wastagePct: string
  bySize?: Record<string, string | null>
  colours?: Record<string, string | null>
  oneColour?: string
  colourway?: keyof typeof CW
  note?: string
}

const itemColour = (lineN: number, code: string) => ({ id: uid('4444', 100 + lineN * 10 + ['NERO', 'ANTR', 'ROSSO'].indexOf(code) + 1), code, name: code === 'NERO' ? 'Nero' : code === 'ANTR' ? 'Antracite' : code === 'ROSSO' ? 'Rosso' : code, status: 'ACTIVE' as const })
const grossOf = (qty: string, pct: string) => (Number(qty) * (1 + Number(pct) / 100)).toFixed(4).replace(/\.?0+$/, '')

function line(spec: LineSpec): BomLine {
  const sizeDependent = !!spec.bySize
  const colourDependent = !!spec.colours
  return {
    id: uid('4444', spec.n),
    seq: spec.n * 10,
    item: { id: uid('4400', spec.n), code: spec.code, name: spec.name, kind: spec.kind, status: 'ACTIVE', baseUom: spec.baseUom },
    placement: spec.placement,
    qty: spec.qty,
    uom: spec.uom ?? spec.baseUom,
    wastagePct: spec.wastagePct,
    sizeDependent,
    colourDependent,
    itemColour: spec.oneColour ? itemColour(spec.n, spec.oneColour) : null,
    colourway: spec.colourway ? { id: CW[spec.colourway], code: spec.colourway === 'RED' ? 'ROSSO' : spec.colourway, name: 'Rosso corsa' } : null,
    supplier: null,
    note: spec.note ?? null,
    sizes: sizeDependent ? SIZES.flatMap((size) => (spec.bySize![size] === null || spec.bySize![size] === undefined ? [] : [{ size, qty: spec.bySize![size]! }])) : [],
    colours: colourDependent
      ? (['BLK', 'ANT', 'RED'] as const).flatMap((key) => {
          const code = spec.colours![key]
          return code ? [{ colourwayId: CW[key], itemColour: itemColour(spec.n, code) }] : []
        })
      : [],
    bySize: SIZES.map((size) => {
      const qty = sizeDependent ? (spec.bySize![size] ?? null) : spec.qty
      return { size, qty, gross: qty === null ? null : grossOf(qty, spec.wastagePct), base: qty === null ? null : grossOf(qty, spec.wastagePct) }
    }),
    version: 2,
    createdAt: at(15, 10),
    updatedAt: at(27, 11),
  }
}

/** Leather by size (ft² per garment, base size 52 = 7.4 ft²): +0.35 ft² a size up, the 58 left blank in the draft. */
const LEATHER: Record<string, string | null> = { '46': '6.35', '48': '6.70', '50': '7.05', '52': '7.40', '54': '7.75', '56': '8.10', '58': null }

export function demoLines(complete = false): BomLine[] {
  return [
    line({ n: 1, code: 'PEL-BOV-12', name: 'Pelle bovina 1,1–1,3 mm (demo)', kind: 'LEATHER', baseUom: 'FT2', placement: 'Busto e maniche', qty: '7.4', wastagePct: '18', bySize: complete ? { ...LEATHER, '58': '8.45' } : LEATHER, colours: { BLK: 'NERO', ANT: 'ANTR', RED: 'ROSSO' } }),
    line({ n: 2, code: 'FOD-MESH', name: 'Fodera rete traspirante (demo)', kind: 'LINING', baseUom: 'M', placement: 'Fodera', qty: '1.6', wastagePct: '5', oneColour: 'NERO' }),
    line({ n: 3, code: 'MEM-WP-3L', name: 'Membrana impermeabile 3 strati (demo)', kind: 'MEMBRANE', baseUom: 'M', placement: 'Busto', qty: '1.4', wastagePct: '8' }),
    line({ n: 4, code: 'PROT-SPAL-L2', name: 'Protezione spalla EN 1621-1 liv. 2 (demo)', kind: 'PROTECTOR', baseUom: 'PCS', placement: 'Tasche spalle', qty: '2', wastagePct: '0' }),
    line({ n: 5, code: 'PROT-GOM-L2', name: 'Protezione gomito EN 1621-1 liv. 2 (demo)', kind: 'PROTECTOR', baseUom: 'PCS', placement: 'Tasche gomiti', qty: '2', wastagePct: '0' }),
    line({ n: 6, code: 'ZIP-DIV-8', name: 'Cerniera divisibile n. 8 (demo)', kind: 'TRIM', baseUom: 'PCS', placement: 'Chiusura frontale', qty: '1', wastagePct: '0', colours: complete ? { BLK: 'NERO', ANT: 'NERO', RED: 'NERO' } : { BLK: 'NERO', ANT: null, RED: 'NERO' } }),
    line({ n: 7, code: 'FILO-40', name: 'Filo poliestere n. 40 (demo)', kind: 'THREAD', baseUom: 'M', placement: 'Cuciture', qty: '180', wastagePct: '10', colours: { BLK: 'NERO', ANT: 'ANTR', RED: 'ROSSO' } }),
    line({ n: 8, code: 'ETI-CURA', name: 'Etichetta composizione e cura (demo)', kind: 'LABEL', baseUom: 'PCS', placement: 'Fodera interna', qty: '1', wastagePct: '0' }),
  ]
}

const STYLE_REF = { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: COMPANY_ID }

export function demoBom(options: { revision?: Revision; complete?: boolean; empty?: boolean } = {}): BomView {
  const rev = options.revision ?? REVISIONS[0]!
  const lines = options.empty ? [] : demoLines(options.complete || rev.status !== 'DRAFT')
  const draft = rev.status === 'DRAFT' && !options.complete && !options.empty
  const issues: BomView['issues'] = options.empty
    ? [
        { code: 'NO_LINES', lineId: null, size: null, colourwayId: null, stepId: null, message: 'x' },
        { code: 'NO_STEPS', lineId: null, size: null, colourwayId: null, stepId: null, message: 'x' },
      ]
    : draft
      ? [
          { code: 'SIZE_QUANTITY_MISSING', lineId: uid('4444', 1), size: '58', colourwayId: null, stepId: null, message: 'x' },
          { code: 'COLOUR_MISSING', lineId: uid('4444', 6), size: null, colourwayId: CW.ANT, stepId: null, message: 'x' },
        ]
      : []
  return {
    revision: { id: rev.id, styleId: STYLE_ID, revision: rev.revision, status: rev.status, changeNote: rev.changeNote, plannedHideYieldPct: rev.status === 'DRAFT' ? '82' : '80', labelTemplateId: rev.labelTemplateId, releasedAt: rev.releasedAt, releasedById: rev.releasedById, version: rev.version, createdAt: rev.createdAt, updatedAt: rev.updatedAt },
    style: { ...STYLE_REF, status: 'ACTIVE', baseSize: '52' },
    sizes: SIZES.map((size) => ({ code: size, label: size })),
    colourways: [
      { id: CW.BLK, code: 'NERO', name: 'Nero', status: 'ACTIVE' },
      { id: CW.ANT, code: 'ANTR', name: 'Antracite', status: 'ACTIVE' },
      { id: CW.RED, code: 'ROSSO', name: 'Rosso corsa', status: 'ACTIVE' },
    ],
    lines,
    requirements: [],
    issues,
    warnings: [],
    releasable: rev.status === 'DRAFT' && issues.length === 0,
  }
}

// ---- the routing of revision 3 (standard minutes per garment; total 96.5 = 12.5 + 64 + 9 + 6 + 5) ---------------------------

const OPS: Array<[string, string, RoutingView['steps'][number]['workCentreKind'], string, string | null, string | null, boolean]> = [
  // code, name, kind, minutes, machine, skill, scanned
  ['TAG-PEL', 'Taglio pelle', 'CUTTING', '9.5', 'Tavolo taglio', 'Tagliatore', true],
  ['TAG-FOD', 'Taglio fodera e membrana', 'CUTTING', '3', 'Taglio automatico', null, false],
  ['CUC-SPA', 'Cucitura spalle e fianchi', 'SEWING', '14', 'Piana 1 ago', 'Cucitrice', false],
  ['CUC-MAN', 'Montaggio maniche', 'SEWING', '18.5', 'Colonna', 'Cucitrice esperta', true],
  ['CUC-ZIP', 'Applicazione cerniera', 'SEWING', '9.5', 'Piana 2 aghi', 'Cucitrice', false],
  ['CUC-FOD', 'Cucitura fodera e membrana', 'SEWING', '22', 'Piana 1 ago', 'Cucitrice', true],
  ['ASS-PROT', 'Inserimento protezioni', 'ASSEMBLY', '9', null, null, false],
  ['FIN-STI', 'Rifinitura e stiro', 'FINISHING', '6', 'Pressa', null, false],
  ['CQ-FIN', 'Controllo finale', 'INSPECTION', '5', null, 'Ispettore', true],
]

export function demoRouting(options: { revision?: Revision; differs?: boolean; empty?: boolean } = {}): RoutingView {
  const rev = options.revision ?? REVISIONS[0]!
  const steps = options.empty
    ? []
    : OPS.map(([code, name, kind, minutes, machine, skill, scanned], index) => ({
        id: uid('2222', index + 1),
        seq: (index + 1) * 10,
        operation: { id: uid('2200', index + 1), code, name, status: 'ACTIVE' as const, machineType: machine, skill, standardMinutes: options.differs && code === 'CUC-MAN' ? '17' : minutes },
        code,
        name,
        nameI18n: null,
        workCentreKind: kind,
        standardMinutes: minutes,
        differsFromLibrary: !!options.differs && code === 'CUC-MAN',
        scanRequired: scanned,
        final: code === 'CQ-FIN',
        instructions: code === 'CUC-MAN' ? 'Ago 110, punto 3,5 mm; fermare a 1 cm dal fondo.' : null,
        version: 1,
        createdAt: at(16, 9),
        updatedAt: at(27, 9),
      }))
  const byKind = new Map<string, { minutes: number; steps: number }>()
  for (const step of steps) {
    const entry = byKind.get(step.workCentreKind) ?? { minutes: 0, steps: 0 }
    entry.minutes += Number(step.standardMinutes)
    entry.steps += 1
    byKind.set(step.workCentreKind, entry)
  }
  const total = steps.reduce((sum, step) => sum + Number(step.standardMinutes), 0)
  return {
    revision: demoBom({ revision: rev }).revision,
    style: { ...STYLE_REF, status: 'ACTIVE' },
    sizes: SIZES.map((size) => ({ code: size, label: size })),
    steps,
    minutes: {
      perGarment: String(total),
      byKind: [...byKind.entries()].map(([workCentreKind, entry]) => ({ workCentreKind: workCentreKind as RoutingView['steps'][number]['workCentreKind'], minutes: String(entry.minutes), steps: entry.steps })),
      bySize: SIZES.map((size) => ({ size, minutes: String(total) })),
      steps: steps.length,
      scanPoints: steps.filter((step) => step.scanRequired).length,
    },
    finalStepId: steps.find((step) => step.final)?.id ?? null,
    issues: options.empty ? [{ code: 'NO_STEPS', stepId: null, message: 'x' }] : [],
    warnings: [],
    editable: rev.status === 'DRAFT',
  }
}

// ---- compliance of the style (certificate DEMO-0001 covers 46–56 in every colourway; 58 is not covered) ------------------

const CERT = { id: uid('1212', 1), number: 'CERT-DEMO-0001', standard: 'EN 17092-4:2020', ppeClass: 'A', notifiedBodyNumber: '0000', validFrom: '2025-03-01', validTo: '2026-12-15', status: 'VALID' as const }

export function demoCompliance(options: { revision?: Revision; docs?: 'current' | 'missing' | 'older'; notPpe?: boolean; label?: boolean } = {}): StyleComplianceView {
  const rev = options.revision ?? REVISIONS[1]!
  const notPpe = !!options.notPpe
  const cells: StyleComplianceView['coverage']['cells'] = notPpe
    ? []
    : (['BLK', 'ANT', 'RED'] as const).flatMap((key) =>
        SIZES.map((size) => {
          const covered = size !== '58'
          return {
            colourwayId: CW[key],
            size,
            label: size,
            offered: !(key === 'ANT' && size === '58'),
            status: covered ? ('COVERED' as const) : ('NOT_COVERED' as const),
            certificate: covered ? CERT : null,
            coverageId: covered ? uid('1313', 1) : null,
            daysToExpiry: covered ? 47 : null,
            expiringSoon: covered,
            message: 'x',
            reasons: covered ? [] : [{ code: 'size_not_covered' as const, message: 'x', certificateId: CERT.id }],
          }
        }),
      )
  const docs = options.docs ?? 'current'
  const doc = (kind: 'DECLARATION_OF_CONFORMITY' | 'USER_INFORMATION', language: string, n: number): StyleComplianceView['documents']['declarations'][number] => {
    const state = docs === 'current' || (docs === 'older' && language === 'it' && kind === 'USER_INFORMATION') ? 'CURRENT' : docs === 'older' ? 'OLDER_REVISION' : 'MISSING'
    return {
      kind,
      language,
      state,
      revision: state === 'CURRENT' ? rev.revision : state === 'OLDER_REVISION' ? rev.revision - 1 : null,
      document:
        state === 'MISSING'
          ? null
          : {
              id: uid('1414', n),
              kind,
              language,
              revision: state === 'CURRENT' ? rev.revision : rev.revision - 1,
              status: 'ISSUED',
              number: kind === 'DECLARATION_OF_CONFORMITY' ? `DOC-DEMO-JKT-01-R${state === 'CURRENT' ? rev.revision : rev.revision - 1}` : null,
              issuedAt: at(13, 10),
              currentFile: { id: uid('1515', n), originalName: `${kind === 'DECLARATION_OF_CONFORMITY' ? 'DoC' : 'Nota-informativa'}-DEMO-JKT-01-${language}.pdf`, sizeBytes: 182_400 + n * 1000, sha256: 'a'.repeat(64), availableAt: at(13, 10) },
              versions: 1,
              pendingUpload: false,
            },
      pendingUpload: false,
      message: 'x',
    }
  }
  const languages = ['it', 'en', 'de']
  const declarations = notPpe ? [] : languages.map((language, index) => doc('DECLARATION_OF_CONFORMITY', language, index + 1))
  const leaflets = notPpe ? [] : languages.map((language, index) => doc('USER_INFORMATION', language, index + 11))
  const checks: StyleComplianceView['checks'] = [
    { code: 'REVISION', state: rev.status === 'RELEASED' ? 'OK' : 'BLOCKED', blocks: ['PRODUCTION'], message: 'x', problems: [] },
    { code: 'LABEL_TEMPLATE', state: options.label === false ? 'BLOCKED' : 'OK', blocks: ['PRODUCTION', 'LABELS'], message: 'x', problems: [] },
    { code: 'CERTIFICATE', state: notPpe ? 'NOT_REQUIRED' : 'BLOCKED', blocks: ['PRODUCTION', 'LABELS', 'SHIPPING'], message: 'x', problems: notPpe ? [] : [{ path: `cells/${CW.BLK}/58/certificate`, message: 'x' }, { path: `cells/${CW.RED}/58/certificate`, message: 'x' }] },
    { code: 'DECLARATION_OF_CONFORMITY', state: notPpe ? 'NOT_REQUIRED' : docs === 'current' ? 'OK' : 'BLOCKED', blocks: ['SHIPPING'], message: 'x', problems: [] },
    { code: 'USER_INFORMATION', state: notPpe ? 'NOT_REQUIRED' : docs === 'current' ? 'OK' : 'BLOCKED', blocks: ['SHIPPING'], message: 'x', problems: [] },
  ]
  const offered = cells.filter((cell) => cell.offered)
  return {
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', status: 'ACTIVE', companyId: COMPANY_ID, productType: 'JACKET', brandPartyId: null, mtmAllowed: false },
    date: '2026-10-29',
    classification: notPpe
      ? { isPpe: false, category: 'NOT_PPE', standard: null, standardCode: null, part: null, edition: null, ppeClass: null, partClass: null, certificateRequired: false, documentsRequired: false, legalMaker: 'COMPANY', message: 'x' }
      : { isPpe: true, category: 'CATEGORY_II', standard: 'EN 17092-4:2020', standardCode: 'EN 17092', part: '4', edition: '2020', ppeClass: 'A', partClass: 'A', certificateRequired: true, documentsRequired: true, legalMaker: 'COMPANY', message: 'x' },
    revision: { id: rev.id, revision: rev.revision, status: rev.status, releasedAt: rev.releasedAt, isReleased: rev.status === 'RELEASED', labelTemplate: options.label === false ? null : { id: uid('8888', 1), code: 'ETI-DEMO-JKT', revision: 2, status: 'ACTIVE', languages } },
    releasedRevision: { id: REV.r2, revision: 2 },
    revisions: REVISIONS.map((entry) => ({ id: entry.id, revision: entry.revision, status: entry.status })),
    coverage: {
      required: !notPpe,
      colourways: notPpe ? [] : [{ id: CW.BLK, code: 'NERO', name: 'Nero', status: 'ACTIVE' }, { id: CW.ANT, code: 'ANTR', name: 'Antracite', status: 'ACTIVE' }, { id: CW.RED, code: 'ROSSO', name: 'Rosso corsa', status: 'ACTIVE' }],
      sizes: notPpe ? [] : SIZES,
      cells,
      counts: {
        cells: cells.length,
        offered: offered.length,
        covered: offered.filter((cell) => cell.status === 'COVERED').length,
        expiringSoon: offered.filter((cell) => cell.expiringSoon).length,
        notCovered: offered.filter((cell) => cell.status === 'NOT_COVERED').length,
        expired: 0,
        suspended: 0,
      },
      certificates: notPpe ? [] : [{ coverageId: uid('1313', 1), colourwayIds: [CW.BLK, CW.ANT, CW.RED], sizes: SIZES.slice(0, 6), allowsMadeToMeasure: false, certificate: { ...CERT, notifiedBodyName: 'Organismo Notificato Demo', daysToExpiry: 47 } }],
    },
    documents: {
      required: !notPpe,
      expectedLanguages: notPpe ? [] : languages,
      declarations,
      leaflets,
      maker: notPpe ? null : { makerPartyId: null, makerName: 'Officina Demo S.r.l.', makerAddress: 'Via dell’Esempio 1, 00000 Città Demo (IT)' },
    },
    checks,
    blockers: checks.filter((check) => check.state === 'BLOCKED'),
  }
}

// ---- a material picked for a new BOM line ----------------------------------------------------------------------------------

export const MATERIAL: MaterialView = {
  id: uid('4400', 9),
  companyId: null,
  code: 'PEL-CAP-09',
  name: 'Pelle di capra 0,9 mm (demo)',
  nameI18n: null,
  kind: 'LEATHER',
  sourcing: 'BUY',
  tracking: 'LOT',
  baseUom: 'FT2',
  purchaseUom: 'HIDE',
  consumptionUom: 'FT2',
  defaultSupplier: { id: uid('6666', 9), code: 'CONC-DEMO', name: 'Conceria Demo' },
  supplierArticleCode: 'CD-0909',
  isPpeComponent: false,
  requiresCrViTest: true,
  crViLimitMgKg: '3',
  currency: 'EUR',
  colourCount: 2,
  status: 'ACTIVE',
  version: 2,
  updatedAt: at(20, 9),
  units: { base: { uom: 'FT2', factor: '1', fixed: true }, purchase: { uom: 'HIDE', factor: '6.5', fixed: false }, consumption: { uom: 'FT2', factor: '1', fixed: true } },
  animalSpecies: 'Capra',
  tannage: null,
  grade: 'A',
  finish: null,
  thicknessMinMm: '0.8',
  thicknessMaxMm: '1.0',
  composition: null,
  animalOrigin: true,
  attributes: null,
  colours: [
    { id: uid('4499', 1), code: 'NERO', name: 'Nero', supplierColourCode: 'CD-N01', colourId: COLOURS[0]!.id, status: 'ACTIVE', version: 1, createdAt: at(20, 9), updatedAt: at(20, 9) },
    { id: uid('4499', 2), code: 'TESTA', name: 'Testa di moro', supplierColourCode: 'CD-T07', colourId: null, status: 'ACTIVE', version: 1, createdAt: at(20, 9), updatedAt: at(20, 9) },
  ],
  warnings: [],
  createdAt: at(20, 9),
  createdById: uid('3333', 1),
}

// ---- the record panels (thread, files, history) of the style ----------------------------------------------------------------

export function demoPanels(): RecordPanelsViewModel {
  const base = panelsScreen.cases.find((entry) => entry.id === 'conversation')?.model ?? panelsScreen.cases[0]!.model
  return { ...base, record: { type: 'Style', id: STYLE_ID, companyId: COMPANY_ID, siteId: null }, title: 'DEMO-JKT-01 · Giacca Touring Demo', party: null }
}

// ---- the studio's view model ------------------------------------------------------------------------------------------------

export function recordModel(role: keyof typeof GRAINS, overrides: Partial<StyleRecordViewModel> = {}): StyleRecordViewModel {
  const can = CAN[role]
  return {
    prefix: PREFIX,
    tab: 'overview',
    can,
    grains: GRAINS[role],
    companyId: COMPANY_ID,
    style: { status: 'ready', value: demoStyle() },
    revisionId: REV.r3,
    bom: can.bomView ? { status: 'ready', value: demoBom() } : { status: 'idle' },
    routing: can.routingView ? { status: 'ready', value: demoRouting() } : { status: 'idle' },
    cost: { status: 'idle' },
    costCompare: null,
    compliance: can.complianceView ? { status: 'ready', value: demoCompliance() } : { status: 'idle' },
    libraries: { scales: SCALES, colours: COLOURS, brands: can.brands ? BRANDS : null, labels: null },
    materials: {},
    materialSearch: { query: '', results: null, problem: null },
    operationSearch: { query: '', kind: null, results: null, problem: null },
    bomView: 'lines',
    costCell: null,
    save: { state: 'saved', at: at(29, 9, 12) },
    dialog: null,
    busy: false,
    notice: null,
    changed: null,
    dockOpen: false,
    panelsPreview: can.thread ? demoPanels() : undefined,
    ...overrides,
  }
}

// ---- materials of the BOM (their colours fill the colour grid) ---------------------------------------------------------

/** The material of BOM line n, with the colours its lines name (ids as `line()` makes them). */
export function lineMaterial(n: number): MaterialView {
  const line = demoLines(true).find((entry) => entry.seq === n * 10)!
  const codes = ['NERO', 'ANTR', 'ROSSO']
  return {
    ...MATERIAL,
    id: line.item.id,
    code: line.item.code,
    name: line.item.name,
    kind: line.item.kind,
    baseUom: line.item.baseUom,
    consumptionUom: line.item.baseUom,
    purchaseUom: line.item.kind === 'LEATHER' ? 'HIDE' : line.item.baseUom,
    units: {
      base: { uom: line.item.baseUom, factor: '1', fixed: true },
      purchase: line.item.kind === 'LEATHER' ? { uom: 'HIDE', factor: '52.5', fixed: false } : { uom: line.item.baseUom, factor: '1', fixed: true },
      consumption: { uom: line.item.baseUom, factor: '1', fixed: true },
    },
    colours: codes.map((code) => ({ ...itemColour(n, code), supplierColourCode: `S-${code}`, colourId: null, version: 1, createdAt: at(15, 9), updatedAt: at(15, 9) })),
    colourCount: 3,
  }
}

export const LINE_MATERIALS: Record<string, MaterialView> = Object.fromEntries([1, 6, 7].map((n) => [uid('4400', n), lineMaterial(n)]))

export const MATERIAL_RESULTS = [MATERIAL, lineMaterial(2), lineMaterial(3)].map(({ units: _units, standardCostPerPurchaseUnit: _a, standardCostPerConsumptionUnit: _b, animalSpecies: _c, tannage: _d, grade: _e, finish: _f, thicknessMinMm: _g, thicknessMaxMm: _h, composition: _i, animalOrigin: _j, attributes: _k, colours: _l, warnings: _m, createdAt: _n, createdById: _o, ...row }) => row)

// ---- the operation library (for Add operations) -----------------------------------------------------------------------------

export const OPERATIONS: OperationRow[] = [
  ...OPS.map(([code, name, kind, minutes, machine, skill]: (typeof OPS)[number], index: number) => ({ id: uid('2200', index + 1), companyId: null, code, name, nameI18n: null, workCentreKind: kind, machineType: machine, skill, standardMinutes: code === 'CUC-MAN' ? '17' : minutes, status: 'ACTIVE' as const, usedIn: 4, differing: code === 'CUC-MAN' ? 1 : 0, version: 1, updatedAt: at(10, 9) })),
  { id: uid('2200', 20), companyId: null, code: 'CUC-RIF', name: 'Applicazione inserti riflettenti', nameI18n: null, workCentreKind: 'SEWING', machineType: 'Piana 1 ago', skill: 'Cucitrice', standardMinutes: '4.5', status: 'ACTIVE', usedIn: 1, differing: 0, version: 1, updatedAt: at(10, 9) },
  { id: uid('2200', 21), companyId: null, code: 'IMB-SAC', name: 'Imbustamento e cartellino', nameI18n: null, workCentreKind: 'PACKING', machineType: null, skill: null, standardMinutes: '1.5', status: 'ACTIVE', usedIn: 6, differing: 0, version: 1, updatedAt: at(10, 9) },
]

// ---- the cost sheet (made-up prices and rates; every figure worked out below from the BOM and the routing) ----------------------

/** € per base unit. */
const PRICE: Record<string, string | null> = { 'PEL-BOV-12': '3.2', 'FOD-MESH': '4.5', 'MEM-WP-3L': '9.8', 'PROT-SPAL-L2': '6.4', 'PROT-GOM-L2': '5.9', 'ZIP-DIV-8': '2.75', 'FILO-40': '0.012', 'ETI-CURA': '0.18' }
/** € per standard minute and planned efficiency %. */
const RATE: Record<string, [string, string]> = { CUTTING: ['0.62', '100'], SEWING: ['0.55', '80'], ASSEMBLY: ['0.5', '100'], FINISHING: ['0.48', '100'], INSPECTION: ['0.6', '100'] }
const CATEGORY: Record<string, CostSheetView['cells'][number]['material']['lines'][number]['category']> = { LEATHER: 'LEATHER', LINING: 'MATERIALS', MEMBRANE: 'MATERIALS', PROTECTOR: 'MATERIALS', TRIM: 'TRIMS', THREAD: 'TRIMS', LABEL: 'TRIMS' }
const fix = (value: number) => value.toFixed(6)

export function demoCost(options: { revision?: Revision; noPrice?: boolean } = {}): CostSheetView {
  const rev = options.revision ?? REVISIONS[0]!
  const lines = demoLines(rev.status !== 'DRAFT')
  const routing = demoRouting({ revision: rev })
  const prices = options.noPrice ? { ...PRICE, 'MEM-WP-3L': null } : PRICE
  const missing: CostSheetView['missing'] = []
  if (lines.some((line) => line.bySize.some((entry) => entry.qty === null))) missing.push({ key: 'BOM_QUANTITY:58', code: 'BOM_QUANTITY', itemId: null, lineId: lines[0]!.id, size: '58', workCentreKind: null, message: 'x' })
  if (options.noPrice) missing.push({ key: 'MATERIAL_PRICE:MEM', code: 'MATERIAL_PRICE', itemId: lines[2]!.item.id, lineId: null, size: null, workCentreKind: null, message: 'x' })
  const cells = (['BLK', 'ANT', 'RED'] as const).flatMap((key) =>
    SIZES.map((size) => {
      const keys: string[] = []
      const materialLines = lines.map((line) => {
        const bySize = line.bySize.find((entry) => entry.size === size)!
        const price = prices[line.item.code] ?? null
        const amount = bySize.base !== null && price !== null ? Number(bySize.base) * Number(price) : null
        if (bySize.base === null) keys.push('BOM_QUANTITY:58')
        if (price === null) keys.push('MATERIAL_PRICE:MEM')
        return { lineId: line.id, seq: line.seq, itemId: line.item.id, code: line.item.code, category: CATEGORY[line.item.kind]!, placement: line.placement, qty: bySize.qty, uom: line.uom, wastagePct: line.wastagePct, baseQuantity: bySize.base, baseUom: line.item.baseUom, unitCost: price, amount: amount === null ? null : fix(amount) }
      })
      const known = (category?: string) => materialLines.filter((line) => !category || line.category === category).reduce((sum, line) => sum + Number(line.amount ?? 0), 0)
      const materialComplete = materialLines.every((line) => line.amount !== null)
      const labourLines = routing.minutes.byKind.map((entry) => {
        const [rate, efficiency] = RATE[entry.workCentreKind] ?? ['0.5', '100']
        return { workCentreKind: entry.workCentreKind, steps: entry.steps, minutes: entry.minutes, costPerMinute: rate, plannedEfficiencyPct: efficiency, amount: fix((Number(entry.minutes) * Number(rate)) / (Number(efficiency) / 100)) }
      })
      const material = known()
      const labour = labourLines.reduce((sum, line) => sum + Number(line.amount), 0)
      const base = material + labour
      const overhead = base * 0.12
      const complete = materialComplete
      const categories = (['LEATHER', 'MATERIALS', 'TRIMS'] as const).map((category) => ({ category, complete: materialLines.filter((line) => line.category === category).every((line) => line.amount !== null), amount: fix(known(category)) }))
      let running = 0
      const waterfall = [
        ...categories.map((category) => {
          running += Number(category.amount)
          return { step: 'MATERIAL' as const, category: category.category, workCentreKind: null, complete: category.complete, amount: category.amount, runningTotal: fix(running) }
        }),
        ...labourLines.map((line) => {
          running += Number(line.amount)
          return { step: 'LABOUR' as const, category: null, workCentreKind: line.workCentreKind, complete: true, amount: line.amount, runningTotal: fix(running) }
        }),
        { step: 'OVERHEAD' as const, category: null, workCentreKind: null, complete, amount: fix(overhead), runningTotal: fix(running + overhead) },
      ]
      return {
        colourwayId: CW[key],
        size,
        complete,
        missing: [...new Set(keys)],
        minutes: routing.minutes.perGarment,
        material: { complete: materialComplete, amount: fix(material), byCategory: categories, lines: materialLines },
        labour: { complete: true, amount: fix(labour), lines: labourLines },
        overhead: { overheadPct: '12', base: fix(base), amount: fix(overhead) },
        knownTotal: fix(base + overhead),
        total: complete ? fix(base + overhead) : null,
        waterfall,
      }
    }),
  )
  const sheet = {
    style: { ...STYLE_REF, status: 'ACTIVE', baseSize: '52' },
    revision: { id: rev.id, revision: rev.revision, status: rev.status, version: rev.version },
    estimate: rev.status === 'DRAFT',
    sizes: SIZES,
    colourways: [
      { id: CW.BLK, code: 'NERO', name: 'Nero' },
      { id: CW.ANT, code: 'ANTR', name: 'Antracite' },
      { id: CW.RED, code: 'ROSSO', name: 'Rosso corsa' },
    ],
    computedAt: at(29, 9, 30),
    currency: 'EUR',
    companyId: COMPANY_ID,
    on: '2026-10-29',
    complete: missing.length === 0,
    missing,
    inputs: {
      materials: lines.map((line) => ({
        itemId: line.item.id,
        code: line.item.code,
        name: line.item.name,
        kind: line.item.kind,
        category: CATEGORY[line.item.kind]!,
        source: 'STANDARD' as const,
        baseUom: line.item.baseUom,
        standardCost: prices[line.item.code] ?? null,
        currency: 'EUR',
        asOf: prices[line.item.code] ? at(18, 9) : null,
        purchaseUom: line.item.kind === 'LEATHER' ? ('HIDE' as const) : line.item.baseUom,
        standardCostPerPurchaseUnit: prices[line.item.code] ? fix(Number(prices[line.item.code]) * (line.item.kind === 'LEATHER' ? 52.5 : 1)) : null,
      })),
      labour: routing.minutes.byKind.map((entry) => ({ workCentreKind: entry.workCentreKind, steps: entry.steps, minutes: entry.minutes, source: 'LABOUR_RATE' as const, rateId: uid('3131', 1), companyId: null, costPerMinute: RATE[entry.workCentreKind]![0], currency: 'EUR', plannedEfficiencyPct: RATE[entry.workCentreKind]![1], validFrom: '2026-01-01' })),
      overhead: { source: 'OVERHEAD_RULE', ruleId: uid('3132', 1), companyId: null, overheadPct: '12', updatedAt: at(2, 9) },
    },
    cells,
  }
  // The money fields are branded by grain in the contract; made-up figures are plain strings.
  return sheet as unknown as CostSheetView
}

/** The sheet as a person without the cost grain receives it: every money field left out by the API. */
export function withoutCost(sheet: CostSheetView): CostSheetView {
  const strip = <T extends object>(value: T, fields: readonly string[]): T => Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key))) as T
  return {
    ...sheet,
    inputs: {
      materials: sheet.inputs.materials.map((material) => strip(material, ['standardCost', 'standardCostPerPurchaseUnit'])),
      labour: sheet.inputs.labour.map((rate) => strip(rate, ['costPerMinute'])),
      overhead: sheet.inputs.overhead,
    },
    cells: sheet.cells.map((cell) => ({
      ...strip(cell, ['knownTotal', 'total']),
      material: { ...strip(cell.material, ['amount']), byCategory: cell.material.byCategory.map((category) => strip(category, ['amount'])), lines: cell.material.lines.map((line) => strip(line, ['unitCost', 'amount'])) },
      labour: { ...strip(cell.labour, ['amount']), lines: cell.labour.lines.map((line) => strip(line, ['costPerMinute', 'amount'])) },
      overhead: cell.overhead ? strip(cell.overhead, ['base', 'amount']) : null,
      waterfall: cell.waterfall.map((step) => strip(step, ['amount', 'runningTotal'])),
    })) as CostSheetView['cells'],
  }
}

/** The draft's change against revision 2: the cells it touches (made up: the level 2 protectors add €3.10 a garment). */
export function demoCompare(): CostDiffView {
  const diff = {
    style: { ...STYLE_REF, status: 'ACTIVE', baseSize: '52' },
    from: { id: REV.r2, revision: 2, status: 'RELEASED', version: 3, complete: true, missing: [] },
    to: { id: REV.r3, revision: 3, status: 'DRAFT', version: 7, complete: false, missing: [] },
    currency: 'EUR',
    companyId: COMPANY_ID,
    on: '2026-10-29',
    computedAt: at(29, 9, 30),
    cells: (['BLK', 'ANT', 'RED'] as const).flatMap((key) => SIZES.filter((size) => size !== '58').map((size) => ({ colourwayId: CW[key], size, from: null, to: null, materialCostChange: '3.1', labourCostChange: '0', overheadCostChange: '0.372', totalChange: '3.472', materials: [], labour: [] }))),
    unchanged: 0,
  }
  return diff as unknown as CostDiffView
}
