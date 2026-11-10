import { EDIT_RULE_COLUMNS, editRuleFor, STYLE_LIFECYCLES, type EditRule, type EditRuleRow, type StyleLifecycle } from '@nexus/factory-domain/product/lifecycle/rules'
import { ITEM_KINDS, type ItemKind } from '@nexus/factory-domain/product/materials/rules'
import { toleranceFor, toleranceTable, type ConsumptionTolerance, type ToleranceRow } from '@nexus/factory-domain/product/settings/rules'
import type { PpeCategory, ProductType as GarmentKind } from '@nexus/factory-domain/product/styles/rules'
import { effectiveType, type TypeRow } from '@nexus/factory-domain/product/types/rules'
import type { Money } from '@nexus/factory-domain/money/marked'
import { at, COMPANY_ID, uid } from '../library/demo'
import type { AuditEntry, CostingDefaults, LabelRef, LabourRate, ProductSettings, ProductType, ScaleRef } from './api'

/**
 * Design-only made-up data for SCR-251 (Product settings): an invented factory's product types (DEMO- codes), its edit rules
 * and tolerances, its costing defaults and who changed them ("Demo" names). The views are made with factory-domain's own
 * rules (`editRuleFor`, `toleranceFor`, `effectiveType`), as the API makes them, so a case never shows what the API could not.
 */

export const TENANT_ID = uid('2391', 1)

// ---- settings -----------------------------------------------------------------------------------------------------------

type OwnRules = Partial<Record<StyleLifecycle, EditRule>>
interface OwnTolerance {
  readonly rule?: ConsumptionTolerance
  readonly percent?: string
  readonly byKind?: Partial<Record<ItemKind, { rule: ConsumptionTolerance; percent?: string }>>
}

const ruleRow = (own: OwnRules | null): EditRuleRow | null => (own ? (Object.fromEntries(STYLE_LIFECYCLES.map((state) => [EDIT_RULE_COLUMNS[state], own[state] ?? null])) as EditRuleRow) : null)
const toleranceRow = (own: OwnTolerance | null): ToleranceRow | null => (own ? { consumptionTolerance: own.rule ?? null, consumptionTolerancePct: own.percent ?? null, consumptionToleranceByKind: own.byKind ?? null } : null)

/** A settings read as the API answers it (apps/factory-api modules/product/settings settingsViewOf). */
export function settingsOf(options: {
  companyId: string | null
  own: { rules: OwnRules; tolerance: OwnTolerance } | null
  tenant: { rules: OwnRules; tolerance: OwnTolerance } | null
  mayChange: boolean
  version?: number
  updatedAt?: string
}): ProductSettings {
  const { companyId, own, tenant, mayChange } = options
  const isTenant = companyId === null
  const ownRules = ruleRow(own?.rules ?? null)
  const editRules = STYLE_LIFECYCLES.map((state) => {
    const inForce = isTenant ? editRuleFor(state, null, ownRules) : editRuleFor(state, ownRules, ruleRow(tenant?.rules ?? null))
    return { state, own: own?.rules[state] ?? null, ...inForce }
  })
  const [company, wide] = isTenant ? [null, toleranceRow(own?.tolerance ?? null)] : [toleranceRow(own?.tolerance ?? null), toleranceRow(tenant?.tolerance ?? null)]
  const general = toleranceFor(company, wide, null)
  return {
    companyId,
    exists: own !== null,
    version: own ? (options.version ?? 1) : null,
    updatedAt: own ? (options.updatedAt ?? at(20, 10, 0)) : null,
    mayChange,
    editRules,
    tolerance: {
      own: { rule: own?.tolerance.rule ?? null, percent: own?.tolerance.percent ?? null },
      rule: general.rule,
      percent: general.percent,
      source: general.source,
      byKind: toleranceTable(company, wide).map((entry) => {
        const mine = own?.tolerance.byKind?.[entry.kind]
        return { ...entry, own: mine ? { rule: mine.rule, percent: mine.percent ?? null } : null }
      }),
    },
  } as ProductSettings
}

/** Every company's own values: change orders once in production, a 3 % warning, leather 5 %. */
export const TENANT_OWN = {
  rules: { CONCEPT: 'FREE', DEVELOPMENT: 'FREE', SAMPLING: 'NEW_REVISION', APPROVED: 'NEW_REVISION', IN_PRODUCTION: 'CHANGE_ORDER', PHASE_OUT: 'CHANGE_ORDER', DISCONTINUED: 'BLOCKED' } as OwnRules,
  tolerance: { rule: 'WARN_ABOVE', percent: '3', byKind: { LEATHER: { rule: 'WARN_ABOVE', percent: '5' } } } as OwnTolerance,
}

/** The company's own values: samples edited freely, thread may differ, the rest follows every company. */
export const COMPANY_OWN = {
  rules: { SAMPLING: 'FREE' } as OwnRules,
  tolerance: { byKind: { THREAD: { rule: 'MAY_DIFFER' }, PROTECTOR: { rule: 'MATCH' } } } as OwnTolerance,
}

export const COMPANY_SETTINGS = (mayChange = true): ProductSettings => settingsOf({ companyId: COMPANY_ID, own: COMPANY_OWN, tenant: TENANT_OWN, mayChange, version: 3, updatedAt: at(27, 15, 20) })
export const TENANT_SETTINGS = (mayChange = true): ProductSettings => settingsOf({ companyId: null, own: TENANT_OWN, tenant: null, mayChange, version: 5, updatedAt: at(24, 11, 5) })
export const COMPANY_FRESH = (mayChange = true): ProductSettings => settingsOf({ companyId: COMPANY_ID, own: null, tenant: TENANT_OWN, mayChange })

// ---- product types ------------------------------------------------------------------------------------------------------

export const SCALES: ScaleRef[] = [
  { id: uid('2392', 1), code: 'DEMO-EU-JKT', name: 'EU jackets 44–60', companyId: null },
  { id: uid('2392', 2), code: 'DEMO-EU-TRS', name: 'EU trousers 44–58', companyId: null },
  { id: uid('2392', 3), code: 'DEMO-GLV', name: 'Gloves S–3XL', companyId: null },
  { id: uid('2392', 4), code: 'DEMO-LADY', name: 'Women 38–48', companyId: COMPANY_ID },
]

export const LABELS: LabelRef[] = [
  { id: uid('2393', 1), code: 'DEMO-LBL-JKT', name: 'Jacket label (it, en, de)', revision: 2, status: 'ACTIVE', companyId: null },
  { id: uid('2393', 2), code: 'DEMO-LBL-GLV', name: 'Glove label', revision: 1, status: 'ACTIVE', companyId: null },
]

const TEMPLATES = [{ id: uid('2394', 1), code: 'DEMO-MTM-SUIT', name: 'Suit body measures' }]

interface DemoType {
  readonly n: number
  readonly code: string
  readonly name: string
  readonly productType: GarmentKind
  readonly parent?: number
  readonly companyId?: string | null
  readonly required?: string[]
  readonly scale?: number
  readonly label?: number
  readonly template?: number
  readonly ppe?: PpeCategory
  readonly standard?: string
  readonly ppeClass?: string
  readonly styles?: number
  readonly archived?: boolean
  readonly version?: number
  readonly updatedAt?: string
}

const DEMO_TYPES: DemoType[] = [
  { n: 1, code: 'DEMO-JKT', name: 'Rider jackets', productType: 'JACKET', required: ['sizes', 'hsCode', 'originCountry', 'gender'], scale: 1, label: 1, ppe: 'CATEGORY_II', standard: 'EN 17092-4:2020', ppeClass: 'A', styles: 6, updatedAt: at(22, 9, 15) },
  { n: 2, code: 'DEMO-JKT-TOUR', name: 'Touring jackets', productType: 'JACKET', parent: 1, companyId: COMPANY_ID, required: ['netMassKg', 'brandPartyId'], styles: 4, version: 3, updatedAt: at(28, 14, 2) },
  { n: 3, code: 'DEMO-JKT-URB', name: 'Urban jackets', productType: 'JACKET', parent: 1, required: ['season'], standard: 'EN 17092-5:2020', ppeClass: 'B', styles: 2, updatedAt: at(18, 11, 40) },
  { n: 4, code: 'DEMO-JKT-LADY', name: 'Women’s touring jackets', productType: 'JACKET', parent: 2, companyId: COMPANY_ID, scale: 4, styles: 1, updatedAt: at(26, 8, 30) },
  { n: 5, code: 'DEMO-TRS', name: 'Rider trousers', productType: 'TROUSERS', required: ['sizes', 'hsCode'], scale: 2, ppe: 'CATEGORY_II', standard: 'EN 17092-4:2020', ppeClass: 'A', styles: 3, updatedAt: at(15, 16, 0) },
  { n: 6, code: 'DEMO-GLV', name: 'Gloves', productType: 'GLOVES', required: ['sizes', 'ppeStandard', 'ppeClass'], scale: 3, label: 2, ppe: 'CATEGORY_II', standard: 'EN 13594:2015', ppeClass: '1', styles: 5, updatedAt: at(12, 10, 10) },
  { n: 7, code: 'DEMO-SUIT', name: 'One-piece suits', productType: 'SUIT', required: ['sizes', 'measurementTemplateId'], template: 1, ppe: 'CATEGORY_II', standard: 'EN 17092-2:2020', ppeClass: 'AAA', styles: 0, updatedAt: at(10, 9, 0) },
  { n: 8, code: 'DEMO-VEST', name: 'Airbag vests (old)', productType: 'VEST', required: ['ppeStandard'], ppe: 'CATEGORY_II', standard: 'EN 1621-4:2013', styles: 1, archived: true, version: 4, updatedAt: at(5, 9, 0) },
]

const typeId = (n: number) => uid('2395', n)

const rowOf = (demo: DemoType): TypeRow => ({
  id: typeId(demo.n),
  code: demo.code,
  name: demo.name,
  productType: demo.productType,
  parentId: demo.parent ? typeId(demo.parent) : null,
  requiredAttributes: demo.required ?? [],
  defaultSizeScaleId: demo.scale ? SCALES[demo.scale - 1]!.id : null,
  labelTemplateId: demo.label ? LABELS[demo.label - 1]!.id : null,
  measurementTemplateId: demo.template ? TEMPLATES[demo.template - 1]!.id : null,
  defaultPpeCategory: demo.ppe ?? null,
  defaultPpeStandard: demo.standard ?? null,
  defaultPpeClass: demo.ppeClass ?? null,
})

/** A type read as the API answers it (modules/product/types typeViewOf). */
function typeViewOf(demo: DemoType, all: readonly DemoType[]): ProductType {
  const chain: TypeRow[] = []
  let current: DemoType | undefined = demo
  while (current) {
    chain.push(rowOf(current))
    current = current.parent ? all.find((entry) => entry.n === current!.parent) : undefined
  }
  const effective = effectiveType(chain)
  const self = chain[0]!
  const scale = SCALES.find((entry) => entry.id === effective.defaults.defaultSizeScaleId.value) ?? null
  const label = LABELS.find((entry) => entry.id === effective.defaults.labelTemplateId.value) ?? null
  const template = TEMPLATES.find((entry) => entry.id === effective.defaults.measurementTemplateId.value) ?? null
  const parent = demo.parent ? all.find((entry) => entry.n === demo.parent) : undefined
  return {
    id: self.id,
    code: demo.code,
    name: demo.name,
    nameI18n: null,
    companyId: demo.companyId ?? null,
    productType: demo.productType,
    parent: parent ? { id: typeId(parent.n), code: parent.code, name: parent.name } : null,
    status: demo.archived ? 'ARCHIVED' : 'ACTIVE',
    version: demo.version ?? 1,
    updatedAt: demo.updatedAt ?? at(20),
    own: {
      requiredAttributes: [...self.requiredAttributes],
      defaultSizeScaleId: self.defaultSizeScaleId,
      labelTemplateId: self.labelTemplateId,
      measurementTemplateId: self.measurementTemplateId,
      defaultPpeCategory: self.defaultPpeCategory,
      defaultPpeStandard: self.defaultPpeStandard,
      defaultPpeClass: self.defaultPpeClass,
    },
    effective: { requiredAttributes: effective.requiredAttributes.map((entry) => ({ ...entry })), defaults: effective.defaults as ProductType['effective']['defaults'] },
    refs: {
      sizeScale: scale ? { id: scale.id, code: scale.code, name: scale.name } : null,
      labelTemplate: label ? { id: label.id, code: label.code, name: label.name, revision: label.revision } : null,
      measurementTemplate: template ? { ...template } : null,
    },
    children: all.filter((entry) => entry.parent === demo.n).map((entry) => ({ id: typeId(entry.n), code: entry.code, name: entry.name })),
    styles: demo.styles ?? 0,
  }
}

export const TYPES: ProductType[] = DEMO_TYPES.map((demo) => typeViewOf(demo, DEMO_TYPES))
export const typeOf = (code: string): ProductType => TYPES.find((type) => type.code === code)!

// ---- costing defaults ---------------------------------------------------------------------------------------------------

const rate = (n: number, kind: LabourRate['workCentreKind'], perMinute: string, efficiency: string, companyId: string | null): LabourRate => ({
  id: uid('2396', n),
  companyId,
  workCentreKind: kind,
  costPerMinute: perMinute as Money<'cost', string>,
  currency: 'EUR',
  plannedEfficiencyPct: efficiency,
  validFrom: '2026-09-01',
  note: null,
  status: 'ACTIVE',
  inForce: true,
  version: 1,
  createdAt: at(1),
  updatedAt: at(1),
})

const RATES: LabourRate[] = [
  rate(1, 'CUTTING', '0.48', '90', null),
  rate(2, 'SEWING', '0.42', '85', COMPANY_ID),
  rate(3, 'ASSEMBLY', '0.44', '85', null),
  rate(4, 'FINISHING', '0.38', '95', null),
  rate(5, 'INSPECTION', '0.40', '100', null),
]

const overheadRow = (id: string, companyId: string | null, pct: string) => ({ id, companyId, overheadPct: pct, overheadFromTenant: false, version: 1, updatedAt: at(1) })

export const COSTING: CostingDefaults = {
  rates: RATES,
  settings: { tenant: overheadRow(uid('2397', 1), null, '10'), company: overheadRow(uid('2397', 2), COMPANY_ID, '12'), inForce: uid('2397', 2) },
}

/** The same values as a role without the cost grain reads them (the server drops the cost per minute). */
export const COSTING_NO_GRAIN: CostingDefaults = { ...COSTING, rates: RATES.map(({ costPerMinute: _drop, ...rest }) => rest as LabourRate) }

// ---- who changed what ---------------------------------------------------------------------------------------------------

export const CHANGED = {
  rules: { at: at(27, 15, 20), by: 'Anna Demo' },
  tolerance: { at: at(21, 9, 5), by: 'Marco Demo' },
  types: { at: at(28, 14, 2), by: 'Anna Demo' },
}

export const AUDIT: AuditEntry[] = [
  { id: uid('2398', 1), at: at(27, 15, 20), action: 'product.settings.update', recordId: COMPANY_ID, after: { editRuleSampling: 'FREE' }, actorName: 'Anna Demo' },
  { id: uid('2398', 2), at: at(21, 9, 5), action: 'product.settings.update', recordId: COMPANY_ID, after: { consumptionToleranceByKind: { THREAD: { rule: 'MAY_DIFFER' } } }, actorName: 'Marco Demo' },
]

export { COMPANY_ID, ITEM_KINDS }
