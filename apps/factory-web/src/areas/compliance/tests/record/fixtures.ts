import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import { RecordPanelsView } from '../../../../record-panels/view/RecordPanelsView'
import { failedRead, reading, ready } from '../../../quality/_shared/model'
import { canFor, day, inShell, ME, NOW, PREFIX, uid, type RoleCase } from '../../../quality/_shared/fixtures'
import type { Lot } from '../../../quality/_shared/lots'
import { demoChecklist, demoDetail, demoDocument, demoResult, lotByCode, STRICT } from '../fixtures'
import { blankDocument, blankResult, type LotRecordModel } from '../model'
import { LotRecordView } from './view/LotRecordView'

/**
 * SCR-054-lot — the lot record of Tests & substances, made-up data only (the DEMO-L-… lots of SCR-054). Each case is one
 * state the Owner reviews: a lot waiting for its Cr VI result, one ready to release, the receiver who may not release
 * it, the result dialog with a live Pass, a live Fail, a supplier's report and a detection limit that proves nothing, a
 * refused result, a later FAIL on a released lot (its work orders and the PPE register entry it opened), the documents
 * of a PPE component, every decision dialog (release with checks open, release with the code typed, reject, block,
 * release again, clear the receiver's hold), a block's answer, a rejected lot, the activity, the thread beside a tab,
 * loading, failed, not found, and the role cases.
 */

const TODAY = day(29)
const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel

function panelsFor(lot: Lot): ReactNode {
  const model: RecordPanelsViewModel = { ...conversation, record: { type: 'Lot', id: lot.id, companyId: lot.companyId, siteId: lot.siteId }, title: lot.code, party: null }
  return createElement(RecordPanelsView, { model })
}

interface LotCase {
  readonly model: LotRecordModel
  readonly role: RoleCase
  readonly panels: boolean
}

function lotCase(lot: Lot, over: Partial<LotRecordModel> = {}, role: RoleCase = 'owner', panels = true): LotCase {
  return {
    role,
    panels,
    model: {
      prefix: PREFIX,
      tab: 'results',
      detail: ready(demoDetail(lot)),
      can: canFor(role),
      me: ME,
      today: TODAY,
      asOf: NOW,
      live: 'live',
      notice: null,
      dialog: null,
      resultDraft: blankResult(TODAY),
      documentDraft: blankDocument(),
      decideDraft: { code: '', reason: '' },
      busy: false,
      dialogProblem: null,
      dialogLines: [],
      answer: null,
      blocked: null,
      dockOpen: false,
      ...over,
    },
  }
}

function LotDesign({ model }: { model: LotCase }) {
  const lot = model.model.detail.value?.lot ?? null
  const page = createElement(LotRecordView, { model: model.model, panels: model.panels && lot ? panelsFor(lot) : undefined })
  return inShell('/compliance/tests', page, model.role)
}

const pending = lotByCode('DEMO-L-0231')
const ready232 = lotByCode('DEMO-L-0232')
const failed = lotByCode('DEMO-L-0233')
const held = lotByCode('DEMO-L-0234')
const protector = lotByCode('DEMO-P-0099')
const releasedLot = lotByCode('DEMO-L-0219')
const blockedLot = lotByCode('DEMO-L-0215')
const rejected = lotByCode('DEMO-L-0210')

const pendingDetail = demoDetail(pending, { checklist: demoChecklist(pending, ['CR_VI']) })
const readyDetail = demoDetail(ready232, { results: [demoResult(2, ready232, 'PASS', '1.200')] })
const failedDetail = demoDetail(failed, { results: [demoResult(3, failed, 'FAIL', '3.400')], checklist: demoChecklist(failed, ['CR_VI']) })
const heldDetail = demoDetail(held, { checklist: demoChecklist(held, ['CR_VI', 'HOLD']) })
const protectorDetail = demoDetail(protector, {
  documents: [demoDocument(1, protector, 'LWG_CERTIFICATE', { validTo: null, note: null }), demoDocument(2, protector, 'OTHER', { status: 'ARCHIVED', inForce: false, note: 'Old packing list from the supplier.' })],
  checklist: demoChecklist(protector, ['SUPPLIER_DOCUMENTS']),
})
const releasedDetail = demoDetail(releasedLot, {
  results: [demoResult(7, releasedLot, 'PASS', '0.800', { evidence: 'SUPPLIER_REPORT', article: 'DEMO ARTICLE 12', periodFrom: day(1), periodTo: '2026-12-31' })],
  documents: [demoDocument(3, releasedLot, 'CR_VI_STATEMENT')],
  checklist: demoChecklist(releasedLot, ['STATE']),
})
const laterFail = demoResult(9, blockedLot, 'FAIL', '3.100', { createdAt: '2026-10-28T10:15:00.000Z' })
const blockedDetail = demoDetail(blockedLot, {
  results: [laterFail, demoResult(8, blockedLot, 'PASS', '1.400', { superseded: true })],
  checklist: demoChecklist(blockedLot, ['CR_VI'], 'UNBLOCK'),
})
const rejectedDetail = demoDetail(rejected, { results: [demoResult(10, rejected, 'FAIL', '4.200')], checklist: demoChecklist(rejected, ['STATE']) })
const workOrders = [
  { workOrderId: uid('5409', 1), number: 'WO-DEMO-0142', batchNumber: 'B-DEMO-0142', status: 'IN_PROGRESS', issued: '36.500', returned: '0.000', atWorkOrder: '36.500' },
  { workOrderId: uid('5409', 2), number: 'WO-DEMO-0145', batchNumber: 'B-DEMO-0145', status: 'COMPLETED', issued: '12.000', returned: '1.500', atWorkOrder: '10.500' },
]

const passDraft = { ...blankResult(TODAY), valueMgKg: '1,2', lab: 'Laboratorio Demo Analisi', reportNumber: 'LAB-DEMO-0412', testedOn: day(28), fileName: 'demo-lab-report-0412.pdf' }

export const designScreen = defineDesignScreen<LotCase>({
  screen: 'SCR-054-lot',
  title: 'Lot record (results, documents, release)',
  view: LotDesign,
  cases: [
    { id: 'waiting-result', label: 'In quarantine, waiting its Cr VI result', model: lotCase(pending, { detail: ready(pendingDetail) }), note: 'Release is held: the band says how many checks are open (r opens the checklist).' },
    { id: 'ready', label: 'Pass on a lab report: ready to release', model: lotCase(ready232, { detail: ready(readyDetail) }) },
    { id: 'release-tab', label: 'Release tab: every check passes', model: lotCase(ready232, { tab: 'release', detail: ready(readyDetail) }) },
    { id: 'release-open', label: 'Release tab: two checks open (Cr VI, the receiver’s hold)', model: lotCase(held, { tab: 'release', detail: ready(heldDetail) }) },
    {
      id: 'receiver',
      label: 'The person who received it: release held, said why',
      model: lotCase(ready232, { tab: 'release', me: ready232.receivedById, detail: ready({ ...readyDetail, checklist: demoChecklist(ready232, ['RELEASER']) }) }),
    },
    { id: 'result-pass', label: 'Record result: a live Pass (a comma decimal is fine)', model: lotCase(pending, { detail: ready(pendingDetail), dialog: { kind: 'result' }, resultDraft: { ...passDraft, thenRelease: true } }), note: 'With "release when it passes", the release dialog opens next: the code is still typed.' },
    { id: 'result-fail', label: 'Record result: a live Fail (REACH entry 47)', model: lotCase(pending, { detail: ready(pendingDetail), dialog: { kind: 'result' }, resultDraft: { ...passDraft, valueMgKg: '3.4' } }) },
    {
      id: 'result-supplier',
      label: "Record result: a supplier's report (article and period), not detected",
      model: lotCase(pending, {
        detail: ready(pendingDetail),
        dialog: { kind: 'result' },
        resultDraft: { ...passDraft, valueMgKg: '', belowDetectionLimit: true, detectionLimitMgKg: '0.5', evidence: 'SUPPLIER_REPORT', article: 'DEMO ARTICLE 12', periodFrom: day(1), periodTo: '2026-12-31' },
      }),
    },
    {
      id: 'result-lod-above',
      label: 'Record result: a detection limit above the lot’s limit proves nothing',
      model: lotCase(pending, { detail: ready(pendingDetail), dialog: { kind: 'result' }, resultDraft: { ...passDraft, valueMgKg: '', belowDetectionLimit: true, detectionLimitMgKg: '4' } }),
    },
    {
      id: 'result-strict-rule',
      label: "Record result: the rule asks a lab report (supplier's report held)",
      model: lotCase(pending, { detail: ready({ ...pendingDetail, rule: { crViEvidenceRule: STRICT.crViEvidenceRule, source: STRICT.source, words: STRICT.words } }), dialog: { kind: 'result' }, resultDraft: passDraft }),
    },
    {
      id: 'result-refused',
      label: 'Record result: refused by the API (its sentences under ours)',
      model: lotCase(pending, {
        detail: ready(pendingDetail),
        dialog: { kind: 'result' },
        resultDraft: passDraft,
        dialogProblem: 'result.problem.refused',
        dialogLines: ["The supplier's report covers 01/11/2026 – 31/12/2026, not the day lot DEMO-L-0231 was received (27/10/2026)."],
      }),
    },
    {
      id: 'later-fail',
      label: 'A later FAIL on a released lot: blocked, its work orders, the PPE register entry',
      model: lotCase(blockedLot, {
        detail: ready(blockedDetail),
        notice: { key: 'done.resultLaterFail', params: { code: blockedLot.code }, tone: 'danger' },
        answer: {
          effect: 'Lot DEMO-L-0215 failed on later evidence and is blocked.',
          trace: { law: 'REACH Annex XVII entry 47', workOrders, register: { opened: true, entryId: uid('5410', 1), reference: 'REG-DEMO-2026-0007', shippedGoods: true, words: 'Entry opened.' } },
        },
      }),
    },
    {
      id: 'later-fail-no-entry',
      label: 'A later FAIL whose work orders made several styles: no register entry, said why',
      model: lotCase(blockedLot, {
        detail: ready(blockedDetail),
        answer: { effect: 'Blocked.', trace: { law: 'REACH Annex XVII entry 47', workOrders, register: { opened: false, entryId: null, reference: null, shippedGoods: null, words: 'Its work orders made 2 styles: open an entry per style by hand.' } } },
      }),
    },
    { id: 'supplier-report', label: "A released lot on a supplier's report (article and period)", model: lotCase(releasedLot, { detail: ready(releasedDetail) }) },
    { id: 'documents', label: 'Documents of a PPE component: the certificate missing', model: lotCase(protector, { tab: 'documents', detail: ready(protectorDetail) }) },
    { id: 'document-dialog', label: 'Add document (kind, valid to, note, file)', model: lotCase(protector, { tab: 'documents', detail: ready(protectorDetail), dialog: { kind: 'document' }, documentDraft: { kind: 'PPE_CERTIFICATE', validTo: '2028-06-30', note: '', fileName: 'demo-ppe-declaration.pdf' } }) },
    { id: 'release-dialog-open', label: 'Release: checks still open (held with the reason)', model: lotCase(held, { tab: 'release', detail: ready(heldDetail), dialog: { kind: 'decide', decision: 'release' } }) },
    { id: 'release-dialog', label: 'Release: the code typed, ready', model: lotCase(ready232, { tab: 'release', detail: ready(readyDetail), dialog: { kind: 'decide', decision: 'release' }, decideDraft: { code: 'DEMO-L-0232', reason: '' } }) },
    {
      id: 'release-refused',
      label: 'Release refused: a check opened in the meantime (the API’s sentence)',
      model: lotCase(ready232, {
        tab: 'release',
        detail: ready(readyDetail),
        dialog: { kind: 'decide', decision: 'release' },
        decideDraft: { code: 'DEMO-L-0232', reason: '' },
        dialogProblem: 'decide.problem.checks',
        dialogLines: ['Receipt GR-DEMO-0102 was reversed: its lots are never released.'],
      }),
    },
    { id: 'reject-dialog', label: 'Reject a failed lot: final, the reason and the code', model: lotCase(failed, { tab: 'release', detail: ready(failedDetail), dialog: { kind: 'decide', decision: 'reject' }, decideDraft: { code: 'DEMO-L-02', reason: 'Chromium VI 3.4 mg/kg on the lab report.' } }) },
    { id: 'block-dialog', label: 'Block a released lot (a later finding)', model: lotCase(releasedLot, { tab: 'release', detail: ready(releasedDetail), dialog: { kind: 'decide', decision: 'block' }, decideDraft: { code: '', reason: 'Customer complaint: stains after rain.' } }) },
    { id: 'blocked', label: 'After a block: the work orders it had gone to', model: lotCase(blockedLot, { tab: 'release', detail: ready(blockedDetail), blocked: workOrders, notice: { key: 'done.block', params: { code: blockedLot.code }, tone: 'warning' } }) },
    { id: 'unblock-dialog', label: 'Release a blocked lot again: the checks and the reason', model: lotCase(blockedLot, { tab: 'release', detail: ready(blockedDetail), dialog: { kind: 'decide', decision: 'unblock' } }) },
    { id: 'clear-hold-dialog', label: 'Clear the receiver’s hold (what you checked)', model: lotCase(held, { tab: 'release', detail: ready(heldDetail), dialog: { kind: 'decide', decision: 'clearHold' }, decideDraft: { code: '', reason: 'Checked the 3 hides: surface scratches only, outside the cutting zones.' } }) },
    { id: 'rejected', label: 'A rejected lot: final, nothing left to decide', model: lotCase(rejected, { tab: 'release', detail: ready(rejectedDetail) }) },
    { id: 'activity', label: 'Activity: the thread, files and history', model: lotCase(ready232, { tab: 'activity', detail: ready(readyDetail) }) },
    { id: 'dock', label: 'The thread beside the results (wide screens, ⌘J)', model: lotCase(ready232, { detail: ready(readyDetail), dockOpen: true }), note: 'On a narrower screen the Thread button opens Activity.' },
    { id: 'inspector', label: 'Quality inspector: every lot action', model: lotCase(ready232, { tab: 'release', detail: ready(readyDetail) }, 'inspector') },
    { id: 'read-only', label: 'Read-only: sees everything, every action held with its reason', model: lotCase(pending, { detail: ready(pendingDetail) }, 'readOnly', false), note: 'No thread read either: Activity says which permission it needs.' },
    { id: 'read-only-activity', label: 'Read-only on Activity: which permission the panels need', model: lotCase(pending, { tab: 'activity', detail: ready(pendingDetail) }, 'readOnly', false) },
    { id: 'no-permission', label: 'Production manager: not for this role', model: lotCase(pending, {}, 'production', false) },
    { id: 'sales', label: 'Sales: not for this role', model: lotCase(pending, {}, 'sales', false) },
    { id: 'loading', label: 'Loading', model: lotCase(pending, { detail: reading(), asOf: null, live: 'connecting' }, 'owner', false) },
    { id: 'error', label: "The API didn't answer", model: lotCase(pending, { detail: failedRead('problem.unavailable') }, 'owner', false) },
    { id: 'not-found', label: 'Not found (another company’s lot)', model: lotCase(pending, { detail: failedRead('problem.notFound') }, 'owner', false) },
    { id: 'shortcuts', label: 'The keys (?)', model: lotCase(ready232, { detail: ready(readyDetail), dialog: { kind: 'shortcuts' } }) },
  ],
})
