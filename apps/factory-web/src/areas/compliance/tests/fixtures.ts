import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../../quality/_shared/hooks'
import type { Lot } from '../../quality/_shared/lots'
import { failedRead, reading, ready } from '../../quality/_shared/model'
import { at, canFor, COMPANY_ID, day, inShell, NOW, PREFIX, SITE_ID, uid, type RoleCase } from '../../quality/_shared/fixtures'
import type { LabResult, LabSettings, LotCheck, LotChecklist, LotDetail, LotDocument } from './api'
import { isFailedOnHold, isWaitingEvidence, tileCounts, viewQuery, viewRows, type LotsListModel, type LotView } from './model'
import { LotsView } from './view/LotsView'

/**
 * SCR-054 Tests & substances — made-up lots only ("Demo" materials, DEMO-L-… codes, invented values and laboratories).
 * Each case is one state the Owner reviews: the list with its rule at rest and its tiles, each tile pressed, search,
 * nothing yet, nothing matching, loading, a failed read, the role cases (owner, quality inspector, production manager
 * and sales without the permission, read-only with every action held and its reason), a selection, live updates,
 * offline, more pages and the read cap, and the dialogs: choose the lot for a result, the evidence rule (tighten,
 * loosen with the reason), the step-up, a refused save, the keys. The lot record's cases are SCR-054-lot.
 */

// ---- made-up materials, lots, results and documents (shared with the lot record's fixtures) ----

const OTHER_USER = uid('3333', 7)
const LEATHER = { id: uid('5401', 1), code: 'DEMO-PELLE-NERA', name: 'Demo cowhide black 1.2 mm', kind: 'LEATHER', isPpeComponent: false }
const LEATHER_BROWN = { id: uid('5401', 2), code: 'DEMO-PELLE-MARRONE', name: 'Demo cowhide brown 1.3 mm', kind: 'LEATHER', isPpeComponent: false }
const PROTECTOR = { id: uid('5401', 3), code: 'DEMO-PROT-SPALLA', name: 'Demo shoulder protector level 2', kind: 'COMPONENT', isPpeComponent: true }
const LINING = { id: uid('5401', 4), code: 'DEMO-FODERA-RETE', name: 'Demo mesh lining', kind: 'FABRIC', isPpeComponent: false }

type CrVi = Lot['crVi']
const crVi = (status: CrVi['status'], value: string | null = null, extra: Partial<CrVi> = {}): CrVi => ({ required: true, status, limitMgKg: '3.000', valueMgKg: value, evidence: null, testedOn: null, ...extra })
const noTest: CrVi = { required: false, status: 'NOT_REQUIRED', limitMgKg: null, valueMgKg: null, evidence: null, testedOn: null }

export function demoLot(n: number, code: string, item: Lot['item'], status: Lot['qualityStatus'], test: CrVi, extra: Partial<Lot> = {}): Lot {
  return {
    id: uid('5402', n),
    code,
    companyId: COMPANY_ID,
    siteId: SITE_ID,
    item,
    itemColourId: null,
    supplierId: uid('5403', 1),
    supplierLotRef: `SUP-${1000 + n}`,
    dyeBatch: null,
    shade: null,
    receivedAt: at(28 - n, 8, 30),
    receivedById: OTHER_USER,
    receipt: { id: uid('5404', n), number: `GR-DEMO-${String(100 + n).padStart(4, '0')}`, status: 'POSTED' },
    qualityStatus: status,
    qualityNote: null,
    qualityDecidedAt: status === 'QUARANTINE' ? null : at(27 - n, 15, 10),
    qualityDecidedById: status === 'QUARANTINE' ? null : OTHER_USER,
    hold: null,
    crVi: test,
    words: `Lot ${code}.`,
    version: 3,
    ...extra,
  }
}

export const LOTS: Lot[] = [
  demoLot(1, 'DEMO-L-0231', LEATHER, 'QUARANTINE', crVi('PENDING')),
  demoLot(2, 'DEMO-L-0232', LEATHER, 'QUARANTINE', crVi('PASS', '1.200', { evidence: 'LOT_REPORT', testedOn: day(26) })),
  demoLot(3, 'DEMO-L-0233', LEATHER_BROWN, 'QUARANTINE', crVi('FAIL', '3.400', { evidence: 'LOT_REPORT', testedOn: day(25) })),
  demoLot(4, 'DEMO-L-0234', LEATHER_BROWN, 'QUARANTINE', crVi('PENDING'), { hold: 'Scratches on 3 hides: check them before use.', qualityNote: 'Scratches on 3 hides: check them before use.' }),
  demoLot(5, 'DEMO-P-0099', PROTECTOR, 'QUARANTINE', noTest),
  demoLot(6, 'DEMO-L-0220', LEATHER, 'RELEASED', crVi('PASS', null, { evidence: 'LOT_REPORT', testedOn: day(20) })),
  demoLot(7, 'DEMO-L-0219', LEATHER, 'RELEASED', crVi('PASS', '0.800', { evidence: 'SUPPLIER_REPORT', testedOn: day(18) })),
  demoLot(8, 'DEMO-L-0215', LEATHER_BROWN, 'BLOCKED', crVi('FAIL', '3.100', { evidence: 'LOT_REPORT', testedOn: day(27) }), { qualityNote: 'Chromium VI FAIL on later evidence.' }),
  demoLot(9, 'DEMO-F-0050', LINING, 'RELEASED', noTest),
  demoLot(10, 'DEMO-L-0210', LEATHER_BROWN, 'REJECTED', crVi('FAIL', '4.200', { evidence: 'LOT_REPORT', testedOn: day(14) })),
]
export const lotByCode = (code: string): Lot => LOTS.find((lot) => lot.code === code)!

export const SETTINGS: LabSettings = {
  companyId: COMPANY_ID,
  crViEvidenceRule: 'SUPPLIER_REPORT_ACCEPTED',
  source: 'TENANT',
  words: 'A supplier report that covers the article and the period counts as chromium VI evidence, as does a lab report on the lot.',
  default: 'SUPPLIER_REPORT_ACCEPTED',
  legalLimitMgKg: '3.000',
  law: 'REACH Annex XVII entry 47',
  version: 1,
  updatedAt: at(2, 10),
  updatedById: OTHER_USER,
}
export const STRICT: LabSettings = { ...SETTINGS, crViEvidenceRule: 'LOT_REPORT_REQUIRED', source: 'COMPANY', version: 2 }

export function demoResult(n: number, lot: Lot, verdict: 'PASS' | 'FAIL', value: string | null, extra: Partial<LabResult> = {}): LabResult {
  return {
    id: uid('5405', n),
    lotId: lot.id,
    test: 'CR_VI',
    method: 'EN ISO 17075-2',
    valueMgKg: value,
    belowDetectionLimit: value === null,
    detectionLimitMgKg: value === null ? '0.500' : null,
    unit: 'mg/kg',
    limitMgKg: '3.000',
    verdict,
    lab: 'Laboratorio Demo Analisi',
    reportNumber: `LAB-DEMO-${400 + n}`,
    testedOn: day(20 + n),
    evidence: 'LOT_REPORT',
    article: null,
    periodFrom: null,
    periodTo: null,
    fileId: uid('5406', n),
    supersedesId: null,
    note: null,
    createdAt: at(20 + n, 11, 5),
    createdById: OTHER_USER,
    words: verdict === 'PASS' ? 'PASS.' : 'FAIL.',
    file: { id: uid('5406', n), originalName: `demo-lab-report-${400 + n}.pdf`, status: 'AVAILABLE' },
    superseded: false,
    ...extra,
  }
}

export function demoDocument(n: number, lot: Lot, kind: LotDocument['kind'], extra: Partial<LotDocument> = {}): LotDocument {
  return {
    id: uid('5407', n),
    lotId: lot.id,
    kind,
    fileId: uid('5408', n),
    validTo: '2027-06-30',
    status: 'ACTIVE',
    note: null,
    createdAt: at(24, 9, 40 + n),
    createdById: OTHER_USER,
    file: { id: uid('5408', n), originalName: `demo-${kind.toLowerCase().replace(/_/g, '-')}-${n}.pdf`, status: 'AVAILABLE' },
    inForce: true,
    ...extra,
  }
}

const check = (code: LotCheck['code'], state: LotCheck['state'], words: string, fix: string | null = null): LotCheck => ({ code, state, words, fix })

/** A release checklist with these checks open (the rest OK or not needed), as the API words it (English: data). */
export function demoChecklist(lot: Lot, open: readonly LotCheck['code'][] = [], mode: LotChecklist['mode'] = 'RELEASE'): LotChecklist {
  const checks: LotCheck[] = [
    open.includes('STATE') ? check('STATE', 'OPEN', `Lot ${lot.code} is not in quarantine.`) : check('STATE', 'OK', mode === 'RELEASE' ? `Lot ${lot.code} is in quarantine.` : `Lot ${lot.code} is blocked.`),
    lot.receipt ? check('RECEIPT', 'OK', `Received with ${lot.receipt.number}.`) : check('RECEIPT', 'NOT_NEEDED', 'Opening stock: no receipt.'),
    !lot.crVi.required
      ? check('CR_VI', 'NOT_NEEDED', 'Needs no chromium VI test.')
      : open.includes('CR_VI')
        ? lot.crVi.status === 'FAIL'
          ? check('CR_VI', 'OPEN', `Chromium VI FAIL: ${Number(lot.crVi.valueMgKg)} mg/kg is at or above the limit of 3 mg/kg: this lot cannot be used.`, null)
          : check('CR_VI', 'OPEN', 'No chromium VI result yet (limit 3 mg/kg).', 'Record the lab report or the supplier report on the Results tab.')
        : check('CR_VI', 'OK', 'Chromium VI PASS on a lab report on this lot.'),
    lot.item.isPpeComponent
      ? open.includes('PPE_CERTIFICATE')
        ? check('PPE_CERTIFICATE', 'OPEN', 'No valid certificate covers DEMO-PROT-SPALLA today.', 'Register the EN 1621-1 certificate in Compliance › Certificates.')
        : check('PPE_CERTIFICATE', 'OK', 'Certificate CERT-DEMO-0002 (EN 1621-1) covers it until 30/06/2028.')
      : check('PPE_CERTIFICATE', 'NOT_NEEDED', 'Not a certified PPE component.'),
    lot.item.isPpeComponent
      ? open.includes('SUPPLIER_DOCUMENTS')
        ? check('SUPPLIER_DOCUMENTS', 'OPEN', "The supplier's PPE certificate or declaration for this lot is missing.", 'Attach it on the Documents tab.')
        : check('SUPPLIER_DOCUMENTS', 'OK', "The supplier's PPE certificate is attached and valid.")
      : check('SUPPLIER_DOCUMENTS', 'NOT_NEEDED', 'No supplier document is required for this material.'),
    mode === 'UNBLOCK' ? check('HOLD', 'NOT_NEEDED', 'A blocked lot has no receiver hold.') : open.includes('HOLD') ? check('HOLD', 'OPEN', `Hold by the receiver: ${lot.hold ?? ''}`, 'Another quality person checks it and clears the hold.') : check('HOLD', 'OK', 'No hold from the receiver.'),
    open.includes('RELEASER') ? check('RELEASER', 'OPEN', 'You received this lot.', 'Another person with the quality role releases it.') : check('RELEASER', 'OK', 'You did not receive this lot.'),
  ]
  const opened = checks.filter((entry) => entry.state === 'OPEN')
  return { mode, checks, open: opened, ready: opened.length === 0, words: opened.length === 0 ? 'Ready to release' : `Release · ${opened.length} checks open` }
}

/** A lot's detail as `GET /quality/lots/:id` answers it. */
export function demoDetail(lot: Lot, over: Partial<LotDetail> = {}): LotDetail {
  return { lot, rule: { crViEvidenceRule: SETTINGS.crViEvidenceRule, source: SETTINGS.source, words: SETTINGS.words }, results: [], documents: [], checklist: demoChecklist(lot), ...over }
}

// ---- the list's cases ----

const onHold = LOTS.filter((lot) => lot.qualityStatus === 'QUARANTINE' || lot.qualityStatus === 'BLOCKED')
const released = LOTS.filter((lot) => lot.qualityStatus === 'RELEASED')

function rowsOf(view: LotView): Lot[] {
  if (view === 'onHold') return onHold
  if (view === 'waiting') return onHold.filter(isWaitingEvidence)
  if (view === 'failed') return onHold.filter(isFailedOnHold)
  const status = viewQuery(view, '', 50).status
  return status ? LOTS.filter((lot) => lot.qualityStatus === status) : viewRows(view, LOTS)
}

interface LotsCase {
  readonly model: LotsListModel
  readonly role: RoleCase
}

export function listModel(over: Partial<LotsListModel> = {}, role: RoleCase = 'owner'): LotsCase {
  const view = over.view ?? 'all'
  return {
    role,
    model: {
      prefix: PREFIX,
      can: canFor(role),
      view,
      query: '',
      rows: ready(rowsOf(view)),
      limit: 50,
      more: false,
      capped: false,
      tiles: tileCounts(onHold, released),
      rule: ready(SETTINGS),
      asOf: NOW,
      live: 'live',
      updates: 0,
      selected: [],
      notice: null,
      dialog: null,
      pick: ready(onHold.filter(isWaitingEvidence)),
      pickQuery: '',
      ruleDraft: null,
      busy: false,
      dialogProblem: null,
      stepUp: STEP_UP_CLOSED,
      ...over,
    },
  }
}

/** The design case keeps its own selection, so ticks, the header box, shift-click and x work in the review. */
function LotsDesign({ model }: { model: LotsCase }) {
  const [selected, setSelected] = useState<readonly string[]>(model.model.selected)
  useEffect(() => setSelected(model.model.selected), [model.model.selected])
  return inShell('/compliance/tests', createElement(LotsView, { model: { ...model.model, selected }, actions: { onSelect: (ids) => setSelected([...ids]) } }), model.role)
}

const ids = (...codes: string[]) => codes.map((code) => lotByCode(code).id)
const MANY = Array.from({ length: 50 }, (_, index) => demoLot(100 + index, `DEMO-L-${String(300 + index).padStart(4, '0')}`, index % 3 === 0 ? LEATHER_BROWN : LEATHER, index % 4 === 0 ? 'QUARANTINE' : 'RELEASED', index % 4 === 0 ? crVi('PENDING') : crVi('PASS', `${(index % 9) / 10 + 0.4}`.slice(0, 5), { evidence: 'LOT_REPORT', testedOn: day(10 + (index % 18)) })))

export const designScreen = defineDesignScreen<LotsCase>({
  screen: 'SCR-054',
  title: 'Tests & substances (lots, Cr VI, release)',
  view: LotsDesign,
  cases: [
    { id: 'list', label: 'Owner: the rule at rest, the tiles and every lot', model: listModel(), note: 'A tile is a saved filter: pressing it shows its view; the count and the list agree.' },
    { id: 'tile-on-hold', label: 'Tile pressed: lots on hold (quarantine or blocked)', model: listModel({ view: 'onHold' }) },
    { id: 'tile-waiting', label: 'Tile pressed: waiting Cr VI evidence', model: listModel({ view: 'waiting' }) },
    { id: 'tile-failed', label: 'Tile pressed: failed Cr VI, not rejected yet', model: listModel({ view: 'failed' }) },
    { id: 'tile-released', label: 'Tile pressed: released lots', model: listModel({ view: 'released' }) },
    { id: 'view-rejected', label: 'Rows ▾ Rejected', model: listModel({ view: 'rejected' }) },
    { id: 'search', label: 'Search by lot code', model: listModel({ query: '023', rows: ready(LOTS.filter((lot) => lot.code.includes('023'))) }) },
    { id: 'filtered-empty', label: 'No lot matches these filters', model: listModel({ query: 'zzz', rows: ready([]) }) },
    {
      id: 'empty',
      label: 'First day: no lot yet',
      model: listModel({ rows: ready([]), tiles: tileCounts([], []), pick: ready([]) }),
    },
    { id: 'loading', label: 'Loading', model: listModel({ rows: reading(), tiles: tileCounts(null, null), rule: reading(), asOf: null, live: 'connecting' }), note: 'The tiles that could not count yet show a skeleton; a failed count shows —.' },
    {
      id: 'error',
      label: "The API didn't answer",
      model: listModel({ rows: failedRead('problem.unavailable'), tiles: tileCounts(null, null), rule: failedRead('problem.unavailable'), asOf: null, live: 'offline' }),
      note: 'Never drawn as an empty list: the problem in words with Try again; the tiles say they could not count.',
    },
    { id: 'inspector', label: 'Quality inspector: records, releases, rejects; the rule is the owner’s (held)', model: listModel({}, 'inspector') },
    { id: 'read-only', label: 'Read-only: sees every lot, every action held with its reason', model: listModel({ selected: ids('DEMO-L-0231', 'DEMO-L-0232') }, 'readOnly'), note: 'Record test result and Change rule stay focusable and say which permission is missing.' },
    { id: 'no-permission', label: 'Production manager: no permission (says which one and who has it)', model: listModel({}, 'production') },
    { id: 'sales', label: 'Sales: no permission', model: listModel({}, 'sales') },
    { id: 'selection', label: 'Selection: Export 3 (CSV)', model: listModel({ selected: ids('DEMO-L-0231', 'DEMO-L-0232', 'DEMO-P-0099') }), note: 'A lot is released one at a time with its code typed, so release is not a bulk action.' },
    { id: 'live-updates', label: 'Live: 2 updates waiting behind Show', model: listModel({ updates: 2 }), note: 'Rows never move under the cursor.' },
    { id: 'offline', label: 'Offline: rows stay readable with their time', model: listModel({ live: 'offline' }) },
    { id: 'more', label: 'More than one page (Show more)', model: listModel({ rows: ready(MANY), more: true, limit: 50 }) },
    { id: 'capped', label: 'The read cap: 200 lots read, Show more held with its reason', model: listModel({ rows: ready(MANY), more: false, capped: true, limit: 200 }) },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows, x selects, the keys in the footer icon', model: listModel({ focusRow: 1, selected: ids('DEMO-L-0232') }) },
    { id: 'notice', label: 'A receipt after an export', model: listModel({ notice: { key: 'done.exported', params: { count: 3 }, tone: 'success' } }) },
    { id: 'pick', label: 'Record test result: choose the lot (the lots waiting for evidence)', model: listModel({ dialog: { kind: 'pick' } }) },
    { id: 'pick-none', label: 'Record test result: no lot waiting', model: listModel({ dialog: { kind: 'pick' }, pick: ready([]) }) },
    { id: 'rule', label: 'The evidence rule: tighten to a lab report for every lot', model: listModel({ dialog: { kind: 'rule' }, ruleDraft: { rule: 'LOT_REPORT_REQUIRED', reason: '' } }), note: 'Tightening saves at once: no reason, no code.' },
    {
      id: 'rule-loosen',
      label: 'The evidence rule: loosen (the reason, then a fresh code)',
      model: listModel({ rule: ready(STRICT), dialog: { kind: 'rule' }, ruleDraft: { rule: 'SUPPLIER_REPORT_ACCEPTED', reason: 'Tannery audited in October; its period reports are reliable.' } }),
    },
    {
      id: 'rule-step-up',
      label: 'Loosening: the step-up dialog asks for the code',
      model: listModel({ rule: ready(STRICT), dialog: { kind: 'rule' }, ruleDraft: { rule: 'SUPPLIER_REPORT_ACCEPTED', reason: 'Tannery audited in October.' }, busy: true, stepUp: { open: true, busy: false, sentence: 'stepUp.loosen', problem: null } }),
    },
    {
      id: 'rule-refused',
      label: 'The rule changed in the meantime (read again)',
      model: listModel({ dialog: { kind: 'rule' }, ruleDraft: { rule: 'LOT_REPORT_REQUIRED', reason: '' }, dialogProblem: 'rule.problem.conflict' }),
    },
    { id: 'rule-strict', label: 'The rule at rest when a lab report is required (this company’s own rule)', model: listModel({ rule: ready(STRICT) }) },
    { id: 'shortcuts', label: 'The keys (?)', model: listModel({ dialog: { kind: 'shortcuts' } }) },
  ],
})

