import { createElement } from 'react'
import { defaultSectionLayout } from '@nexus/ui/patterns'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { inShell, PREFIX, ROLE_PERMISSIONS, uid, type RoleCase } from '../../quality/_shared/fixtures'
import type { Actions, Board, BoardRow, Cell, CellDetail, Expiries, Feed, FixPlace, GateEvent } from './api'
import { EMPTY_ADDRESS, statusCan, type StatusAddress } from './model'
import { StatusView } from './view/StatusView'
import { STATUS_SECTIONS, type StatusModel } from './view/types'

/**
 * SCR-119 — Compliance › Status board with made-up styles, brands, certificates, declarations, work orders and shipments only
 * ("Demo" names, DEMO- codes, invented numbers): the owner's whole board, each part's states (loading as skeletons, a failed part
 * while the others stand, nothing yet), the filters (a tile, a gap from the reports, nothing matching, Cr VI), the cell checklist
 * (loading, failed), "See all", the override (draft, problems, refused, the code), offline, Arrange, the keys, the evidence
 * finder, the roles (quality inspector, production manager, read only) and no right.
 */

const NOW = '2026-11-10T09:42:00.000Z'
const TODAY = '2026-11-10'
const MARKETS = [
  { code: 'IT', name: 'Italia', switchedOn: true },
  { code: 'DE', name: 'Germania', switchedOn: true },
  { code: 'FR', name: 'Francia', switchedOn: true },
  { code: 'ES', name: 'Spagna', switchedOn: true },
]
const BRAND = { id: uid('7302', 1), code: 'DEMO-B1', name: 'Marchio Demo Uno' }
const ids = { jacket: uid('7301', 1), trousers: uid('7301', 2), gloves: uid('7301', 3), suit: uid('7301', 4), vest: uid('7301', 5) }

const ready = (marketCode: string): Cell => ({ marketCode, state: 'READY', words: 'Ready', missing: 0, blocking: 0, expiring: 0, manual: 1, blockedGates: [], first: null })
const blocked = (marketCode: string, code: string, message: string, fixPlace: FixPlace = 'declarations', gates: Cell['blockedGates'] = ['WORK_ORDER_RELEASE', 'SHIPMENT']): Cell => ({
  marketCode,
  state: 'BLOCKED',
  words: 'Blocked',
  missing: 2,
  blocking: 1,
  expiring: 0,
  manual: 1,
  blockedGates: gates,
  first: { code, message, fix: 'Issue the document in the market\'s language.', who: 'COMPLIANCE', fixPlace, legalReference: 'Reg. (EU) 2016/425 art. 15' },
})
const missing = (marketCode: string): Cell => ({ marketCode, state: 'MISSING', words: 'Missing 1', missing: 1, blocking: 0, expiring: 0, manual: 1, blockedGates: [], first: { code: 'LABEL-LANGUAGE', message: 'The label has no French text yet.', fix: 'Add French to the label template.', who: 'COMPLIANCE', fixPlace: 'labels', legalReference: 'Reg. (EU) 2016/425 Annex II 1.4' } })
const expiring = (marketCode: string): Cell => ({ marketCode, state: 'EXPIRING', words: 'Expiring', missing: 0, blocking: 0, expiring: 1, manual: 1, blockedGates: [], first: { code: 'CERT-COVERAGE', message: 'Certificate DEMO-CERT-0001 ends on 08/12/2026.', fix: 'Start the renewal with the notified body.', who: 'COMPLIANCE', fixPlace: 'certificates', legalReference: 'Reg. (EU) 2016/425 Annex V' } })

const style = (id: string, code: string, name: string, brand: BoardRow['style']['brand'] = null, ppeCategory = 'CATEGORY_II', productType = 'JACKET'): BoardRow['style'] => ({ id, code, name, companyId: null, ppeCategory, productType, brand, soldUnderOurName: brand === null })
const ROWS: BoardRow[] = [
  { style: style(ids.jacket, 'DEMO-JKT-01', 'Giacca Demo Touring'), cells: [ready('IT'), blocked('DE', 'USER-INFO-LANGUAGE', 'The user information has no issued de version for Germany.'), missing('FR'), ready('ES')], ready: false, blocked: true },
  { style: style(ids.trousers, 'DEMO-TRS-02', 'Pantalone Demo Città', BRAND, 'CATEGORY_II', 'TROUSERS'), cells: [ready('IT'), ready('DE'), ready('FR'), ready('ES')], ready: true, blocked: false },
  { style: style(ids.gloves, 'DEMO-GLV-03', 'Guanto Demo Estate', null, 'CATEGORY_II', 'GLOVES'), cells: [expiring('IT'), expiring('DE'), expiring('FR'), expiring('ES')], ready: false, blocked: false },
  { style: style(ids.suit, 'DEMO-SUT-04', 'Tuta Demo Pista', BRAND, 'CATEGORY_III', 'SUIT'), cells: [blocked('IT', 'CERT-COVERAGE', 'No valid certificate covers size 58.', 'certificates', ['WORK_ORDER_RELEASE', 'LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT']), blocked('DE', 'CERT-COVERAGE', 'No valid certificate covers size 58.', 'certificates', ['WORK_ORDER_RELEASE', 'LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT']), missing('FR'), ready('ES')], ready: false, blocked: true },
  { style: style(ids.vest, 'DEMO-VST-05', 'Gilet Demo Airbag', null, 'NOT_PPE', 'VEST'), cells: [ready('IT'), blocked('DE', 'EU-OPERATOR', 'No economic operator is named for Germany.', 'operators', ['SHIPMENT']), ready('FR'), ready('ES')], ready: false, blocked: true },
]

const LINES: Actions['lines'] = [
  { styleId: ids.suit, styleCode: 'DEMO-SUT-04', marketCode: 'IT', requirementCode: 'CERT-COVERAGE', words: 'DEMO-SUT-04 cannot ship to Italia: No valid certificate covers size 58. Compliance · Ask the notified body.', who: 'COMPLIANCE', fixPlace: 'certificates', severity: 'BLOCKED' },
  { styleId: ids.suit, styleCode: 'DEMO-SUT-04', marketCode: 'DE', requirementCode: 'CERT-COVERAGE', words: 'DEMO-SUT-04 cannot ship to Germania: No valid certificate covers size 58.', who: 'COMPLIANCE', fixPlace: 'certificates', severity: 'BLOCKED' },
  { styleId: ids.jacket, styleCode: 'DEMO-JKT-01', marketCode: 'DE', requirementCode: 'USER-INFO-LANGUAGE', words: 'DEMO-JKT-01 cannot ship to Germania: The user information has no issued de version.', who: 'COMPLIANCE', fixPlace: 'declarations', severity: 'BLOCKED' },
  { styleId: ids.vest, styleCode: 'DEMO-VST-05', marketCode: 'DE', requirementCode: 'EU-OPERATOR', words: 'DEMO-VST-05 cannot ship to Germania: No economic operator is named.', who: 'COMPLIANCE', fixPlace: 'operators', severity: 'BLOCKED' },
  { styleId: ids.jacket, styleCode: 'DEMO-JKT-01', marketCode: 'FR', requirementCode: 'LABEL-LANGUAGE', words: 'DEMO-JKT-01 for Francia: The label has no French text yet.', who: 'COMPLIANCE', fixPlace: 'labels', severity: 'MISSING' },
]
export const MORE_LINES: Actions['lines'] = [
  ...LINES,
  { styleId: ids.suit, styleCode: 'DEMO-SUT-04', marketCode: 'FR', requirementCode: 'LABEL-LANGUAGE', words: 'DEMO-SUT-04 for Francia: The label has no French text yet.', who: 'COMPLIANCE', fixPlace: 'labels', severity: 'MISSING' },
  ...(['IT', 'DE', 'FR', 'ES'] as const).map((market) => ({ styleId: ids.gloves, styleCode: 'DEMO-GLV-03', marketCode: market, requirementCode: 'CERT-COVERAGE', words: 'DEMO-GLV-03: certificate ends soon.', who: 'COMPLIANCE' as const, fixPlace: 'certificates' as const, severity: 'EXPIRING' as const })),
]

export const BOARD: Board = {
  markets: MARKETS,
  tiles: { stylesReady: 1, stylesBlocked: 3, certificatesExpiring90: 2, lotsWithoutCrVi: 2, missingLanguages: 1, shipmentsHeld: 1 },
  rows: ROWS,
  more: false,
  needsAction: { lines: LINES, count: MORE_LINES.length },
  asOf: NOW,
}

const CELL: CellDetail = {
  style: { id: ids.jacket, code: 'DEMO-JKT-01', name: 'Giacca Demo Touring', ppeCategory: 'CATEGORY_II', productType: 'JACKET' },
  market: MARKETS[1]!,
  cell: ROWS[0]!.cells[1]!,
  items: [
    {
      requirement: { id: uid('7303', 1), code: 'CERT-COVERAGE', name: 'Certificate covers every size', nameI18n: { it: 'Il certificato copre ogni taglia', en: 'Certificate covers every size' }, legalReference: 'Reg. (EU) 2016/425 Annex V', explanationI18n: { it: 'Ogni taglia venduta è coperta da un certificato UE del tipo valido.', en: 'Every size sold is covered by a valid EU type-examination certificate.' }, blocks: ['WORK_ORDER_RELEASE', 'LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT'], lockedBlocks: ['LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT'] },
      check: 'certificate.coverage',
      state: 'OK',
      message: 'Certificate DEMO-CERT-0002 covers sizes 46-58 until 11/03/2029.',
      fix: null,
      evidence: { recordType: 'Certificate', recordId: uid('7304', 2), label: 'DEMO-CERT-0002' },
      who: 'COMPLIANCE',
      fixPlace: 'certificates',
    },
    {
      requirement: { id: uid('7303', 2), code: 'DOC-LANGUAGE', name: 'DoC in the market\'s language', nameI18n: { it: 'DoC nella lingua del mercato', en: 'DoC in the market\'s language' }, legalReference: 'Reg. (EU) 2016/425 art. 15', explanationI18n: { it: 'La dichiarazione UE di conformità è tradotta nelle lingue del mercato.', en: 'The EU declaration of conformity is translated into the market\'s languages.' }, blocks: ['SHIPMENT'], lockedBlocks: [] },
      check: 'doc.languages',
      state: 'OK',
      message: 'An issued DoC in German exists.',
      fix: null,
      evidence: { recordType: 'ComplianceDocument', recordId: uid('7305', 1), label: 'DEMO-DOC-0001 (de)' },
      who: 'COMPLIANCE',
      fixPlace: 'declarations',
    },
    {
      requirement: { id: uid('7303', 3), code: 'USER-INFO-LANGUAGE', name: 'User information in the market\'s language', nameI18n: { it: 'Nota informativa nella lingua del mercato', en: 'User information in the market\'s language' }, legalReference: 'Reg. (EU) 2016/425 Annex II 1.4', explanationI18n: { it: 'La nota informativa accompagna ogni DPI nella lingua del paese.', en: 'The user information goes with every PPE in the country\'s language.' }, blocks: ['WORK_ORDER_RELEASE', 'SHIPMENT'], lockedBlocks: [] },
      check: 'userInfo.languages',
      state: 'MISSING',
      message: 'The user information has no issued de version for Germany.',
      fix: 'Issue the user information in German.',
      evidence: null,
      who: 'COMPLIANCE',
      fixPlace: 'declarations',
    },
    {
      requirement: { id: uid('7303', 4), code: 'LABEL-LANGUAGE', name: 'Label in the market\'s languages', nameI18n: { it: 'Etichetta nelle lingue del mercato', en: 'Label in the market\'s languages' }, legalReference: 'Reg. (EU) 2016/425 Annex II 2.12', explanationI18n: { it: 'Le avvertenze in etichetta sono nella lingua del paese.', en: 'The label\'s warnings are in the country\'s language.' }, blocks: ['LABEL_PRINT'], lockedBlocks: [] },
      check: 'label.languages',
      state: 'EXPIRING',
      message: 'The German label text is approved until 31/12/2026.',
      fix: 'Approve the new label artwork.',
      evidence: null,
      who: 'COMPLIANCE',
      fixPlace: 'labels',
    },
    {
      requirement: { id: uid('7303', 5), code: 'CRVI-EVIDENCE', name: 'Cr VI evidence for the leather lots', nameI18n: { it: 'Prova Cr VI per i lotti di pelle', en: 'Cr VI evidence for the leather lots' }, legalReference: 'Reg. (EC) 1907/2006 Annex XVII 47', explanationI18n: { it: 'La pelle a contatto con la pelle ha meno di 3 mg/kg di cromo VI.', en: 'Leather in contact with skin has less than 3 mg/kg of chromium VI.' }, blocks: [], lockedBlocks: [] },
      check: 'MANUAL',
      state: 'MANUAL',
      message: 'A person checks the lots in stock.',
      fix: 'Record the lots\' test results.',
      evidence: null,
      who: 'QUALITY',
      fixPlace: 'tests',
    },
    {
      requirement: { id: uid('7303', 6), code: 'TEXTILE-SHARE-IT', name: 'Fibre share (Italy)', nameI18n: { it: 'Composizione fibre (Italia)', en: 'Fibre share (Italy)' }, legalReference: 'Reg. (EU) 1007/2011', explanationI18n: { it: 'Composizione fibrosa in etichetta.', en: 'Fibre composition on the label.' }, blocks: [], lockedBlocks: [] },
      check: 'textile.share',
      state: 'NOT_NEEDED',
      message: 'Only for market IT.',
      fix: null,
      evidence: null,
      who: 'COMPLIANCE',
      fixPlace: 'requirements',
    },
  ],
  asOf: NOW,
}

const event = (over: Partial<GateEvent> & Pick<GateEvent, 'id'>): GateEvent => ({
  at: '2026-11-09T14:12:00.000Z',
  gate: 'WORK_ORDER_RELEASE',
  place: 'work-order release',
  outcome: 'REFUSED',
  subject: { type: 'WorkOrder', id: uid('7306', 1), number: 'DEMO-WO-0142', status: 'PLANNED' },
  site: { id: uid('7307', 1), code: 'DEMO-S1' },
  style: { id: ids.jacket, code: 'DEMO-JKT-01' },
  colourway: 'NERO',
  size: '54',
  marketCode: 'DE',
  requirement: { id: uid('7303', 3), code: 'USER-INFO-LANGUAGE', name: 'User information in the market\'s language', legalReference: 'Reg. (EU) 2016/425 Annex II 1.4', locked: false, overrideRoleKeys: ['quality_inspector'], overrideMaxDays: 3 },
  reason: 'Work order DEMO-WO-0142 (NERO 54) for Germany (DE) cannot be released: The user information has no issued de version.',
  state: 'BLOCKED',
  refusedEventId: null,
  overrideUntil: null,
  by: null,
  overrides: [],
  mayOverride: true,
  ...over,
})
const EVENTS: GateEvent[] = [
  event({ id: uid('7308', 1) }),
  event({
    id: uid('7308', 2),
    at: '2026-11-08T10:05:00.000Z',
    gate: 'SHIPMENT',
    place: 'shipment',
    subject: { type: 'Shipment', id: uid('7309', 1), number: 'DEMO-SHP-0091', status: 'PACKED' },
    style: { id: ids.vest, code: 'DEMO-VST-05' },
    colourway: null,
    size: null,
    requirement: { id: uid('7303', 7), code: 'EU-OPERATOR', name: 'Economic operator for the market', legalReference: 'Reg. (EU) 2019/1020 art. 4', locked: false, overrideRoleKeys: ['owner'], overrideMaxDays: 7 },
    reason: 'Shipment DEMO-SHP-0091 cannot leave for Germany (DE): no economic operator is named.',
    mayOverride: false,
  }),
  event({
    id: uid('7308', 3),
    at: '2026-11-07T08:40:00.000Z',
    gate: 'LABEL_PRINT',
    place: 'label print',
    subject: { type: 'WorkOrder', id: uid('7306', 2), number: 'DEMO-WO-0138', status: 'IN_PROGRESS' },
    style: { id: ids.suit, code: 'DEMO-SUT-04' },
    colourway: 'BIANCO',
    size: '58',
    marketCode: 'IT',
    requirement: { id: uid('7303', 1), code: 'CERT-COVERAGE', name: 'Certificate covers every size', legalReference: 'Reg. (EU) 2016/425 Annex V', locked: true, overrideRoleKeys: [], overrideMaxDays: 0 },
    reason: 'Work order DEMO-WO-0138 (BIANCO 58) cannot have its labels printed: no valid certificate covers size 58.',
    mayOverride: false,
  }),
  event({
    id: uid('7308', 4),
    at: '2026-11-06T16:20:00.000Z',
    state: 'OVERRIDDEN',
    subject: { type: 'WorkOrder', id: uid('7306', 3), number: 'DEMO-WO-0131', status: 'RELEASED' },
    overrides: [{ id: uid('7308', 5), at: '2026-11-06T16:45:00.000Z', until: '2026-11-11T22:59:59.000Z', reason: 'Sample for the trade fair, German leaflet printed by hand (made up).', by: { id: uid('7310', 1), name: 'Demo Responsabile Qualità' }, inForce: true }],
    mayOverride: false,
  }),
  event({ id: uid('7308', 6), at: '2026-11-05T09:00:00.000Z', state: 'CLEARED', subject: { type: 'WorkOrder', id: uid('7306', 4), number: 'DEMO-WO-0127', status: 'RELEASED' }, mayOverride: false }),
]
export const FEED: Feed = { events: EVENTS, days: 7, asOf: NOW }

export const EXPIRIES: Expiries = {
  from: TODAY,
  to: '2027-11-10',
  count: 5,
  asOf: NOW,
  months: Array.from({ length: 12 }, (_, index) => {
    const at = new Date(Date.UTC(2026, 10 + index, 1))
    const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
    const items: Expiries['months'][number]['items'] =
      month === '2026-12'
        ? [
            { recordType: 'Certificate', recordId: uid('7304', 1), label: 'DEMO-CERT-0001', validTo: '2026-12-08', validFrom: '2021-12-09', status: 'VALID', detail: 'EN 13594:2015', party: null, endsWithBase: false },
            { recordType: 'SupplierDeclarationRequest', recordId: uid('7311', 1), label: 'DEMO-SD-0004', validTo: '2026-12-31', validFrom: '2026-01-15', status: 'ACCEPTED', detail: 'REACH_SVHC', party: 'Conceria Demo Srl', endsWithBase: false },
          ]
        : month === '2027-03'
          ? [{ recordType: 'Certificate', recordId: uid('7304', 3), label: 'DEMO-CERT-0007', validTo: '2027-03-31', validFrom: '2022-04-01', status: 'SUSPENDED', detail: 'EN 17092-4:2020', party: null, endsWithBase: false }]
          : month === '2027-06'
            ? [{ recordType: 'SustainabilityClaim', recordId: uid('7312', 1), label: 'DEMO-CL-0003', validTo: '2027-06-30', validFrom: '2026-07-01', status: 'APPROVED', detail: 'RECYCLED_CONTENT', party: null, endsWithBase: false }]
          : month === '2027-08'
            ? [{ recordType: 'Certificate', recordId: uid('7304', 4), label: 'DEMO-CERT-0011', validTo: '2027-08-15', validFrom: '2023-01-10', status: 'VALID', detail: 'EN 17092-3:2020', party: null, endsWithBase: true }]
            : []
    return { month, count: items.length, items }
  }),
}

const specs = STATUS_SECTIONS.map((id) => ({ id, label: id, defaultWidth: 'full' as const }))

function model(over: Partial<StatusModel> = {}, role: RoleCase = 'owner', address: Partial<StatusAddress> = {}): StatusModel {
  // The API counts the lots tile only for a reader of lots.
  const lots = (ROLE_PERMISSIONS[role] as readonly string[]).includes('quality.lots.view')
  return {
    prefix: PREFIX,
    can: statusCan([...ROLE_PERMISSIONS[role], 'product.styles.view', 'shipping.view', 'compliance.gates.override']),
    address: { ...EMPTY_ADDRESS, ...address },
    today: TODAY,
    now: NOW,
    board: { status: 'ready', value: lots ? BOARD : { ...BOARD, tiles: { ...BOARD.tiles, lotsWithoutCrVi: null } } },
    feed: { status: 'ready', value: FEED },
    expiries: { status: 'ready', value: EXPIRIES },
    knownMarkets: MARKETS,
    brands: [BRAND],
    live: 'live',
    asOf: NOW,
    layout: defaultSectionLayout(specs),
    specs,
    arranging: false,
    selectedStyles: [],
    selectedEvents: [],
    cell: null,
    allActions: null,
    override: null,
    stepUp: { open: false, busy: false, problem: null },
    notice: null,
    finder: false,
    ...over,
  }
}

const loading = { status: 'loading' } as const
const OVERRIDE = { event: EVENTS[0]!, draft: { reason: 'Leaflet in German printed by the importer for this lot (made up).', day: '2026-11-12' }, touched: [], busy: false, problem: null }
const GAP_BOARD: Board = { ...BOARD, rows: [ROWS[0]!].map((row) => ({ ...row, cells: [ready('IT'), row.cells[1]!, ready('FR'), ready('ES')] })), needsAction: { lines: [LINES[2]!], count: 1 } }

function StatusDesign({ model: value }: { model: StatusModel }) {
  return inShell('/compliance/status', createElement(StatusView, { model: value }))
}

export const designScreen = defineDesignScreen<StatusModel>({
  screen: 'SCR-119',
  title: 'Status board (Compliance)',
  view: StatusDesign,
  holdsPage: true,
  cases: [
    { id: 'board', label: 'The board', model: model(), note: 'Tiles filter the matrix (styles, languages) or the refusals (shipments held); certificates and lots open their lists.' },
    { id: 'loading', label: 'Loading', model: model({ board: loading, feed: loading, expiries: loading, asOf: null }) },
    { id: 'error', label: 'Two parts failed', model: model({ board: { status: 'error', problem: 'problem.unavailable' }, expiries: { status: 'error', problem: 'problem.unavailable' } }), note: 'The refusals stand; each failed part says so with Try again.' },
    { id: 'empty', label: 'Nothing yet', model: model({ board: { status: 'ready', value: { ...BOARD, rows: [], tiles: { stylesReady: 0, stylesBlocked: 0, certificatesExpiring90: 0, lotsWithoutCrVi: 0, missingLanguages: 0, shipmentsHeld: 0 }, needsAction: { lines: [], count: 0 } } }, feed: { status: 'ready', value: { ...FEED, events: [] } }, expiries: { status: 'ready', value: { ...EXPIRIES, count: 0, months: EXPIRIES.months.map((month) => ({ ...month, count: 0, items: [] })) } } }) },
    { id: 'tile-blocked', label: 'Tile "Styles blocked" pressed', model: model({}, 'owner', { status: 'blocked' }) },
    { id: 'gap', label: 'A gap from the reports (?gap=docLanguage)', model: model({ board: { status: 'ready', value: GAP_BOARD } }, 'owner', { gap: 'docLanguage' }), note: 'Cells and Needs action over the DoC and user-information lines only; the tiles stay the whole board\'s.' },
    { id: 'gap-crvi', label: 'Cr VI gap (lots, not cells)', model: model({}, 'owner', { gap: 'crVi' }) },
    { id: 'no-match', label: 'No rows match', model: model({ board: { status: 'ready', value: { ...BOARD, rows: [] } } }, 'owner', { q: 'ZZZ' }) },
    { id: 'held-shipments', label: 'Tile "Shipments held" pressed', model: model({ feed: { status: 'ready', value: { ...FEED, days: 30, events: [EVENTS[1]!] } } }, 'owner', { gate: 'SHIPMENT', feed: 'blocked', days: 30 }) },
    { id: 'cell', label: 'Cell checklist (DEMO-JKT-01 × Germania)', model: model({ cell: { at: { styleId: ids.jacket, market: 'DE' }, read: { status: 'ready', value: CELL } } }), note: 'J / K walk the row\'s markets, ⇧J / ⇧K the rows; Fix is held where its page is not built yet.' },
    { id: 'cell-loading', label: 'Cell checklist loading', model: model({ cell: { at: { styleId: ids.jacket, market: 'DE' }, read: loading } }) },
    { id: 'cell-error', label: 'Cell checklist failed', model: model({ cell: { at: { styleId: ids.jacket, market: 'DE' }, read: { status: 'error', problem: 'problem.unavailable' } } }) },
    { id: 'see-all', label: 'See all 10', model: model({ allActions: { status: 'ready', value: { lines: MORE_LINES, count: MORE_LINES.length, asOf: NOW } } }) },
    { id: 'override', label: 'Override a gate', model: model({ override: OVERRIDE }), note: 'At most the requirement\'s 3 days; the code is asked when the API asks for it.' },
    { id: 'override-problems', label: 'Override: reason too short', model: model({ override: { ...OVERRIDE, draft: { reason: 'Fair', day: '2026-11-12' }, touched: ['reason', 'day'] } }) },
    { id: 'override-refused', label: 'Override refused by the API', model: model({ override: { ...OVERRIDE, problem: 'override.refused.conflict' } }) },
    { id: 'step-up', label: 'Override: fresh code', model: model({ override: { ...OVERRIDE, busy: true }, stepUp: { open: true, busy: false, problem: null } }) },
    { id: 'overridden', label: 'Override done', model: model({ notice: { key: 'override.done', params: { number: 'DEMO-WO-0142', code: 'USER-INFO-LANGUAGE' } } }) },
    { id: 'offline', label: 'Offline', model: model({ live: 'offline' }), note: 'The last copy with its time; Override… held with the reason.' },
    { id: 'arrange', label: 'Arrange', model: model({ arranging: true }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: model({ keysOpen: true }) },
    { id: 'finder', label: 'Show evidence for…', model: model({ finder: true }) },
    { id: 'role-inspector', label: 'Quality inspector', model: model({}, 'inspector') },
    { id: 'role-production', label: 'Production manager (no override)', model: { ...model({ feed: { status: 'ready', value: { ...FEED, events: EVENTS.map((entry) => ({ ...entry, mayOverride: false })) } } }, 'production'), can: statusCan(ROLE_PERMISSIONS.production) } },
    { id: 'role-read-only', label: 'Read only', model: { ...model({ feed: { status: 'ready', value: { ...FEED, events: EVENTS.map((entry) => ({ ...entry, mayOverride: false })) } } }, 'readOnly'), can: statusCan(ROLE_PERMISSIONS.readOnly) } },
    { id: 'no-permission', label: 'No right (sales)', model: { ...model({}, 'sales'), can: statusCan(ROLE_PERMISSIONS.sales) } },
  ],
})
