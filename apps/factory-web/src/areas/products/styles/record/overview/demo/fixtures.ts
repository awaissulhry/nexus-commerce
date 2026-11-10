import { gtinOf } from '@nexus/factory-domain/product/gtin/rules'
import { DEFAULT_EDIT_RULES, editAllowance, LIFECYCLE_MOVES, isBackward, STYLE_LIFECYCLES, type EditRule, type StyleLifecycle } from '@nexus/factory-domain/product/lifecycle/rules'
import type { StyleView } from '../../../api'
import { BRANDS, COMPANY_ID, PREFIX, REV, STYLE_ID } from '../../../demo/fixtures'
import type { AssignView, GateSummaryRow, GtinRange, LifecycleView, PrivateLabelView, RangesView, StyleTypeView, TextsView, TypeView, WhereUsedView } from '../api'
import { depthCan, NO_ASSIGN, ready, type StyleDepthModel } from '../model'

/**
 * Made-up data for the depth's design cases (SCR-342): the invented jacket DEMO-JKT-01 of the styles' demo, its made-up
 * product types, names, brand, quotes, orders and GS1 range (the in-store prefix 2009999, never a company's real one).
 * The lifecycle's moves and what each kind of change may do come from factory-domain's own rules, as the API makes them.
 */

const at = (day: number, hour: number) => new Date(Date.UTC(2026, 10, day, hour)).toISOString()
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const OTHER_STYLE = { id: uid('7777', 102), code: 'DEMO-JKT-02', name: 'Giacca Touring Demo Evo' }
const OLD_STYLE = { id: uid('7777', 100), code: 'DEMO-JKT-00', name: 'Giacca Touring Demo (prima serie)' }

// ---- the lifecycle ------------------------------------------------------------------------------------------------------

export function demoLifecycle(state: StyleLifecycle, options: { rule?: EditRule; draft?: boolean; released?: boolean; replaced?: boolean; archived?: boolean } = {}): LifecycleView {
  const rule = options.rule ?? DEFAULT_EDIT_RULES[state]
  const draft = options.draft ?? true
  const released = options.released ?? true
  const refusalOf = (to: StyleLifecycle) =>
    options.archived
      ? { code: 'STYLE_ARCHIVED' as const, message: 'x' }
      : to === 'IN_PRODUCTION' && !released
        ? { code: 'NEEDS_RELEASED_REVISION' as const, message: 'x' }
        : null
  const kinds = editAllowance(rule, { code: 'DEMO-JKT-01', lifecycle: state, draftRevision: draft ? 3 : null })
  return {
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: COMPANY_ID, status: options.archived ? 'ARCHIVED' : 'ACTIVE', lifecycle: state, version: 9, changedAt: at(4, 9), changedById: uid('3333', 1) },
    replacedBy: options.replaced ? OTHER_STYLE : null,
    replaces: state === 'IN_PRODUCTION' || state === 'PHASE_OUT' ? [OLD_STYLE] : [],
    releasedRevision: released ? { id: REV.r2, revision: 2 } : null,
    draftRevision: draft ? { id: REV.r3, revision: 3 } : null,
    moves: LIFECYCLE_MOVES[state].map((to) => {
      const refusal = refusalOf(to)
      return { to, backward: isBackward(state, to), allowed: refusal === null, refusal }
    }),
    editRule: { state, rule, source: 'COMPANY', kinds: Object.entries(kinds).map(([kind, refusal]) => ({ kind: kind as keyof typeof kinds, refusal })) },
    rules: STYLE_LIFECYCLES.map((entry) => ({ state: entry, rule: entry === state ? rule : DEFAULT_EDIT_RULES[entry], source: entry === state ? ('COMPANY' as const) : ('DEFAULT' as const) })),
  }
}

// ---- the product type ---------------------------------------------------------------------------------------------------

const inherited = <T,>(value: T | null, from: string | null = null) => ({ value, fromTypeId: value === null ? null : from })

export function demoType(id: number, code: string, name: string, parent: { id: string; code: string; name: string } | null): TypeView {
  const typeId = uid('5151', id)
  return {
    id: typeId,
    code,
    name,
    nameI18n: null,
    companyId: id === 1 ? null : COMPANY_ID,
    productType: 'JACKET',
    parent,
    status: 'ACTIVE',
    version: 2,
    updatedAt: at(2, 10),
    own: { requiredAttributes: id === 1 ? ['season', 'hsCode'] : ['gender', 'nameI18n'], defaultSizeScaleId: null, labelTemplateId: null, measurementTemplateId: null, defaultPpeCategory: 'CATEGORY_II', defaultPpeStandard: 'EN 17092-4:2020', defaultPpeClass: 'AA' },
    effective: {
      requiredAttributes: [
        { name: 'season', fromTypeId: uid('5151', 1) },
        { name: 'hsCode', fromTypeId: uid('5151', 1) },
        ...(id === 1 ? [] : [{ name: 'gender', fromTypeId: typeId }, { name: 'nameI18n', fromTypeId: typeId }]),
      ],
      defaults: {
        defaultSizeScaleId: inherited<string>(null),
        labelTemplateId: inherited<string>(null),
        measurementTemplateId: inherited<string>(null),
        defaultPpeCategory: inherited('CATEGORY_II' as const, typeId),
        defaultPpeStandard: inherited('EN 17092-4:2020', typeId),
        defaultPpeClass: inherited('AA', typeId),
      },
    },
    refs: { sizeScale: null, labelTemplate: null, measurementTemplate: null },
    children: [],
    styles: id === 1 ? 4 : 2,
  }
}

const TOP = demoType(1, 'DEMO-PT-JKT', 'Giacca (demo)', null)
const TOURING = demoType(2, 'DEMO-PT-TOUR', 'Giacca touring (demo)', { id: TOP.id, code: TOP.code, name: TOP.name })
export const DEMO_TYPES: TypeView[] = [TOP, TOURING]

export function demoStyleType(options: { none?: boolean; missing?: string[] } = {}): StyleTypeView {
  return {
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', version: 9 },
    type: options.none ? null : TOURING,
    missing: options.missing ?? [],
    differs: options.none ? [] : [{ field: 'ppeClass', style: 'A', type: 'AA' }],
  }
}

// ---- names per language -------------------------------------------------------------------------------------------------

const textRow = (n: number, language: string, name: string, shortDescription: string | null, longDescription: string | null = null) => ({
  id: uid('5252', n),
  language,
  name,
  shortDescription,
  longDescription,
  version: 2,
  createdAt: at(3, 9),
  updatedAt: at(5, 11),
  createdById: uid('3333', 1),
})

export function demoTexts(options: { empty?: boolean; refused?: boolean } = {}): TextsView {
  return {
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: COMPANY_ID, version: 9 },
    companyLanguage: 'it',
    styleNames: options.empty ? {} : { it: 'Giacca Touring Demo', en: 'Demo Touring Jacket' },
    texts: options.empty
      ? []
      : [
          textRow(1, 'it', 'Giacca Touring Demo', 'Giacca da turismo in pelle con membrana impermeabile.', 'Pelle bovina 1,2 mm.\n\nProtezioni a spalle e gomiti.'),
          textRow(2, 'de', 'Demo Touren-Jacke', 'Leder-Tourenjacke mit wasserdichter Membran.'),
          textRow(3, 'fr', 'Veste Touring Démo', null),
        ],
    resolved: null,
    editRefusal: options.refused ? { code: 'EDIT_BLOCKED', message: 'x' } : null,
  }
}

// ---- the private label --------------------------------------------------------------------------------------------------

const BRAND = { id: BRANDS[0]!.id, code: BRANDS[0]!.code, name: BRANDS[0]!.tradeName ?? BRANDS[0]!.legalName }

export function demoPrivateLabel(options: { brand?: boolean; ours?: boolean; others?: boolean } = {}): PrivateLabelView {
  const brand = options.brand ? BRAND : null
  return {
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: COMPANY_ID, version: 9 },
    brand,
    soldUnderOurName: !!options.ours,
    shownTo: brand ? 'BRAND_ONLY' : 'EVERY_CUSTOMER',
    declarationSender: brand && !options.ours ? 'BRAND' : 'COMPANY',
    otherCustomers: options.others ? { openQuotes: 1, openOrders: 1, parties: [{ id: uid('6666', 9), code: 'CL-DEMO-07', name: 'Moto Esempio Bologna (demo)' }] } : { openQuotes: 0, openOrders: 0, parties: [] },
    warnings: [],
  }
}

// ---- where-used ---------------------------------------------------------------------------------------------------------

const party = (n: number, name: string) => ({ id: uid('6666', n), code: `CL-DEMO-0${n}`, name })
const used = (n: number, number: string, state: string, open: boolean, day: number | null, extra: Partial<WhereUsedView['groups'][number]['rows'][number]> = {}) => ({
  id: uid('5353', n),
  number,
  state,
  open,
  at: day === null ? null : `2026-11-${String(day).padStart(2, '0')}`,
  party: null,
  companyId: COMPANY_ID,
  siteId: null,
  detail: null,
  pieces: null,
  ...extra,
})

export function demoWhereUsed(options: { none?: boolean; limited?: boolean } = {}): WhereUsedView {
  const group = (kind: WhereUsedView['groups'][number]['kind'], rows: WhereUsedView['groups'][number]['rows'], allowed = true, onHand: number | null = null) => ({
    kind,
    allowed,
    count: allowed ? rows.length : 0,
    open: allowed ? rows.filter((row) => row.open).length : 0,
    rows: allowed ? rows : [],
    more: false,
    onHand: allowed ? onHand : null,
  })
  if (options.none) return { style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: COMPANY_ID, brand: null }, groups: (['QUOTES', 'SALES_ORDERS', 'WORK_ORDERS', 'STOCK', 'PRICE_LISTS', 'SAMPLE_ROUNDS', 'CERTIFICATES'] as const).map((kind) => group(kind, [])) }
  const sales = !options.limited
  return {
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: COMPANY_ID, brand: null },
    groups: [
      group('QUOTES', [used(1, 'Q-DEMO-0012', 'SENT', true, 6, { party: party(1, 'Moto Esempio Torino (demo)'), detail: 'NERO, ROSSO · 46–56' }), used(2, 'Q-DEMO-0009', 'APPROVED', true, 2, { party: party(2, 'Scuderia Demo (demo)') }), used(3, 'Q-DEMO-0004', 'ACCEPTED', false, null, { party: party(1, 'Moto Esempio Torino (demo)') })], sales),
      group('SALES_ORDERS', [used(4, 'SO-DEMO-0031', 'IN_PRODUCTION', true, 3, { party: party(1, 'Moto Esempio Torino (demo)'), detail: 'NERO · 48–54', pieces: 24 }), used(5, 'SO-DEMO-0018', 'SHIPPED', false, null, { party: party(2, 'Scuderia Demo (demo)'), pieces: 12 })], sales),
      group('WORK_ORDERS', [used(6, 'WO-DEMO-0044', 'IN_PROGRESS', true, 9, { detail: 'rev 2 · NERO', pieces: 24 }), used(7, 'WO-DEMO-0040', 'RELEASED', true, 12, { detail: 'rev 2 · ROSSO', pieces: 18 }), used(8, 'WO-DEMO-0031', 'COMPLETED', false, null, { detail: 'rev 2 · NERO', pieces: 12 })]),
      group('STOCK', [used(9, 'DEMO-JKT-01-NERO-52', 'ON_HAND', true, null, { pieces: 8 }), used(10, 'DEMO-JKT-01-ROSSO-50', 'ON_HAND', true, null, { pieces: 4 })], true, 12),
      group('PRICE_LISTS', [used(11, 'PL-DEMO-BASE', 'ACTIVE', true, 1, { detail: 'v3' })], sales),
      group('SAMPLE_ROUNDS', [used(12, 'SR-DEMO-0007', 'UNDER_REVIEW', true, 8, { detail: 'Fit 2 · rev 3' })]),
      group('CERTIFICATES', [used(13, 'CE-DEMO-2026-118', 'VALID', true, null, { detail: 'NERO, ROSSO · 46–58' })]),
    ],
  }
}

// ---- completeness -------------------------------------------------------------------------------------------------------

export function demoGate(options: { released?: boolean; ready?: boolean } = {}): GateSummaryRow {
  if (options.released) return { styleId: STYLE_ID, code: 'DEMO-JKT-01', revision: { id: REV.r2, revision: 2, status: 'RELEASED' }, checked: false, completenessPct: '90', blockers: 0, warnings: 0, first: null, open: 0 }
  if (options.ready) return { styleId: STYLE_ID, code: 'DEMO-JKT-01', revision: { id: REV.r3, revision: 3, status: 'DRAFT' }, checked: true, completenessPct: '100', blockers: 0, warnings: 0, first: null, open: 0 }
  return { styleId: STYLE_ID, code: 'DEMO-JKT-01', revision: { id: REV.r3, revision: 3, status: 'DRAFT' }, checked: true, completenessPct: '70', blockers: 1, warnings: 2, first: { code: 'BOM', state: 'BLOCKED', message: 'x', fix: 'bom' }, open: 3 }
}

// ---- GTINs from a range -------------------------------------------------------------------------------------------------

const PREFIX_GS1 = '2009999'
export function demoRange(options: { left?: number } = {}): GtinRange {
  const next = 120
  const last = options.left === undefined ? 999 : next + options.left - 1
  return { id: uid('5454', 1), companyId: COMPANY_ID, name: 'Blocco demo', gs1Prefix: PREFIX_GS1, firstReference: 100, lastReference: last, nextReference: next, left: Math.max(0, last - next + 1), used: true, nextGtin: last >= next ? gtinOf(PREFIX_GS1, next) : null, status: 'ACTIVE', version: 4, createdAt: at(1, 9), updatedAt: at(6, 15) }
}

export function demoRanges(options: { none?: boolean; closed?: boolean } = {}): RangesView {
  return { ranges: options.none ? [] : [demoRange()], allocation: options.closed ? { open: false, refusal: 'GATE_SPEND', message: 'x' } : { open: true, refusal: null, message: null } }
}

/** The preview (or the answer) for the SKUs switched on without a GTIN, from reference 120 (121 is on a SKU already). */
export function demoAssign(style: StyleView, options: { closed?: boolean; short?: number; dryRun?: boolean } = {}): AssignView {
  const waiting = style.skus.filter((sku) => sku.status === 'ACTIVE' && !sku.gtin)
  const short = options.short ?? 0
  const given = waiting.slice(0, waiting.length - short)
  let reference = 120
  const assignments = given.map((sku) => {
    if (reference === 121) reference++
    const row = { skuId: sku.id, sku: sku.sku, reference, gtin: gtinOf(PREFIX_GS1, reference) }
    reference++
    return row
  })
  const range = demoRange(short > 0 ? { left: given.length + 1 } : {})
  return {
    dryRun: options.dryRun ?? true,
    range: options.dryRun === false ? { ...range, nextReference: reference, left: Math.max(0, range.lastReference - reference + 1) } : range,
    rangeVersion: 4,
    assignments,
    skipped: [{ reference: 121, gtin: gtinOf(PREFIX_GS1, 121) }],
    count: assignments.length,
    short,
    notNumbered: [],
    allocation: options.closed ? { open: false, refusal: 'GATE_SPEND', message: 'x' } : { open: true, refusal: null, message: null },
  }
}

// ---- the model ----------------------------------------------------------------------------------------------------------

export const DEPTH_PERMISSIONS = {
  owner: ['product.styles.view', 'product.styles.manage', 'product.styles.lifecycle', 'product.gtins.manage'],
  production: ['product.styles.view', 'product.styles.manage', 'product.styles.lifecycle', 'product.gtins.manage'],
  sales: ['product.styles.view'],
} as const

export function depthModel(role: keyof typeof DEPTH_PERMISSIONS, overrides: Partial<StyleDepthModel> = {}): StyleDepthModel {
  return {
    prefix: PREFIX,
    styleId: STYLE_ID,
    styleCode: 'DEMO-JKT-01',
    companyId: COMPANY_ID,
    archived: false,
    can: depthCan(DEPTH_PERMISSIONS[role]),
    online: true,
    busy: false,
    notice: null,
    lifecycle: ready(demoLifecycle('IN_PRODUCTION')),
    type: ready(demoStyleType()),
    texts: ready(demoTexts()),
    privateLabel: ready(demoPrivateLabel()),
    whereUsed: ready(demoWhereUsed({ limited: role === 'production' })),
    gate: ready(demoGate()),
    dialog: null,
    types: ready(DEMO_TYPES),
    replacements: { query: '', found: null },
    matrixShow: 'state',
    assign: NO_ASSIGN,
    problem: null,
    ...overrides,
  }
}
