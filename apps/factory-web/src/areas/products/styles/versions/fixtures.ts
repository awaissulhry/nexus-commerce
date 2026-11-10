import { asMoney } from '@nexus/factory-domain/money/marked'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import type { OrderRow, RequestRow, StyleDriftView, VersionsCompareView } from '../../changes/api'
import { ORDERS, REQUESTS } from '../../changes/demo/fixtures'
import { CAN, COLOURWAY_IDS as CW, COMPANY_ID, newStyle, recordModel, REV, STYLE_ID } from '../demo/fixtures'
import type { StyleRecordViewModel } from '../record/record-model'
import { StyleRecordView } from '../record/view/StyleRecordView'
import type { GateView, ReleasedScopeView } from '../release/api'
import { WHOLE, type ScopePick } from '../release/model'
import type { ReleaseModel } from '../release/use-release'
import type { StyleVersionsView } from './api'
import { versionsCan, type VersionsModel } from './model'

/**
 * SCR-348 — Style › Versions & changes and the Release modal on the release gate (B-W2b-245; design products.styles
 * style.versions: Revisions, Compare revisions, Change requests and orders, Orders on older revisions; pop:styles.compare;
 * pop:styles.release with the size spec and materials approved in the check and "Release only some colourways or sizes").
 * Made-up data only: the jacket DEMO-JKT-01 (revision 3 draft, revision 2 released for NERO and ANTR in 46–56, revision 1
 * obsolete), its changes, a quote on revision 1 — every name, number and price invented.
 */

const uid = (family: string, n: number) => `0190f0e2-${family}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
const STYLE = { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo' }
const SIZES = ['46', '48', '50', '52', '54', '56', '58']
const OWNER_PERMISSIONS = ['product.bom.view', 'product.bom.release', 'product.changes.view', 'product.changes.request', 'money.cost']

// ---- the revisions ---------------------------------------------------------------------------------------------------------

const person = { id: DEMO_USER.id, name: 'Alex Demo' }
export const VERSIONS: StyleVersionsView = {
  style: { id: STYLE.id, code: STYLE.code, name: STYLE.name, status: 'ACTIVE', companyId: COMPANY_ID },
  current: REV.r2,
  revisions: [
    { id: REV.r3, revision: 3, status: 'DRAFT', changeNote: 'Ginocchiere e gomitiere livello 2; cerniera a contrasto.', createdAt: at(24, 9), createdBy: person, releasedAt: null, releasedBy: null, effectiveFrom: null, effectiveTo: null, locked: false, lockedReason: null, workOrders: 0, quoteLines: 0, orderLines: 0 },
    { id: REV.r2, revision: 2, status: 'RELEASED', changeNote: 'Membrana impermeabile in tutto il busto.', createdAt: at(8, 9), createdBy: person, releasedAt: at(12, 15), releasedBy: { id: uid('3333', 2), name: 'Bianca Demo' }, effectiveFrom: '2026-10-12', effectiveTo: null, locked: true, lockedReason: 'x', workOrders: 4, quoteLines: 6, orderLines: 3 },
    { id: REV.r1, revision: 1, status: 'OBSOLETE', changeNote: null, createdAt: at(1, 9), createdBy: person, releasedAt: at(5, 11), releasedBy: person, effectiveFrom: '2026-10-05', effectiveTo: '2026-10-12', locked: true, lockedReason: 'x', workOrders: 2, quoteLines: 3, orderLines: 1 },
  ],
}
const ONE_REVISION: StyleVersionsView = { ...VERSIONS, current: null, revisions: [{ ...VERSIONS.revisions[2]!, id: REV.r1, status: 'DRAFT', releasedAt: null, releasedBy: null, locked: false, effectiveFrom: null, effectiveTo: null }] }

// ---- the compare: revision 2 → revision 3 ----------------------------------------------------------------------------------------

const head = (n: 2 | 3) => ({
  id: n === 2 ? REV.r2 : REV.r3,
  revision: n,
  status: n === 2 ? ('RELEASED' as const) : ('DRAFT' as const),
  label: `Rev ${n}`,
  note: n === 2 ? 'RELEASED 2026-10-12' : 'DRAFT',
  changeNote: null,
  releasedAt: n === 2 ? at(12, 15) : null,
  effectiveFrom: null,
  effectiveTo: null,
})
const sizes = (values: number[]) => Object.fromEntries(SIZES.map((size, index) => [size, values[index]!.toFixed(2)]))

export function demoCompare(options: { cost?: 'shown' | 'held' | 'absent'; same?: boolean } = {}): VersionsCompareView {
  const cost = options.cost ?? 'shown'
  const same = options.same ?? false
  const base: VersionsCompareView = {
    style: { id: STYLE.id, code: STYLE.code, name: STYLE.name, sizes: SIZES },
    before: head(2),
    after: head(3),
    sections: [
      { id: 'revision', label: 'Revision', fields: [{ id: 'labelTemplate', label: 'Garment label' }], sizes: [], lines: [{ id: REV.r3, label: 'Revision', detail: null, before: { fields: { labelTemplate: 'LT-DEMO-07 r2' } }, after: { fields: { labelTemplate: 'LT-DEMO-07 r2' } } }], totals: [], summary: { added: 0, removed: 0, changed: 0, unchanged: 1 } },
      {
        id: 'bom',
        label: 'BOM',
        fields: [
          { id: 'qty', label: 'Quantity' },
          { id: 'uom', label: 'Unit' },
          { id: 'wastagePct', label: 'Wastage %' },
        ],
        sizes: SIZES,
        lines: same
          ? [{ id: uid('4444', 2), label: '20 · FOD-MESH', detail: 'Fodera', before: { fields: { qty: '1.6', uom: 'M', wastagePct: '5' } }, after: { fields: { qty: '1.6', uom: 'M', wastagePct: '5' } } }]
          : [
              { id: uid('4444', 1), label: '10 · PEL-BOV-12', detail: 'Busto e maniche', before: { fields: { qty: null, uom: 'FT2', wastagePct: '18' }, sizes: sizes([6.6, 6.8, 7.0, 7.2, 7.4, 7.6, 7.8]) }, after: { fields: { qty: null, uom: 'FT2', wastagePct: '16' }, sizes: sizes([6.6, 6.8, 7.0, 7.3, 7.5, 7.7, 7.9]) } },
              { id: uid('4444', 8), label: '80 · PROT-GIN-L2', detail: 'Ginocchiere livello 2', before: null, after: { fields: { qty: '2', uom: 'PCS', wastagePct: '0' } } },
              { id: uid('4444', 2), label: '20 · FOD-MESH', detail: 'Fodera', before: { fields: { qty: '1.6', uom: 'M', wastagePct: '5' } }, after: { fields: { qty: '1.6', uom: 'M', wastagePct: '5' } } },
            ],
        totals: [{ id: 'lines', label: 'Lines', before: '7', after: same ? '7' : '8' }],
        summary: same ? { added: 0, removed: 0, changed: 0, unchanged: 1 } : { added: 1, removed: 0, changed: 1, unchanged: 1 },
      },
      {
        id: 'routing',
        label: 'Routing and minutes',
        fields: [{ id: 'standardMinutes', label: 'Standard minutes' }],
        sizes: [],
        lines: same ? [] : [{ id: uid('6206', 1), label: '45 · CUC-PROT', detail: 'Cucire tasche protezioni', before: { fields: { standardMinutes: '3.200' } }, after: { fields: { standardMinutes: '4.100' } } }],
        totals: [{ id: 'minutesPerGarment', label: 'Minutes per garment', before: '96.300', after: same ? '96.300' : '97.200' }],
        summary: same ? { added: 0, removed: 0, changed: 0, unchanged: 0 } : { added: 0, removed: 0, changed: 1, unchanged: 14 },
      },
    ],
    differs: same
      ? []
      : [
          { section: 'bom', label: 'BOM', added: 1, removed: 0, changed: 1 },
          { section: 'routing', label: 'Routing and minutes', added: 0, removed: 0, changed: 1 },
        ],
    words: 'x',
  }
  if (cost === 'absent') return base
  if (cost === 'held') return { ...base, cost: asMoney('cost', null) }
  const perSize = (values: number[]) => Object.fromEntries(SIZES.map((size, index) => [size, values[index]!.toFixed(2)]))
  return {
    ...base,
    cost: asMoney('cost', {
      id: 'cost' as const,
      label: 'Cost',
      fields: [
        { id: 'material', label: 'Material (size 52)' },
        { id: 'labour', label: 'Labour (size 52)' },
        { id: 'overhead', label: 'Overhead (size 52)' },
      ],
      sizes: SIZES,
      lines: [
        { id: CW.BLK, label: 'NERO', detail: 'Nero', before: { fields: { material: '182.40', labour: '74.10', overhead: '22.00' }, sizes: perSize([270, 273, 276, 278.5, 281, 284, 287]) }, after: { fields: { material: '196.80', labour: '76.90', overhead: '22.00' }, sizes: perSize([284, 287, 290, 295.7, 298, 301, 304]) } },
        { id: CW.ANT, label: 'ANTR', detail: 'Antracite', before: { fields: { material: '182.40', labour: '74.10', overhead: '22.00' }, sizes: perSize([270, 273, 276, 278.5, 281, 284, 287]) }, after: { fields: { material: '196.80', labour: '76.90', overhead: '22.00' }, sizes: perSize([284, 287, 290, 295.7, 298, 301, 304]) } },
      ],
      totals: [{ id: 'base', label: 'Cost per garment (NERO 52)', before: '278.50', after: '295.70' }],
      summary: { added: 0, removed: 0, changed: 2, unchanged: 0 },
      currency: 'EUR',
      companyId: COMPANY_ID,
      on: '2026-11-10',
      computedAt: at(31, 9),
      complete: { before: true, after: true },
      missing: [],
    }),
  }
}

// ---- the drift and the style's changes ----------------------------------------------------------------------------------------

export function demoDrift(options: { cost?: boolean; empty?: boolean } = {}): StyleDriftView {
  const cost = options.cost ?? true
  if (options.empty) return { style: STYLE, current: { id: REV.r2, revision: 2, status: 'RELEASED' }, rows: [], held: [] }
  const row = (n: number, kind: 'QUOTE' | 'ORDER', number: string, status: string, colourway: string, pieces: number, then: string, now: string, change: string) => ({
    kind,
    documentId: uid('6207', n),
    number,
    status,
    lineId: uid('6208', n),
    seq: 10 * n,
    colourway,
    pieces,
    revision: { id: REV.r1, revision: 1, status: 'OBSOLETE' as const },
    against: { id: REV.r2, revision: 2, status: 'RELEASED' as const },
    state: 'DIFFERENT' as const,
    differs: [{ section: 'bom' as const, label: 'BOM', added: 0, removed: 0, changed: 1 }],
    words: 'x',
    ...(cost
      ? {
          cost: asMoney('cost', {
            currency: 'EUR',
            complete: true,
            unitCostThen: asMoney('cost', then),
            unitCostNow: asMoney('cost', now),
            unitCostChange: asMoney('cost', change),
            costAmountThen: asMoney('cost', Math.round(Number(then) * 100 * pieces)),
            costAmountNow: asMoney('cost', Math.round(Number(now) * 100 * pieces)),
            costAmountChange: asMoney('cost', Math.round(Number(change) * 100 * pieces)),
          }),
        }
      : {}),
  })
  return {
    style: STYLE,
    current: { id: REV.r2, revision: 2, status: 'RELEASED' },
    rows: [row(1, 'QUOTE', 'Q-DEMO-0031', 'SENT', 'NERO', 120, '271.20', '278.50', '7.30'), row(2, 'ORDER', 'SO-DEMO-0042', 'CONFIRMED', 'ANTR', 40, '271.20', '278.50', '7.30')],
    held: [],
  }
}

const mine = <T extends { style: { id: string; code: string; name: string } }>(rows: readonly T[]): T[] => rows.map((row) => ({ ...row, style: STYLE }))
export const STYLE_REQUESTS: RequestRow[] = mine(REQUESTS).slice(0, 3)
export const STYLE_ORDERS: OrderRow[] = mine(ORDERS).slice(0, 2)

// ---- what the released revision is released for ------------------------------------------------------------------------------

export const RELEASED_PART: ReleasedScopeView = {
  style: { id: STYLE.id, code: STYLE.code },
  revision: { id: REV.r2, revision: 2, completenessPct: '83.33' },
  scope: { colourwayIds: [CW.BLK, CW.ANT], sizes: ['46', '48', '50', '52', '54', '56'], whole: false, words: 'x' },
  cells: ['NERO', 'ANTR'].flatMap((colourway) => ['46', '48', '50', '52', '54', '56'].map((size) => ({ colourwayId: colourway === 'NERO' ? CW.BLK : CW.ANT, colourway, size }))),
  waiting: 'x',
}
const RELEASED_WHOLE: ReleasedScopeView = { ...RELEASED_PART, scope: { colourwayIds: [], sizes: [], whole: true, words: 'x' } }

// ---- the tab's model ---------------------------------------------------------------------------------------------------------------

export function demoVersions(over: Partial<VersionsModel> = {}, permissions: readonly string[] = OWNER_PERMISSIONS): VersionsModel {
  const can = versionsCan(permissions)
  return {
    can,
    me: DEMO_USER.id,
    versions: { status: 'ready', value: VERSIONS },
    pair: { from: REV.r2, to: REV.r3 },
    compare: { status: 'ready', value: demoCompare({ cost: can.cost ? 'shown' : 'absent' }) },
    changes: can.changes ? { status: 'ready', value: { requests: STYLE_REQUESTS, orders: STYLE_ORDERS, complete: true } } : null,
    drift: { status: 'ready', value: demoDrift({ cost: can.cost }) },
    released: { status: 'ready', value: RELEASED_PART },
    compareOpen: false,
    ...over,
  }
}

// ---- the release gate ------------------------------------------------------------------------------------------------------------

type Item = GateView['items'][number]
const cell = (over: Partial<Item['findings'][number]['cell']> = {}) => ({ lineId: null, column: null, size: null, colourwayId: null, alternateId: null, stepId: null, recordId: null, field: null, ...over })
const finding = (code: Item['findings'][number]['code'], severity: 'BLOCKER' | 'WARNING', over: Partial<Item['findings'][number]['cell']> = {}) => ({ code, severity, message: 'x', cell: cell(over) })
const item = (code: Item['code'], state: Item['state'], fix: Item['fix'], findings: Item['findings'] = []): Item => ({ code, state, scored: code !== 'SCOPE' && code !== 'DRIFT', fix, message: 'x', findings })

const COLOURWAYS = [
  { id: CW.BLK, code: 'NERO', name: 'Nero', status: 'ACTIVE' as const },
  { id: CW.ANT, code: 'ANTR', name: 'Antracite', status: 'ACTIVE' as const },
  { id: CW.RED, code: 'ROSSO', name: 'Rosso corsa', status: 'ACTIVE' as const },
]

export function demoGate(options: { blocked?: boolean; asked?: ScopePick; mode?: 'release' | 'widen' } = {}): GateView {
  const blocked = options.blocked ?? true
  const widen = options.mode === 'widen'
  const asked = options.asked ?? (widen ? { colourwayIds: [CW.BLK, CW.ANT], sizes: ['46', '48', '50', '52', '54', '56'] } : WHOLE)
  const planned = widen ? { colourwayIds: [CW.BLK, CW.ANT], sizes: ['46', '48', '50', '52', '54', '56'] } : WHOLE
  const inList = (list: readonly string[], value: string) => list.length === 0 || list.includes(value)
  const scopeView = (pick: ScopePick) => ({ colourwayIds: [...pick.colourwayIds], sizes: [...pick.sizes], whole: pick.colourwayIds.length === 0 && pick.sizes.length === 0, words: 'x' })
  const items: Item[] = widen
    ? [item('CERTIFICATE', 'WARNING', 'compliance', [finding('CELL_NOT_COVERED', 'WARNING', { colourwayId: CW.RED, size: '58' })]), item('SCOPE', 'OK', 'release')]
    : [
        item('BOM', 'OK', 'bom'),
        item('ROUTING', 'OK', 'routing'),
        item('SMV', 'WARNING', 'minutes', [finding('SMV_CHANGE_WAITING', 'WARNING', { stepId: uid('2222', 3) })]),
        blocked ? item('MATERIALS', 'BLOCKED', 'materials', [finding('MATERIAL_BLOCKED', 'BLOCKER', { lineId: uid('4444', 6), column: 'itemId' }), finding('MATERIAL_PENDING', 'WARNING', { lineId: uid('4444', 2) })]) : item('MATERIALS', 'WARNING', 'materials', [finding('MATERIAL_PENDING', 'WARNING', { lineId: uid('4444', 2) })]),
        item('PRICES', 'OK', 'materials'),
        item('LABEL', 'OK', 'labels'),
        item('CERTIFICATE', 'WARNING', 'compliance', [finding('CELL_NOT_COVERED', 'WARNING', { colourwayId: CW.RED, size: '58' }), finding('CELL_NOT_COVERED', 'WARNING', { colourwayId: CW.BLK, size: '58' })]),
        item('MEASUREMENTS', 'WARNING', 'measurements', [finding('SPEC_NOT_APPROVED', 'WARNING')]),
        item('ATTRIBUTES', 'OK', 'type'),
        item('CHANGE_ORDERS', 'NOT_REQUIRED', 'changes'),
        item('SCOPE', 'OK', 'release'),
        item('DRIFT', 'WARNING', 'versions', [finding('OPEN_QUOTES', 'WARNING')]),
      ]
  return {
    revision: widen ? { id: REV.r2, styleId: STYLE.id, revision: 2, status: 'RELEASED', version: 5 } : { id: REV.r3, styleId: STYLE.id, revision: 3, status: 'DRAFT', version: 7 },
    style: { id: STYLE.id, code: STYLE.code, name: STYLE.name, status: 'ACTIVE', companyId: COMPANY_ID },
    date: '2026-11-10',
    checked: !widen,
    items,
    blockers: [],
    warnings: [],
    completenessPct: widen ? '83.33' : blocked ? '50' : '60',
    releasable: !widen && !blocked,
    heldBy: blocked ? 'x' : null,
    scope: {
      planned: scopeView(planned),
      asked: scopeView(asked),
      suggested: widen ? null : { colourwayIds: [], sizes: ['46', '48', '50', '52', '54', '56'], whole: false, words: 'x' },
      waiting: null,
      colourways: COLOURWAYS.map((entry) => ({ ...entry, planned: inList(planned.colourwayIds, entry.id), asked: inList(asked.colourwayIds, entry.id) })),
      sizes: SIZES.map((size) => ({ code: size, label: size, planned: inList(planned.sizes, size), asked: inList(asked.sizes, size) })),
    },
    effects: ['x'],
    mayRelease: true,
  }
}

const releaseModel = (over: Partial<ReleaseModel> = {}, gate: GateView = demoGate()): ReleaseModel => ({
  revisionId: gate.revision.id,
  mode: gate.revision.status === 'RELEASED' ? 'widen' : 'release',
  gate: { status: 'ready', value: gate },
  pick: gate.revision.status === 'RELEASED' ? { colourwayIds: [CW.BLK, CW.ANT], sizes: ['46', '48', '50', '52', '54', '56'] } : WHOLE,
  none: { colourways: false, sizes: false },
  partial: gate.revision.status === 'RELEASED',
  previewing: false,
  busy: false,
  problem: null,
  ...over,
})
const PART: ScopePick = { colourwayIds: [CW.BLK, CW.ANT], sizes: ['46', '48', '50', '52', '54', '56'] }

// ---- the cases -------------------------------------------------------------------------------------------------------------------

const tab = (over: Partial<StyleRecordViewModel> = {}, versions: Partial<VersionsModel> = {}, permissions?: readonly string[]): StyleRecordViewModel =>
  recordModel('owner', { tab: 'versions', versions: demoVersions(versions, permissions), ...over })
const production = (versions: Partial<VersionsModel> = {}) => recordModel('production', { tab: 'versions', versions: demoVersions(versions, ['product.bom.view', 'product.bom.release', 'product.changes.view', 'product.changes.request']) })

export const designScreen = defineDesignScreen<StyleRecordViewModel>({
  screen: 'SCR-348',
  title: 'Style › Versions & changes, Compare revisions, Release on the gate',
  view: StyleRecordView,
  cases: [
    { id: 'versions', label: 'Versions & changes (owner)', model: tab(), note: 'Revisions with what changed, who released them and the records made from each; revision 2 released for NERO and ANTR in 46–56 (Release more…); the compare of revision 2 → 3 with the cost difference; the style\'s changes; a quote and an order on revision 1 with the cost difference per garment.' },
    { id: 'production', label: 'Production manager (no cost grain)', model: production(), note: 'No cost difference anywhere: "not in your role".' },
    { id: 'reader', label: 'Reads the BOM, no changes, no release', model: recordModel('production', { can: CAN.viewer, tab: 'versions', versions: demoVersions({}, ['product.bom.view']) }), note: 'Change requests and orders are not drawn (not in the role); Release and Release more are held with why.' },
    { id: 'one-revision', label: 'A new style: one revision', model: recordModel('owner', { tab: 'versions', style: { status: 'ready', value: newStyle() }, revisionId: REV.r1, versions: demoVersions({ versions: { status: 'ready', value: ONE_REVISION }, pair: null, compare: { status: 'idle' }, changes: { status: 'ready', value: { requests: [], orders: [], complete: true } }, drift: { status: 'ready', value: demoDrift({ empty: true }) }, released: { status: 'ready', value: { ...RELEASED_WHOLE, revision: null, scope: null, cells: [] } } }) }), note: 'Nothing to compare yet; no changes raised; Orders on older revisions hidden.' },
    { id: 'whole', label: 'Released for every colourway and size', model: tab({}, { released: { status: 'ready', value: RELEASED_WHOLE }, drift: { status: 'ready', value: demoDrift({ empty: true }) } }), note: 'No Release more; no drift card.' },
    { id: 'cost-held', label: 'Cost difference without costing for the company', model: tab({}, { compare: { status: 'ready', value: demoCompare({ cost: 'held' }) } }) },
    { id: 'same', label: 'Two revisions with the same spec', model: tab({}, { compare: { status: 'ready', value: demoCompare({ same: true, cost: 'absent' }) } }) },
    { id: 'loading', label: 'Reading', model: tab({}, { versions: { status: 'loading' }, compare: { status: 'loading' }, changes: { status: 'loading' }, drift: { status: 'loading' }, released: { status: 'loading' } }) },
    { id: 'error', label: 'Reads failed', model: tab({}, { versions: { status: 'error', problem: 'problem.unavailable' }, changes: { status: 'error', problem: 'problem.unavailable' }, drift: { status: 'error', problem: 'problem.unavailable' }, released: { status: 'error', problem: 'problem.unavailable' } }), note: 'Each part says it failed with Try again; never drawn as empty.' },
    { id: 'compare-error', label: 'The compare failed', model: tab({}, { compare: { status: 'error', problem: 'problem.forbidden' } }) },
    { id: 'compare-dialog', label: 'Compare revisions (pop-up)', model: tab({}, { compareOpen: true }), note: 'From the band\'s ⋯ or the tab\'s "Open wide"; Esc closes.' },
    { id: 'compare-older', label: 'Compare revision 1 → 2', model: tab({}, { compareOpen: true, pair: { from: REV.r1, to: REV.r2 } }) },
    { id: 'release-held', label: 'Release revision 3: a blocked material holds it', model: recordModel('owner', { release: releaseModel() }), note: 'The gate in our words with Fix per item: size spec not approved (W2b), materials approved (W2b) — a blocked material stops it; "Fix first: Materials approved".' },
    { id: 'release-ready', label: 'Release revision 3: passes with warnings', model: recordModel('owner', { release: releaseModel({}, demoGate({ blocked: false })) }), note: 'What happens, in words; the warnings are kept by the release.' },
    { id: 'release-partial', label: 'Release only some colourways or sizes', model: recordModel('owner', { release: releaseModel({ partial: true, pick: PART }, demoGate({ blocked: false, asked: PART })) }), note: 'ROSSO and 58 wait for a later release; the suggested scope leaves out what no certificate covers.' },
    { id: 'release-none', label: 'Release scope: nothing picked', model: recordModel('owner', { release: releaseModel({ partial: true, pick: { colourwayIds: [], sizes: ['46'] }, none: { colourways: true, sizes: false } }, demoGate({ blocked: false })) }), note: 'Held: "Pick at least one colourway and one size".' },
    { id: 'release-previewing', label: 'Release scope: the preview is read', model: recordModel('owner', { release: releaseModel({ partial: true, pick: PART, previewing: true }, demoGate({ blocked: false })) }) },
    { id: 'release-reading', label: 'Release: the check is read', model: recordModel('owner', { release: releaseModel({ gate: { status: 'loading' } }) }) },
    { id: 'release-failed', label: 'Release: the check failed', model: recordModel('owner', { release: releaseModel({ gate: { status: 'error', problem: 'fault.unavailable' } }) }) },
    { id: 'release-refused', label: 'Release refused (a change order holds the draft)', model: recordModel('owner', { release: releaseModel({ problem: { ns: 'changes', key: 'refusal.DRAFT_UNDER_CHANGE_ORDER' } }, demoGate({ blocked: false })) }) },
    { id: 'release-no-right', label: 'Release: production manager without the release right', model: recordModel('production', { can: { ...CAN.production, release: false }, release: releaseModel({}, demoGate({ blocked: false })) }), note: 'Held: "Your role does not release revisions."' },
    { id: 'widen', label: 'Release more of revision 2', model: recordModel('owner', { tab: 'versions', versions: demoVersions(), release: releaseModel({ pick: { colourwayIds: [], sizes: ['46', '48', '50', '52', '54', '56'] } }, demoGate({ mode: 'widen', asked: { colourwayIds: [], sizes: ['46', '48', '50', '52', '54', '56'] } })) }), note: 'Released NERO and ANTR stay ticked and fixed; ROSSO added.' },
    { id: 'widen-held', label: 'Release more: nothing added yet', model: recordModel('owner', { tab: 'versions', versions: demoVersions(), release: releaseModel({}, demoGate({ mode: 'widen' })) }), note: 'Held: "Add a colourway or a size first."' },
  ],
})
