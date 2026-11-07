import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../../_shared/parts'
import { CATALOGUE, CUTTER, CUTTER_PREVIEW, DONE_MEASURE, inRiskShell, MEASURES, measuresAnswer, NORTH, northRecord, NOW, OWNERS, PREFIX, RISK_ROLES_DEMO, SCOPE_ONE, SHEET_ROWS, sheetsAnswer, TODAY, V1, V2, V3, type RiskRoleDemo } from '../_demo/fixtures'
import { EMPTY_MEASURE, EMPTY_RECORD_ADDRESS, emptyVersionDraft, measureDraftOf, paperDraftOf, riskCan, sheetDraftOf, type RecordAddress } from '../model'
import type { RiskRecordModel, SheetState } from '../view-model'
import { RecordView } from './view/RecordView'

/**
 * SCR-209-record — one Risk assessment (design plant.risk rec "Risk assessment": Role sheets, Improvement plan, Versions; the
 * pop-ups Sign version, New DVR version, Add measure, What this changes). Made-up data only (../_demo).
 */

interface RecordCase {
  role: RiskRoleDemo
  model: RiskRecordModel
}

const ready = <T,>(value: T) => ({ status: 'ready' as const, value })
const loading = { status: 'loading' as const }

function base(role: RiskRoleDemo, over: Partial<RiskRecordModel> = {}, address: Partial<RecordAddress> = {}): RecordCase {
  const can = riskCan(RISK_ROLES_DEMO[role])
  const record = northRecord({ may: { manage: can.manage, sign: can.sign, upload: can.upload && can.manage } }, role === 'doctor' ? 'DOCTOR' : null)
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      scope: SCOPE_ONE,
      companyId: SCOPE_ONE.company?.id ?? null,
      today: TODAY,
      id: NORTH.id,
      address: { ...EMPTY_RECORD_ADDRESS, ...address },
      record: ready(record),
      measures: ready(measuresAnswer([...MEASURES, DONE_MEASURE].map((row) => ({ ...row, canManage: can.manage, canMove: can.manage ? row.canMove : [] })), can.cost)),
      sheets: ready(sheetsAnswer(SHEET_ROWS.map((row) => ({ ...row, canManage: can.sheets })), can.sheets)),
      readAt: NOW,
      notice: null,
      selected: [],
      cells: {},
      owners: can.manage ? ready(OWNERS) : null,
      measure: null,
      move: null,
      version: null,
      sheet: null,
      newSheet: null,
      sign: null,
      withdraw: null,
      edit: null,
      keeping: null,
      stepUp: STEP_UP_CLOSED,
      ...over,
    },
  }
}

const sheetState = (over: Partial<SheetState> = {}): SheetState => ({ id: CUTTER.id, read: ready({ roleSheet: CUTTER, law: sheetsAnswer().law, today: TODAY }), mode: 'view', draft: null, catalogue: null, review: null, busy: false, problem: null, saved: null, ...over })
const rspp = V3().signers.find((signer) => signer.role === 'RLS')!
const doctor = V3('DOCTOR').signers.find((signer) => signer.role === 'DOCTOR')!

function RecordDesign({ model }: { model: RecordCase }) {
  return inRiskShell(`/plant/risk/${NORTH.id}`, createElement(RecordView, { model: model.model }), model.role, model.model.scope)
}

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-209-record',
  title: 'Risk assessment › one assessment (record)',
  view: RecordDesign,
  cases: [
    {
      id: 'versions',
      label: 'Versions: v3 waiting (2 of 4), v2 in force with its seal, v1 superseded',
      model: base('safety'),
      note: 'Each version: its seal (DocumentSeal: the fingerprint, frozen at and by, the signers), the frozen PDF in its own tab, each signer signed (how, when, recorded by) or Record paper signature. New DVR version is held while v3 waits (said why).',
    },
    { id: 'versions-doctor', label: 'The occupational doctor: Sign here on their own role', model: base('doctor') },
    { id: 'versions-read-only', label: 'Production manager: reads; every act held with the reason', model: base('production') },
    { id: 'versions-empty', label: 'No version yet: "Add the current DVR"', model: base('safety', { record: ready(northRecord({ versions: [], assessment: { ...NORTH, inForce: null, waiting: null } })) }) },
    { id: 'versions-signed-unsealed', label: 'Signed, the seal not kept yet: Keep the seal', model: base('safety', { record: ready(northRecord({ versions: [{ ...V2, sealed: null }, V1] })) }) },
    { id: 'versions-withdrawn', label: 'A withdrawn version stays with its reason', model: base('safety', { record: ready(northRecord({ versions: [{ ...V3(), status: 'WITHDRAWN', withdrawnAt: '2026-11-04T10:00:00.000Z', withdrawnReason: 'Il consulente manda una revisione corretta.' }, V2, V1] })) }) },
    { id: 'plan', label: 'Improvement plan: figures, measures with evidence, open measures over time', model: base('safety', {}, { tab: 'plan' }) },
    { id: 'plan-cost', label: 'Improvement plan with the cost grain', model: base('safetyCost', {}, { tab: 'plan' }) },
    { id: 'plan-empty', label: 'Improvement plan: no measures', model: base('safety', { measures: ready(measuresAnswer([])), record: ready(northRecord({ plan: { open: 0, overdue: 0, dueSoon: 0, done: 0, verified: 0, cancelled: 0, burn: [] } })) }, { tab: 'plan' }) },
    { id: 'plan-measure', label: 'A measure\'s window: its facts, evidence and moves', model: base('safety', { measure: { mode: 'edit', id: DONE_MEASURE.id, read: ready({ measure: DONE_MEASURE, canUpload: true }), draft: measureDraftOf(DONE_MEASURE, 'it'), owners: ready(OWNERS), sheets: ready(SHEET_ROWS), busy: false, uploading: false, problem: null } }, { tab: 'plan', measure: DONE_MEASURE.id }) },
    { id: 'plan-add', label: 'Add measure from the plan tab', model: base('safety', { measure: { mode: 'add', id: null, read: null, draft: { ...EMPTY_MEASURE, assessmentId: NORTH.id }, owners: ready(OWNERS), sheets: ready(SHEET_ROWS), busy: false, uploading: false, problem: null } }, { tab: 'plan', add: 'measure' }) },
    { id: 'roles', label: 'Role sheets of the site: the table; choose a role', model: base('safety', {}, { tab: 'roles' }) },
    { id: 'roles-sheet', label: 'A role chosen: its sheet below', model: base('safety', { sheet: sheetState() }, { tab: 'roles', sheet: CUTTER.id }) },
    { id: 'roles-edit', label: 'The sheet in edit, What this changes open', model: base('safety', { sheet: sheetState({ mode: 'edit', draft: sheetDraftOf(CUTTER), catalogue: ready(CATALOGUE), review: { read: ready(CUTTER_PREVIEW), applying: false, applied: null, problem: null } }) }, { tab: 'roles', sheet: CUTTER.id, mode: 'edit' }) },
    { id: 'roles-empty', label: 'No role yet: "Add the first role"', model: base('safety', { sheets: ready(sheetsAnswer([])) }, { tab: 'roles' }) },
    { id: 'sign-office', label: 'Sign version: the doctor types their own name (a fresh code follows)', model: base('doctor', { sign: { versionId: V3().id, role: 'DOCTOR', method: 'office', paper: paperDraftOf(doctor, TODAY), busy: false, problem: null, done: null } }, { sign: V3().id, role: 'DOCTOR' }) },
    { id: 'sign-step-up', label: 'Sign version: the fresh code', model: base('doctor', { sign: { versionId: V3().id, role: 'DOCTOR', method: 'office', paper: paperDraftOf(doctor, TODAY), busy: true, problem: null, done: null }, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence', problem: null } }, { sign: V3().id, role: 'DOCTOR' }) },
    { id: 'sign-mismatch', label: 'Sign version refused: not the holder\'s name', model: base('doctor', { sign: { versionId: V3().id, role: 'DOCTOR', method: 'office', paper: paperDraftOf(doctor, TODAY), busy: false, problem: { key: 'refusal.NAME_MISMATCH', field: 'signerName' }, done: null } }, { sign: V3().id, role: 'DOCTOR' }) },
    { id: 'sign-paper', label: 'Record paper signature: name, day, the scan first', model: base('safety', { sign: { versionId: V3().id, role: 'RLS', method: 'paper', paper: paperDraftOf(rspp, TODAY), busy: false, problem: null, done: null } }, { sign: V3().id, role: 'RLS', method: 'paper' }) },
    { id: 'sign-not-yours', label: 'The safety officer on another role: Sign here held, paper offered', model: base('safety', { sign: { versionId: V3().id, role: 'DOCTOR', method: 'office', paper: paperDraftOf(doctor, TODAY), busy: false, problem: null, done: null } }, { sign: V3().id, role: 'DOCTOR' }) },
    { id: 'sign-done', label: 'The last signature: in force, certain date, the seal kept', model: base('doctor', { sign: { versionId: V3().id, role: 'DOCTOR', method: 'office', paper: paperDraftOf(doctor, TODAY), busy: false, problem: null, done: { version: { ...V3(), status: 'SIGNED', certainDateOn: TODAY, missing: [] }, complete: true, sealed: true } } }, { sign: V3().id, role: 'DOCTOR' }) },
    { id: 'withdraw', label: 'Withdraw v3: the reason', model: base('safety', { withdraw: { versionId: V3().id, reason: '', busy: false, problem: null } }, { withdraw: V3().id }) },
    { id: 'version', label: 'New DVR version from the record (held: v3 waits)', model: base('safety', { version: { draft: emptyVersionDraft(NORTH.id, TODAY), record: ready(northRecord()), busy: false, step: 'fill', addingAssessment: false, problem: null, frozen: null } }, { add: 'version' }) },
    { id: 'edit', label: 'The assessment\'s facts: name, next review, note', model: base('safety', { edit: { name: NORTH.name, nextReviewOn: NORTH.nextReviewOn ?? '', note: '', busy: false, problem: null } }, { add: 'edit' }) },
    { id: 'notice', label: 'After the last signature: the notice', model: base('safety', { notice: { tone: 'success', key: 'notice.signedComplete', params: { version: 'v3' } } }) },
    { id: 'loading', label: 'The assessment loading', model: base('safety', { record: loading }) },
    { id: 'error', label: 'The assessment failed: Try again', model: base('safety', { record: { status: 'error', problem: 'problem.read' } }) },
    { id: 'not-found', label: 'Not found', model: base('safety', { record: { status: 'error', problem: 'problem.notFound' } }) },
    { id: 'no-permission', label: 'Sales: no safety.view', model: base('sales', { record: { status: 'error', problem: 'problem.forbidden' } }) },
  ],
})
