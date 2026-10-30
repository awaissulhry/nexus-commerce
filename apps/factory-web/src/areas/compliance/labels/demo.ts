import { templateOf as roleTemplate } from '@nexus/factory-domain/auth/roles/templates'
import { activationProblems, renderLabel } from '@nexus/factory-domain/compliance/labels/render'
import { DEFAULT_LAYOUT, labelNextStatuses, styleWarnings, type LabelLayout } from '@nexus/factory-domain/compliance/labels/rules'
import type { CellValues, LabelDetail, LabelTemplate, Preview, PrintJob, Printer, Rendered } from './api'
import { factsOf, draftOf, labelsCan, valuesOf, type LabelsCan } from './model'

/**
 * Design-only made-up data for Labels & marking (SCR-053): an invented factory's garment labels — a touring jacket's
 * label active in revision 1 with revision 2 being written, a glove label ready to activate, a shared label, a retired
 * one, a category III airbag vest's draft and a t-shirt that is not PPE. Every name, code, address and number is made up
 * ("Officina Demo S.r.l.", DEMO-… and LBL-DEMO-…; "0000" is no notified body). The checks and the previews are the
 * domain's own render of this data (factory-domain renderLabel and activationProblems), as the API makes them.
 */

export const PREFIX = '/w/DEMO'
export const TODAY = '2026-10-29'
const at = (day: number, hour = 9, minute = 0): string => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
export const NOW = at(29, 9, 42)
const uid = (family: string, n: number): string => `0190f0e2-${family.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = uid('0001', 1)

const MAKER = { makerPartyId: null, makerName: 'Officina Demo S.r.l.', makerAddress: 'Via dell’Esempio 12, 00000 Borgo Demo (XX), Italia' }

type StyleRef = NonNullable<LabelTemplate['style']>
const STYLES = {
  jacket: { id: uid('5301', 1), code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-4:2020', ppeClass: 'A', productType: 'JACKET' },
  gloves: { id: uid('5301', 2), code: 'DEMO-GLV-01', name: 'Guanto Estivo Demo', ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 13594:2015', ppeClass: '1KP', productType: 'GLOVES' },
  vest: { id: uid('5301', 3), code: 'DEMO-VST-01', name: 'Gilet Airbag Demo', ppeCategory: 'CATEGORY_III', ppeStandard: 'EN 1621-4:2013', ppeClass: null, productType: 'VEST' },
  tshirt: { id: uid('5301', 4), code: 'DEMO-TSH-01', name: 'Maglia Tecnica Demo', ppeCategory: 'NOT_PPE', ppeStandard: null, ppeClass: null, productType: 'OTHER' },
} as const
type StyleKey = keyof typeof STYLES

const ref = (key: StyleKey): StyleRef => {
  const style = STYLES[key]
  return { id: style.id, code: style.code, name: style.name, ppeCategory: style.ppeCategory, ppeStandard: style.ppeStandard, ppeClass: style.ppeClass }
}

/** The cell values a preview is drawn with (what the API's preview answers beside the label). */
export function valuesFor(key: StyleKey, extra: Partial<CellValues> = {}): CellValues {
  const style = STYLES[key]
  const ppe = style.ppeCategory !== 'NOT_PPE'
  return {
    style: { id: style.id, code: style.code, name: style.name, companyId: COMPANY, productType: style.productType, ppeCategory: style.ppeCategory, ppeStandard: style.ppeStandard, ppeClass: style.ppeClass, brandPartyId: null },
    colourway: { id: uid('5302', key.length), code: 'NER', name: 'Nero' },
    size: key === 'gloves' ? { code: 'L', label: null, scaleId: uid('5303', 2), scaleCode: 'DEMO-GLV', bodyMeasures: { hand: { min: '21', max: '23', unit: 'cm' } } } : { code: '52', label: '52 (L)', scaleId: uid('5303', 1), scaleCode: 'DEMO-EU', bodyMeasures: { chest: { min: '100', max: '104', unit: 'cm' }, height: { min: '176', max: '182', unit: 'cm' } } },
    certificate:
      style.ppeCategory === 'CATEGORY_II'
        ? { outcome: 'covered', certificate: { id: uid('5304', key.length), number: key === 'gloves' ? 'CERT-DEMO-0002' : 'CERT-DEMO-0001', standard: style.ppeStandard ?? '', ppeClass: style.ppeClass, validTo: '2029-03-11' }, reasons: [], date: TODAY }
        : ppe
          ? { outcome: 'refused', certificate: null, reasons: ['No certificate in the register covers style DEMO-VST-01.'], date: TODAY }
          : { outcome: 'not_required', certificate: null, reasons: [], date: TODAY },
    identification: { kind: 'BATCH' },
    date: TODAY,
    marketLanguages: [],
    ...extra,
  }
}

interface Seed {
  id: string
  code: string
  revision: number
  name: string
  style: StyleKey | null
  status: LabelTemplate['status']
  languages?: string[]
  composition?: LabelTemplate['composition']
  animalOriginPhrase?: boolean
  care?: LabelTemplate['care']
  layout?: Partial<LabelLayout>
  widthMm?: string
  heightMm?: string
  importerName?: string | null
  importerAddress?: string | null
  updatedAt?: string
}

const JACKET_COMPOSITION: LabelTemplate['composition'] = [
  { part: 'Esterno', fibres: [{ fibre: 'poliammide', percent: '80' }, { fibre: 'poliestere', percent: '20' }] },
  { part: 'Fodera', fibres: [{ fibre: 'poliestere', percent: '100' }] },
]
const JACKET_CARE: LabelTemplate['care'] = [{ symbol: 'wash-30-mild' }, { symbol: 'bleach-not' }, { symbol: 'tumble-not' }, { symbol: 'iron-not' }, { symbol: 'dryclean-not' }]

/** A template as the API answers it, its problems and warnings from the domain's own activation check. */
function template(seed: Seed): LabelTemplate {
  const style = seed.style ? STYLES[seed.style] : null
  const base: LabelTemplate = {
    id: seed.id,
    companyId: COMPANY,
    code: seed.code,
    revision: seed.revision,
    name: seed.name,
    styleId: style?.id ?? null,
    style: seed.style ? ref(seed.style) : null,
    status: seed.status,
    languages: seed.languages ?? ['it', 'en'],
    ...MAKER,
    importerName: seed.importerName ?? null,
    importerAddress: seed.importerAddress ?? null,
    composition: seed.composition ?? JACKET_COMPOSITION,
    animalOriginPhrase: seed.animalOriginPhrase ?? false,
    care: seed.care ?? JACKET_CARE,
    layout: { ...DEFAULT_LAYOUT, texts: { animalOrigin: {} }, ...seed.layout },
    widthMm: seed.widthMm ?? '50.00',
    heightMm: seed.heightMm ?? '80.00',
    nextStatuses: [...labelNextStatuses(seed.status)],
    problems: [],
    warnings: [],
    activatable: false,
    version: 3,
    createdAt: at(20),
    updatedAt: seed.updatedAt ?? at(28, 15, 10),
  }
  const values = seed.style ? valuesOf(valuesFor(seed.style)) : null
  const facts = factsOf(base, draftOf(base))
  const problems = activationProblems(facts, values ? values.style : null, TODAY).map((issue) => ({ ...issue }))
  const warnings = values ? styleWarnings(facts, values.style).map((issue) => ({ ...issue })) : []
  return { ...base, problems, warnings, activatable: seed.status === 'DRAFT' && problems.length === 0 }
}

export const JACKET_R1 = template({ id: uid('5310', 1), code: 'LBL-DEMO-JKT-01', revision: 1, name: 'Giacca Touring Demo · etichetta cucita', style: 'jacket', status: 'ACTIVE', animalOriginPhrase: true, updatedAt: at(14, 10) })
export const JACKET_R2 = template({
  id: uid('5310', 2),
  code: 'LBL-DEMO-JKT-01',
  revision: 2,
  name: 'Giacca Touring Demo · etichetta cucita',
  style: 'jacket',
  status: 'DRAFT',
  languages: ['it', 'en', 'nl'],
  animalOriginPhrase: true,
  composition: [
    { part: 'Esterno', fibres: [{ fibre: 'poliammide', percent: '75' }, { fibre: 'poliestere', percent: '20' }] },
    { part: 'Fodera', fibres: [{ fibre: 'poliestere', percent: '100' }] },
  ],
})
export const GLOVES_R1 = template({
  id: uid('5310', 3),
  code: 'LBL-DEMO-GLV-01',
  revision: 1,
  name: 'Guanto Estivo Demo · etichetta',
  style: 'gloves',
  status: 'DRAFT',
  composition: [{ part: 'Fodera', fibres: [{ fibre: 'poliestere', percent: '100' }] }],
  animalOriginPhrase: true,
  care: [{ symbol: 'wash-not' }, { symbol: 'bleach-not' }, { symbol: 'tumble-not' }, { symbol: 'iron-not' }],
  widthMm: '40.00',
  heightMm: '80.00',
  layout: { preset: 'COMPACT', fields: [], notifiedBodyNumber: null, manufactureDate: 'MONTH', texts: { animalOrigin: {} } },
})
export const SHARED_R1 = template({ id: uid('5310', 4), code: 'LBL-DEMO-STD', revision: 1, name: 'Etichetta aziendale standard', style: null, status: 'ACTIVE', languages: ['it', 'en', 'de', 'fr'], updatedAt: at(2, 11) })
export const OLD_R1 = template({ id: uid('5310', 5), code: 'LBL-DEMO-OLD', revision: 1, name: 'Etichetta 2025 (superata)', style: null, status: 'RETIRED', updatedAt: at(1, 8) })
export const VEST_R1 = template({ id: uid('5310', 6), code: 'LBL-DEMO-VST-01', revision: 1, name: 'Gilet Airbag Demo · etichetta', style: 'vest', status: 'DRAFT', heightMm: '60.00' })
export const TSHIRT_R1 = template({ id: uid('5310', 7), code: 'LBL-DEMO-TSH-01', revision: 1, name: 'Maglia Tecnica Demo · etichetta', style: 'tshirt', status: 'DRAFT', composition: [{ part: 'Tessuto', fibres: [{ fibre: 'poliestere', percent: '92' }, { fibre: 'elastan', percent: '8' }] }], care: [{ symbol: 'wash-40' }, { symbol: 'tumble-not' }] })

export const ROWS: LabelTemplate[] = [GLOVES_R1, JACKET_R1, JACKET_R2, OLD_R1, SHARED_R1, TSHIRT_R1, VEST_R1]

/** Many rows for a long list (made-up codes in sequence). */
export const MANY: LabelTemplate[] = Array.from({ length: 36 }, (_, index) => ({ ...SHARED_R1, id: uid('5311', index + 1), code: `LBL-DEMO-${String(index + 100).padStart(3, '0')}`, name: `Etichetta demo ${index + 1}`, status: index % 5 === 0 ? 'DRAFT' : index % 7 === 0 ? 'RETIRED' : 'ACTIVE' }))

/** A template's record: its revisions and who uses it. */
export function detailOf(row: LabelTemplate, extra: Partial<LabelDetail> = {}): LabelDetail {
  const revisions = ROWS.filter((entry) => entry.code === row.code).map((entry) => ({ id: entry.id, revision: entry.revision, status: entry.status, version: entry.version, updatedAt: entry.updatedAt }))
  const style = row.style
  return {
    ...row,
    revisions: revisions.length > 0 ? revisions : [{ id: row.id, revision: row.revision, status: row.status, version: row.version, updatedAt: row.updatedAt }],
    usage: {
      styleRevisions: style && row.status !== 'DRAFT' ? [{ id: uid('5320', 1), styleId: style.id, styleCode: style.code, revision: 2, status: 'RELEASED' }] : style ? [{ id: uid('5320', 2), styleId: style.id, styleCode: style.code, revision: 3, status: 'DRAFT' }] : [],
      workOrders: row.status === 'ACTIVE' && style ? { count: 3, shown: [1, 2, 3].map((n) => ({ id: uid('5330', n), number: `WO-DEMO-00${n}`, status: n === 3 ? 'IN_PROGRESS' : 'COMPLETED', batchNumber: `B-DEMO-0${n}` })) } : { count: 0, shown: [] },
    },
    ...extra,
  }
}

/** The server's preview of a template for its style's sample cell. */
export function previewOf(row: LabelTemplate, values: CellValues): Preview {
  const label = JSON.parse(JSON.stringify(renderLabel({ ...factsOf(row, draftOf(row)) }, valuesOf(values)))) as Rendered
  return {
    label,
    values,
    cell: {
      styleId: values.style.id,
      styleCode: values.style.code,
      styleRevisionId: uid('5320', 1),
      revision: 2,
      colourwayId: values.colourway?.id ?? null,
      size: values.size?.code ?? null,
      date: values.date,
      certificate: values.certificate ? { outcome: values.certificate.outcome, number: values.certificate.certificate?.number ?? null, reasons: [...values.certificate.reasons] } : null,
    },
  }
}

export const CHOICES = {
  colourways: [
    { id: uid('5302', 6), code: 'NER', name: 'Nero' },
    { id: uid('5302', 7), code: 'GRI', name: 'Grigio' },
  ],
  sizes: ['48', '50', '52', '54', '56'],
}

export const PRINTERS: Printer[] = [
  { id: uid('5340', 1), siteId: uid('0002', 1), code: 'PRN-DEMO-01', name: 'Stampante etichette Demo', kind: 'LABEL_ZPL', dpi: 203, labelWidthMm: 100, labelHeightMm: 150, status: 'ACTIVE' },
  { id: uid('5340', 2), siteId: uid('0002', 1), code: 'PRN-DEMO-02', name: 'Stampante reparto Demo', kind: 'LABEL_ZPL', dpi: 300, labelWidthMm: 76, labelHeightMm: 48, status: 'PAUSED' },
]

export function job(status: PrintJob['status'], n = 1, extra: Partial<PrintJob> = {}): PrintJob {
  return {
    id: uid('5350', n),
    printerId: PRINTERS[0]!.id,
    recordType: 'LabelTemplate',
    recordId: JACKET_R1.id,
    copies: 1,
    status,
    attempts: status === 'FAILED' ? 2 : 1,
    lastError: status === 'FAILED' ? 'Printer did not answer (timeout after 10 s).' : null,
    sentAt: status === 'QUEUED' ? null : at(29, 9, 30 + n),
    printedAt: status === 'PRINTED' ? at(29, 9, 31 + n) : null,
    failedAt: status === 'FAILED' ? at(29, 9, 32 + n) : null,
    createdAt: at(29, 9, 29 + n),
    ...extra,
  }
}

// ---- the role cases (factory-domain's own role templates) ----
const permissionsOf = (key: string): string[] => [...(roleTemplate(key)?.permissions ?? []), 'home.view']
export const ROLES: Record<'owner' | 'developer' | 'quality' | 'sales', readonly string[]> = {
  owner: [...permissionsOf('quality_inspector'), 'product.styles.view', 'workorders.view'],
  developer: permissionsOf('production_manager'),
  quality: permissionsOf('quality_inspector'),
  sales: permissionsOf('sales'),
}
export const CAN: Record<keyof typeof ROLES, LabelsCan> = {
  owner: labelsCan(ROLES.owner),
  developer: labelsCan(ROLES.developer),
  quality: labelsCan(ROLES.quality),
  sales: labelsCan(ROLES.sales),
}
