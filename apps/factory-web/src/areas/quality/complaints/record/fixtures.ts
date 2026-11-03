import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { ApiFile } from '../../../../record-panels/api'
import { RecordProblem, RecordSkeleton } from '../../_shared/parts'
import type { AnswerCheck, Complaint } from '../api'
import { canFor, complaintOf, forRole, inShell, ME, NOW, PREFIX, QUALITY, ROWS, SAFETY_ID, STYLES, TODAY, withLetter, type RoleCase } from '../demo/fixtures'
import { answerDraftOf, investigationDraftOf, sendDraftOf, templateWords, withTemplate, type InvestigationDraft } from '../model'
import { ComplaintsMessages, useWords } from '../view/parts'
import { triageModel } from '../fixtures'
import { IDLE_ANSWER, type AnswerModel, type ComplaintRecordModel, type FactsDraft, type RecordDialog, type RecordTab } from './view-model'
import { ComplaintRecordView } from './view/ComplaintRecordView'

/**
 * Design cases of a complaint's record (SCR-113, the W2a part: Complaint · Linked records · Activity; the band's steps
 * held with their reasons; the dialogs). Made-up data only (../demo.ts). The Activity tab mounts the record panels in the
 * running app; here it shows a stand-in sentence.
 */

interface DesignModel {
  readonly role: RoleCase
  readonly record: ComplaintRecordModel | 'loading' | 'notFound' | 'forbidden'
}

const rowOf = (id: string) => ROWS.find((row) => row.id === id)!
const NEW = rowOf(ROWS.find((row) => row.status === 'NEW')!.id)
const SAFETY = rowOf(SAFETY_ID)
const INVESTIGATING = ROWS.find((row) => row.status === 'INVESTIGATING')!
const ANSWERED = ROWS.find((row) => row.status === 'ANSWERED')!
const CLOSED = ROWS.find((row) => row.status === 'CLOSED')!

const ACKNOWLEDGED: Complaint = complaintOf(
  { ...SAFETY, safety: { state: 'ACKNOWLEDGED', raisedAt: SAFETY.safety.raisedAt, acknowledgedAt: NOW, acknowledgedById: ME } },
  { repairs: [{ id: '0190f0e2-6510-7000-8000-000000000001', number: 'REP-DEMO-0004', stage: 'AWAITING_GOODS' }] },
)

function recordModel(complaint: Complaint, role: RoleCase, over: Partial<ComplaintRecordModel> = {}): ComplaintRecordModel {
  return {
    prefix: PREFIX,
    can: canFor(role),
    tab: 'complaint',
    complaint: forRole(complaint, role),
    photos: [
      { id: 'demo-photo-1', name: 'shoulder.jpg', src: null },
      { id: 'demo-photo-2', name: 'label.jpg', src: null },
    ],
    asOf: NOW,
    live: 'live',
    offline: false,
    today: TODAY,
    notice: null,
    changedAt: null,
    edit: null,
    styles: STYLES,
    dialog: null,
    dialogBusy: false,
    dialogProblem: null,
    sites: [{ id: '0190f0e2-2222-7000-8000-000000000001', companyId: complaint.companyId, code: 'DEMO-A1', name: 'Demo plant' }],
    triage: null,
    dockOpen: false,
    hrefs: {},
    ...over,
  }
}

const facts = (complaint: Complaint): FactsDraft => ({
  description: complaint.description,
  customerRef: complaint.customerRef ?? '',
  channel: 'EMAIL',
  styleId: complaint.style?.id ?? '',
  size: complaint.size ?? '',
  serial: complaint.serial ?? '',
  batchNumber: complaint.batchNumber ?? '',
  internalNote: '',
})

/** The record panels' place (they read the API in the running app). */
function PanelsStandIn() {
  const t = useWords()
  return createElement('p', { className: 'fw-q-hint' }, t('photos.addInActivity'))
}

/** ‹ Complaints, in the page's language. */
function Back() {
  const t = useWords()
  return createElement('a', { className: 'fw-q-link', href: `${PREFIX}/quality/complaints` }, t('record.back'))
}

function RecordDesign({ model }: { model: DesignModel }) {
  const [record, setRecord] = useState(model.record)
  useEffect(() => setRecord(model.record), [model.record])
  if (record === 'loading' || record === 'notFound' || record === 'forbidden') {
    const body =
      record === 'loading'
        ? createElement(RecordSkeleton)
        : createElement(RecordProblem, { problem: record === 'notFound' ? 'problem.notFound' : 'problem.forbidden', back: createElement(Back) })
    return inShell('/quality/complaints', createElement(ComplaintsMessages, null, body), model.role)
  }
  const panels = createElement(PanelsStandIn)
  return inShell(
    '/quality/complaints',
    createElement(ComplaintRecordView, {
      model: record,
      panels,
      actions: {
        onDialog: (dialog: RecordDialog | null) => setRecord((current) => (typeof current === 'string' ? current : { ...current, dialog })),
        onEdit: (on: boolean) => setRecord((current) => (typeof current === 'string' ? current : { ...current, edit: on ? { draft: facts(current.complaint), busy: false, problem: null } : null })),
        onEditDraft: (patch: Partial<FactsDraft>) => setRecord((current) => (typeof current === 'string' || !current.edit ? current : { ...current, edit: { ...current.edit, draft: { ...current.edit.draft, ...patch } } })),
        onTriage: () => setRecord((current) => (typeof current === 'string' ? current : { ...current, triage: triageModel(NEW.id, { queue: [NEW.id] }) })),
        onTriageClose: () => setRecord((current) => (typeof current === 'string' ? current : { ...current, triage: null })),
        onTriageDraft: (patch) => setRecord((current) => (typeof current === 'string' || !current.triage ? current : { ...current, triage: { ...current.triage, draft: { ...current.triage.draft, ...patch } } })),
        // B-W2b-113: the investigation and the letter answer to the reviewer's hands (nothing is saved or sent here).
        onInvestigationEdit: (on: boolean) => setRecord((current) => (typeof current === 'string' ? current : { ...current, investigation: on ? { draft: investigationDraftOf(current.complaint), busy: false, problem: null } : null })),
        onInvestigationDraft: (patch: Partial<InvestigationDraft>) => setRecord((current) => (typeof current === 'string' || !current.investigation ? current : { ...current, investigation: { ...current.investigation, draft: { ...current.investigation.draft, ...patch } } })),
        onAnswerTemplate: (template) => setRecord((current) => (typeof current === 'string' ? current : withAnswer(current, (answer) => { const result = withTemplate(answer.draft ?? answerDraftOf(current.complaint), { template }, current.complaint); return { ...answer, draft: result.draft, keptWords: result.keptWords } }))),
        onAnswerLanguage: (language) => setRecord((current) => (typeof current === 'string' ? current : withAnswer(current, (answer) => { const result = withTemplate(answer.draft ?? answerDraftOf(current.complaint), { language }, current.complaint); return { ...answer, draft: result.draft, keptWords: result.keptWords } }))),
        onAnswerText: (text) => setRecord((current) => (typeof current === 'string' ? current : withAnswer(current, (answer) => ({ ...answer, draft: { ...(answer.draft ?? answerDraftOf(current.complaint)), text } })))),
        onAnswerFile: (fileId, on) =>
          setRecord((current) => {
            if (typeof current === 'string') return current
            return withAnswer(current, (answer) => {
              const draft = answer.draft ?? answerDraftOf(current.complaint)
              return { ...answer, draft: { ...draft, fileIds: on ? [...new Set([...draft.fileIds, fileId])] : draft.fileIds.filter((id) => id !== fileId) } }
            })
          }),
        onAnswerDiscard: () => setRecord((current) => (typeof current === 'string' ? current : withAnswer(current, (answer) => ({ ...answer, draft: null, keptWords: false })))),
        onSend: () => setRecord((current) => (typeof current === 'string' ? current : { ...withAnswer(current, (answer) => ({ ...answer, check: CHECK })), dialog: { kind: 'send', draft: sendDraftOf(CHECK) } })),
        onSendDraft: (patch) => setRecord((current) => (typeof current === 'string' || current.dialog?.kind !== 'send' || !current.dialog.draft ? current : { ...current, dialog: { kind: 'send', draft: { ...current.dialog.draft, ...patch } } })),
      },
    }),
    model.role,
  )
}

const tab = (value: RecordTab) => ({ tab: value })

const withAnswer = (record: ComplaintRecordModel, change: (answer: AnswerModel) => AnswerModel): ComplaintRecordModel => ({ ...record, answer: change(record.answer ?? IDLE_ANSWER) })

// ---- B-W2b-113: the investigation and the answer letter (design cmp-inv, cmp-ans, cmp-letter) ---------------------------------

/** A one-page made-up PDF (Helvetica, ASCII), so the preview draws in the review. */
function demoPdf(lines: readonly string[]): Uint8Array {
  const escape = (text: string) => text.replace(/[\\()]/g, (char) => `\\${char}`)
  const content = ['BT', '/F1 11 Tf', '56 780 Td', '16 TL', ...lines.map((line, index) => `${index === 0 ? '' : 'T* '}(${escape(line)}) Tj`), 'ET'].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

const DEMO_LETTER = demoPdf(['Demo Factory Srl - made-up letterhead', '', 'Risposta al reclamo CMP-DEMO-0010', 'ANTEPRIMA - lettera non inviata', '', 'Gentile Dario Demo,', 'ripareremo il capo a nostre spese (made-up).', '', 'Cordiali saluti'])

const fileOf = (n: number, name: string, shared: boolean, complaint: Complaint): ApiFile => ({
  id: `0190f0e2-6511-7000-8000-00000000000${n}`,
  companyId: complaint.companyId,
  recordType: 'Complaint',
  recordId: complaint.id,
  kind: 'DOCUMENT',
  originalName: name,
  contentType: 'application/pdf',
  sizeBytes: 182_000,
  status: 'AVAILABLE',
  visibility: shared ? ['OFFICE', 'PARTNER'] : ['OFFICE'],
  partyId: shared ? complaint.party.id : null,
  retainUntil: null,
  legalHold: false,
  quarantineReason: null,
  availableAt: NOW,
  createdAt: NOW,
  version: 1,
})

const INVESTIGATED = complaintOf(INVESTIGATING, {
  findings: 'The returned pants were checked: the knee seam opened where the stitch density is below the specification (made-up).',
  rootCause: 'Thread tension drifted on one machine of line 2 (made-up).',
  return: { id: '0190f0e2-6508-7000-8000-000000000007', number: 'RMA-DEMO-0007', status: 'INSPECTED' },
  ncrs: [{ id: '0190f0e2-6507-7000-8000-000000000033', number: 'NCR-DEMO-0033', stage: 'CONTAINED' }],
})
const INSPECTION_REPORT = fileOf(1, 'inspection-report-RMA-DEMO-0007.pdf', true, INVESTIGATED)
const PHOTO_OFFICE = fileOf(2, 'seam-close-up.pdf', false, INVESTIGATED)
const LETTER_TEXT = templateWords('REPAIR', 'it', INVESTIGATED)
const WRITTEN = withLetter(INVESTIGATED, { template: 'REPAIR', language: 'it', text: LETTER_TEXT, files: [{ id: INSPECTION_REPORT.id, originalName: INSPECTION_REPORT.originalName, kind: 'DOCUMENT', status: 'AVAILABLE', shared: true }] })
const SENT: Complaint = (() => {
  const answered = complaintOf(ANSWERED, { findings: 'Mark from the cutting table, outside the garment\'s use (made-up).' })
  const text = templateWords('NOT_ACCEPTED', 'en', answered)
  return withLetter(answered, {
    template: 'NOT_ACCEPTED',
    language: 'en',
    text,
    sent: { documentId: '0190f0e2-6512-7000-8000-000000000002', version: 2, language: 'en', fileId: '0190f0e2-6513-7000-8000-000000000002', at: NOW, byId: QUALITY.id, via: 'EMAIL' },
    versions: [
      { id: '0190f0e2-6512-7000-8000-000000000002', version: 2, language: 'en', fileId: '0190f0e2-6513-7000-8000-000000000002', createdAt: NOW, createdById: QUALITY.id },
      { id: '0190f0e2-6512-7000-8000-000000000001', version: 1, language: 'it', fileId: '0190f0e2-6513-7000-8000-000000000001', createdAt: '2026-10-20T10:40:00.000Z', createdById: QUALITY.id },
    ],
    suggestedLanguage: 'en',
  })
})()
const CHECK: AnswerCheck = {
  ready: true,
  problems: [],
  recipients: [
    { contactId: '0190f0e2-6509-7000-8000-000000000001', name: 'Dario Demo', email: 'dario.demo@example.com', language: 'it', suggested: true },
    { contactId: '0190f0e2-6509-7000-8000-000000000002', name: 'Ufficio qualità Demo', email: 'qualita@example.com', language: 'it', suggested: false },
  ],
  language: 'it',
  subject: 'Risposta al reclamo CMP-DEMO-0010',
  message: 'Gentile Dario Demo,\n\nin allegato la nostra risposta al Vostro reclamo CMP-DEMO-0010.\n\nCordiali saluti',
}
const CHECK_PROBLEMS: AnswerCheck = {
  ...CHECK,
  ready: false,
  recipients: [],
  problems: [
    { path: 'contactIds', message: 'x' },
    { path: 'letter/company/rea', message: 'x' },
  ],
}

const answerTab = (complaint: Complaint, role: RoleCase, answer: Partial<AnswerModel> = {}, over: Partial<ComplaintRecordModel> = {}) =>
  recordModel(complaint, role, { tab: 'answer', answer: { ...IDLE_ANSWER, files: [INSPECTION_REPORT, PHOTO_OFFICE], ...answer }, ...over })
const ready = { preview: { status: 'ready' as const, data: DEMO_LETTER, language: 'it' as const } }
const changedDraft = { ...answerDraftOf(WRITTEN), template: 'REPLACEMENT' as const, text: `${LETTER_TEXT}\n\nP.S. made-up words of our own.` }

const ANSWER_CASES = [
  { id: 'investigation', label: 'W2b — Investigation: findings, root cause, the return, the NCR and the CAPA', model: { role: 'owner' as RoleCase, record: recordModel(INVESTIGATED, 'owner', tab('investigation')) } },
  { id: 'investigation-editing', label: 'W2b — Investigation in edit mode (EditModeBar, ⌘S)', model: { role: 'owner' as RoleCase, record: recordModel(INVESTIGATED, 'owner', { tab: 'investigation', investigation: { draft: { findings: `${INVESTIGATED.findings} More found on a second pair (made-up).`, rootCause: INVESTIGATED.rootCause ?? '' }, busy: false, problem: null } }) } },
  { id: 'investigation-empty', label: 'W2b — Investigation: nothing written yet', model: { role: 'owner' as RoleCase, record: recordModel(complaintOf(INVESTIGATING), 'owner', tab('investigation')) } },
  { id: 'investigation-held', label: 'W2b — Investigation of a new complaint: held, triage first', model: { role: 'owner' as RoleCase, record: recordModel(complaintOf(NEW), 'owner', tab('investigation')) } },
  { id: 'investigation-capa-elsewhere', label: 'W2b — Investigation: escalated to a CAPA the reader may not see', model: { role: 'readOnly' as RoleCase, record: recordModel(complaintOf(INVESTIGATING, { capaRecord: null, capaElsewhere: true }), 'readOnly', tab('investigation')) } },
  { id: 'answer', label: 'W2b — Answer: the letter from the Repair template, its preview, an attachment shared', model: { role: 'owner' as RoleCase, record: answerTab(WRITTEN, 'owner', ready) } },
  { id: 'answer-draft', label: 'W2b — Answer: another template picked while the person\'s own words stay', model: { role: 'owner' as RoleCase, record: answerTab(WRITTEN, 'owner', { ...ready, draft: changedDraft, keptWords: true }) }, note: 'Send is held until the letter is saved; the preview shows the letter as saved.' },
  { id: 'answer-empty', label: 'W2b — Answer: nothing written yet (Send held: no words)', model: { role: 'owner' as RoleCase, record: answerTab(complaintOf(INVESTIGATING), 'owner') } },
  { id: 'answer-send', label: 'W2b — Send…: the review before anything goes', model: { role: 'owner' as RoleCase, record: answerTab(WRITTEN, 'owner', { ...ready, check: CHECK }, { dialog: { kind: 'send', draft: sendDraftOf(CHECK) } }) } },
  { id: 'answer-send-reading', label: 'W2b — Send…: the customer\'s contacts being read', model: { role: 'owner' as RoleCase, record: answerTab(WRITTEN, 'owner', ready, { dialog: { kind: 'send', draft: null } }) } },
  { id: 'answer-send-problems', label: 'W2b — Send…: no contact with an e-mail, the letterhead incomplete (held)', model: { role: 'owner' as RoleCase, record: answerTab(WRITTEN, 'owner', { ...ready, check: CHECK_PROBLEMS }, { dialog: { kind: 'send', draft: sendDraftOf(CHECK_PROBLEMS) } }) } },
  { id: 'answer-send-refused', label: 'W2b — Send… refused: a file not shared with the customer (in words)', model: { role: 'owner' as RoleCase, record: answerTab(WRITTEN, 'owner', { ...ready, check: CHECK }, { dialog: { kind: 'send', draft: sendDraftOf(CHECK) }, dialogProblem: 'answer.send.problem.notShared' }) } },
  { id: 'answer-sent', label: 'W2b — Answered by letter: when, who, how; frozen; the versions kept', model: { role: 'owner' as RoleCase, record: answerTab(SENT, 'owner', { preview: { status: 'ready', data: DEMO_LETTER, language: 'en' } }) }, note: 'Back to investigating (⋯) opens the letter again; the versions stay.' },
  { id: 'answer-answered-phone', label: 'W2b — Answered by phone (no letter): the letter frozen', model: { role: 'owner' as RoleCase, record: answerTab(complaintOf(ANSWERED), 'owner') } },
  { id: 'answer-read-only', label: 'W2b — Answer for a read-only role: every step held with its permission', model: { role: 'readOnly' as RoleCase, record: answerTab(WRITTEN, 'readOnly', ready) } },
  { id: 'answer-loading-preview', label: 'W2b — Answer: the preview being made', model: { role: 'owner' as RoleCase, record: answerTab(WRITTEN, 'owner', { preview: { status: 'loading' } }) } },
  { id: 'answer-preview-error', label: 'W2b — Answer: the preview refused (the letterhead is incomplete)', model: { role: 'owner' as RoleCase, record: answerTab(WRITTEN, 'owner', { preview: { status: 'error', problem: 'answer.preview.letterhead' } }) } },
  { id: 'answer-files-reading', label: 'W2b — Answer: the complaint\'s files being read', model: { role: 'owner' as RoleCase, record: answerTab(WRITTEN, 'owner', { ...ready, files: null }) } },
  { id: 'answer-held-new', label: 'W2b — Answer of a new complaint: held, triage first', model: { role: 'owner' as RoleCase, record: answerTab(complaintOf(NEW), 'owner') } },
  { id: 'answer-offline', label: 'W2b — Answer offline: Save and Send held', model: { role: 'owner' as RoleCase, record: answerTab(WRITTEN, 'owner', { ...ready, draft: changedDraft }, { live: 'offline', offline: true }) } },
  { id: 'answer-receipt', label: 'W2b — The receipt after a send', model: { role: 'owner' as RoleCase, record: answerTab(SENT, 'owner', { preview: { status: 'ready', data: DEMO_LETTER, language: 'en' } }, { notice: { tone: 'success', words: { key: 'done.answerSent', params: { number: SENT.number, version: 2 } } } }) } },
  { id: 'linked-capa', label: 'W2b — Linked records: the CAPA it is escalated to', model: { role: 'owner' as RoleCase, record: recordModel(INVESTIGATED, 'owner', tab('linked')) } },
]

// ---- B-W2b-17: Link… / Unlink (design cmp-links) -------------------------------------------------------------------------
const NCR_31 = SAFETY.ncrs[0]!
const LINKED = complaintOf(SAFETY, { safety: { state: 'ACKNOWLEDGED', raisedAt: SAFETY.safety.raisedAt, acknowledgedAt: NOW, acknowledgedById: ME }, serial: 'S-DEMO-000512', evidence: { kind: 'serial', subject: 'S-DEMO-000512' }, ncrs: [NCR_31, { id: '0190f0e2-6507-7000-8000-000000000032', number: 'NCR-DEMO-0032', stage: 'CONTAINED' }] })
const linkTab = (complaint: Complaint, role: RoleCase, over: Partial<ComplaintRecordModel> = {}) => recordModel(complaint, role, { tab: 'linked', raisedFrom: [NCR_31.id], ...over })
const linkDialog = (type: '' | 'SalesOrder' | 'Shipment' | 'ReturnAuthorisation' | 'GarmentSerial' | 'Nonconformance', over: Partial<{ recordId: string; serial: string }> = {}): RecordDialog => ({ kind: 'link', type, recordId: over.recordId ?? '', serial: over.serial ?? '' })
const ORDER_OPTIONS = { type: 'SalesOrder' as const, items: [{ id: '0190f0e2-6504-7000-8000-000000000003', label: 'SO-DEMO-003' }, { id: '0190f0e2-6504-7000-8000-000000000004', label: 'SO-DEMO-004' }], problem: null }
const NCR_OPTIONS = { type: 'Nonconformance' as const, items: [{ id: '0190f0e2-6507-7000-8000-000000000040', label: 'NCR-DEMO-0040', sub: 'Shoulder protector pocket seam (made-up)' }, { id: '0190f0e2-6507-7000-8000-000000000041', label: 'NCR-DEMO-0041', sub: 'Lining label missing (made-up)' }], problem: null }
const RETURN_OPTIONS = { type: 'ReturnAuthorisation' as const, items: [{ id: '0190f0e2-6508-7000-8000-000000000005', label: 'RMA-DEMO-0005' }], problem: null }
const NEW_COMPLAINT = complaintOf(NEW)
const W2B_CASES = [
  {
    id: 'w2b-linked',
    label: 'W2b — Linked records: Link…, and Unlink on each linked record',
    model: { role: 'owner' as RoleCase, record: linkTab(LINKED, 'owner') },
    note: 'B-W2b-17: the order, shipment, return and garment are the complaint\'s own facts (one each); NCR-DEMO-0031 was raised from it, so its Unlink is held with the reason.',
  },
  { id: 'w2b-link-what', label: 'W2b — Link…: what to link (types held with their reasons)', model: { role: 'owner' as RoleCase, record: linkTab(LINKED, 'owner', { dialog: linkDialog('') }) }, note: 'Order and shipment say what is linked now: unlink it first to link another.' },
  { id: 'w2b-link-order', label: 'W2b — Link… an order of this customer', model: { role: 'owner' as RoleCase, record: linkTab(NEW_COMPLAINT, 'owner', { dialog: linkDialog('SalesOrder', { recordId: ORDER_OPTIONS.items[0]!.id }), linkOptions: ORDER_OPTIONS }) } },
  { id: 'w2b-link-order-taken', label: 'W2b — Link… an order while one is linked: held', model: { role: 'owner' as RoleCase, record: linkTab(LINKED, 'owner', { dialog: linkDialog('SalesOrder', { recordId: ORDER_OPTIONS.items[1]!.id }), linkOptions: ORDER_OPTIONS }) } },
  { id: 'w2b-link-return', label: 'W2b — Link… a return', model: { role: 'owner' as RoleCase, record: linkTab(NEW_COMPLAINT, 'owner', { dialog: linkDialog('ReturnAuthorisation'), linkOptions: RETURN_OPTIONS }) } },
  { id: 'w2b-link-garment', label: 'W2b — Link… a garment by its serial', model: { role: 'owner' as RoleCase, record: linkTab(complaintOf(INVESTIGATING), 'owner', { dialog: linkDialog('GarmentSerial', { serial: 'S-DEMO-000777' }) }) } },
  { id: 'w2b-link-ncr', label: 'W2b — Link… an open NCR of the company', model: { role: 'owner' as RoleCase, record: linkTab(LINKED, 'owner', { dialog: linkDialog('Nonconformance', { recordId: NCR_OPTIONS.items[0]!.id }), linkOptions: NCR_OPTIONS }) } },
  { id: 'w2b-link-reading', label: 'W2b — Link…: the choices still being read', model: { role: 'owner' as RoleCase, record: linkTab(NEW_COMPLAINT, 'owner', { dialog: linkDialog('Shipment'), linkOptions: { type: 'Shipment', items: null, problem: null } }) } },
  { id: 'w2b-link-error', label: 'W2b — Link…: the choices could not be read', model: { role: 'owner' as RoleCase, record: linkTab(NEW_COMPLAINT, 'owner', { dialog: linkDialog('Shipment'), linkOptions: { type: 'Shipment', items: null, problem: 'quality:problem.unavailable' } }) } },
  {
    id: 'w2b-link-refused',
    label: 'W2b — Link… refused: linked to another one already (in words)',
    model: { role: 'owner' as RoleCase, record: linkTab(NEW_COMPLAINT, 'owner', { dialog: linkDialog('SalesOrder', { recordId: ORDER_OPTIONS.items[0]!.id }), linkOptions: ORDER_OPTIONS, dialogProblem: 'links.refused.taken' }) },
  },
  { id: 'w2b-link-garment-unknown', label: 'W2b — Link… a serial no garment of ours has', model: { role: 'owner' as RoleCase, record: linkTab(complaintOf(INVESTIGATING), 'owner', { dialog: linkDialog('GarmentSerial', { serial: 'S-DEMO-999999' }), dialogProblem: 'links.refused.garment' }) } },
  { id: 'w2b-unlink', label: 'W2b — Unlink the shipment', model: { role: 'owner' as RoleCase, record: linkTab(LINKED, 'owner', { dialog: { kind: 'unlink', type: 'Shipment', recordId: LINKED.shipment!.id, label: LINKED.shipment!.number } }) } },
  { id: 'w2b-unlink-garment', label: 'W2b — Unlink the garment (its serial)', model: { role: 'owner' as RoleCase, record: linkTab(LINKED, 'owner', { dialog: { kind: 'unlink', type: 'GarmentSerial', recordId: '', label: 'S-DEMO-000512' } }) } },
  {
    id: 'w2b-unlink-refused',
    label: 'W2b — Unlink refused: the NCR was raised from this complaint',
    model: { role: 'owner' as RoleCase, record: linkTab(LINKED, 'owner', { raisedFrom: null, dialog: { kind: 'unlink', type: 'Nonconformance', recordId: NCR_31.id, label: NCR_31.number }, dialogProblem: 'links.refused.source' }) },
    note: 'When the source could not be read before, the API refuses and the dialog says why.',
  },
  { id: 'w2b-linked-closed', label: 'W2b — Closed: links read-only', model: { role: 'owner' as RoleCase, record: linkTab(complaintOf(CLOSED, { order: { id: '0190f0e2-6504-7000-8000-000000000009', number: 'SO-DEMO-009', status: 'SHIPPED', currency: 'EUR' } }), 'owner') } },
  { id: 'w2b-linked-read-only', label: 'W2b — Read-only role: Link… and Unlink held with the permission', model: { role: 'readOnly' as RoleCase, record: linkTab(LINKED, 'readOnly') } },
  { id: 'w2b-linked-sales', label: 'W2b — Sales on a new complaint: Link… what its role sees (a garment held: no serial finder)', model: { role: 'sales' as RoleCase, record: linkTab(NEW_COMPLAINT, 'sales', { dialog: linkDialog('') }) } },
  { id: 'w2b-linked-offline', label: 'W2b — Offline: Link… and Unlink held', model: { role: 'owner' as RoleCase, record: linkTab(LINKED, 'owner', { live: 'offline', offline: true }) } },
  { id: 'w2b-mail-hint', label: 'W2b — Complaint tab: mail naming the number lands on the thread', model: { role: 'owner' as RoleCase, record: recordModel(LINKED, 'owner') } },
]

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-113-complaint',
  title: 'Complaint (record, investigation, answer, linked records, activity)',
  view: RecordDesign,
  cases: [
    { id: 'new', label: 'New: Triage first (the owner)', model: { role: 'owner', record: recordModel(complaintOf(NEW), 'owner') } },
    {
      id: 'safety-raised',
      label: 'Triaged Safety: the alert not yet acknowledged; Close held',
      model: { role: 'owner', record: recordModel(complaintOf(SAFETY), 'owner') },
      note: 'The banner stays until the owner acknowledges it; Close is held: a safety complaint closes only after that.',
    },
    {
      id: 'safety-inspector',
      label: 'Quality inspector on the same: Acknowledge held (only the owner)',
      model: { role: 'inspector', record: recordModel(complaintOf(SAFETY), 'inspector') },
    },
    {
      id: 'acknowledged',
      label: 'Acknowledged and in the PPE register; a repair made from it',
      model: { role: 'owner', record: recordModel(ACKNOWLEDGED, 'owner') },
    },
    { id: 'linked', label: 'Linked records: NCR, register entry, shipment, order, garment', model: { role: 'owner', record: recordModel(ACKNOWLEDGED, 'owner', tab('linked')) } },
    { id: 'activity', label: 'Activity: the record panels', model: { role: 'owner', record: recordModel(ACKNOWLEDGED, 'owner', tab('activity')) } },
    { id: 'investigating', label: 'Investigating: Mark answered; answer overdue', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner') } },
    { id: 'answered', label: 'Answered: Close; back to investigating under ⋯', model: { role: 'owner', record: recordModel(complaintOf(ANSWERED), 'owner') } },
    { id: 'closed', label: 'Closed: read-only, every step held', model: { role: 'owner', record: recordModel(complaintOf(CLOSED), 'owner') } },
    { id: 'sales', label: 'Sales: sees and edits a new one; triage held', model: { role: 'sales', record: recordModel(complaintOf(NEW), 'sales') } },
    { id: 'read-only', label: 'Read-only: every step held with its permission', model: { role: 'readOnly', record: recordModel(complaintOf(INVESTIGATING), 'readOnly') } },
    { id: 'edit', label: 'Edit the facts (EditModeBar, ⌘S)', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner', { edit: { draft: facts(complaintOf(INVESTIGATING)), busy: false, problem: null } }) } },
    { id: 'triage', label: 'Triage from the record', model: { role: 'owner', record: recordModel(complaintOf(NEW), 'owner', { triage: triageModel(NEW.id, { queue: [NEW.id] }) }) } },
    { id: 'dialog-close', label: 'Close: the reason (required)', model: { role: 'owner', record: recordModel(complaintOf(ANSWERED), 'owner', { dialog: { kind: 'close', reason: '' } }) } },
    { id: 'dialog-answered', label: 'Mark answered with a note', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner', { dialog: { kind: 'move', to: 'ANSWERED', note: '' } }) } },
    { id: 'dialog-ncr', label: 'Create NCR: site and severity', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner', { dialog: { kind: 'ncr', siteId: '', severity: 'MAJOR' } }) } },
    { id: 'dialog-repair', label: 'Make a repair from the complaint', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner', { dialog: { kind: 'repair', siteId: '', received: false } }) } },
    { id: 'dialog-register', label: 'Add to the PPE register (a non-safety complaint)', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner', { dialog: { kind: 'register', risk: 'NO' } }) } },
    { id: 'dialog-acknowledge', label: 'Acknowledge the safety alert', model: { role: 'owner', record: recordModel(complaintOf(SAFETY), 'owner', { dialog: { kind: 'acknowledge' } }) } },
    {
      id: 'dialog-refused',
      label: 'Close refused: the owner has not acknowledged it (in words)',
      model: { role: 'owner', record: recordModel(complaintOf(SAFETY), 'owner', { dialog: { kind: 'close', reason: 'Answered.' }, dialogProblem: 'held.SAFETY_NOT_ACKNOWLEDGED' }) },
    },
    { id: 'changed', label: 'Changed by someone else while open: Reload', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner', { changedAt: NOW }) } },
    { id: 'offline', label: 'Offline: the last copy, writes held', model: { role: 'owner', record: recordModel(complaintOf(INVESTIGATING), 'owner', { live: 'offline', offline: true }) } },
    ...W2B_CASES,
    ...ANSWER_CASES,
    { id: 'loading', label: 'Loading', model: { role: 'owner', record: 'loading' } },
    { id: 'not-found', label: 'Not found', model: { role: 'owner', record: 'notFound' } },
    { id: 'no-permission', label: 'No permission', model: { role: 'none', record: 'forbidden' } },
  ],
})
