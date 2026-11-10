import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import { RecordPanelsView } from '../../../../record-panels/view/RecordPanelsView'
import { STEP_UP_CLOSED } from '../../../quality/_shared/hooks'
import { inShell, PREFIX, ROLE_PERMISSIONS, type RoleCase } from '../../../quality/_shared/fixtures'
import { ARCHIVED_RECORD, BUILDING_PACK, BUILT_PACK, COMPLETE_RECORD, FAILED_PACK, NOW, OPEN_RECORD, PACKS, PEOPLE, PRODUCTION, REPORTS, RISK, RISK_EMPTY, RISK_SIGNED, TODAY } from '../_demo/fixtures'
import type { FileRecord } from '../api'
import { emptyRecord, emptySchedule, emptyShare, failed, LOADING, ready, techfilesCan, type RecordTab } from '../model'
import { emptyPack } from '../model'
import { IDLE, type RecordModel } from './view-model'
import { RecordLoadingView, RecordProblemView, TechFileRecordView } from './view/TechFileRecordView'

/**
 * SCR-120-file — a technical file (design compliance.techfiles › Technical file) with made-up data only: each tab (Annex III,
 * Risk assessment, Test reports, Production control, Evidence pack, Activity), each tab loading and failing on its own, the
 * file open, complete and archived, every pop-up (link evidence, not applicable, edit, reopen, archive, sign with the code,
 * record and schedule a test, send by link and its answer, withdraw a link, build a pack), a refusal in words with the API's
 * lines, a change by someone else, offline, and the roles (quality inspector, production manager, read only).
 */

export interface RecordDesignModel {
  readonly role: RoleCase
  readonly state: 'ready' | 'loading' | 'problem'
  readonly problem?: string
  readonly record?: RecordModel
}

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel

function panelsOf(record: FileRecord): ReactNode {
  const model: RecordPanelsViewModel = { ...conversation, record: { type: 'TechnicalFile', id: record.file.id, companyId: record.file.companyId, siteId: null }, title: `${record.file.number} · ${record.file.style.code}`, party: null }
  return createElement(RecordPanelsView, { model })
}

function base(role: RoleCase, record: FileRecord, over: Partial<RecordModel> = {}): RecordDesignModel {
  return {
    role,
    state: 'ready',
    record: {
      prefix: PREFIX,
      can: techfilesCan(ROLE_PERMISSIONS[role]),
      tab: 'annex',
      record,
      asOf: NOW,
      live: 'live',
      online: true,
      today: TODAY,
      notice: null,
      changedAt: null,
      dockOpen: false,
      fileDialog: null,
      keepers: null,
      certificates: null,
      busyItem: null,
      evidence: null,
      risk: ready(RISK),
      riskUi: { shown: null, zone: null, marks: {}, selected: [], reasoning: null, reasoningMark: null, sign: null, writing: IDLE },
      reports: ready(REPORTS),
      production: ready(PRODUCTION),
      testDialog: null,
      packs: ready(PACKS),
      share: null,
      withdraw: null,
      pack: null,
      stepUp: STEP_UP_CLOSED,
      ...over,
    },
  }
}

const tab = (role: RoleCase, value: RecordTab, over: Partial<RecordModel> = {}, record: FileRecord = OPEN_RECORD) => base(role, record, { tab: value, ...over })

function RecordDesign({ model }: { model: RecordDesignModel }) {
  const path = '/compliance/techfiles'
  if (model.state === 'loading') return inShell(path, createElement(RecordLoadingView), model.role)
  if (model.state === 'problem' || !model.record) return inShell(path, createElement(RecordProblemView, { problem: model.problem ?? 'problem.unavailable', prefix: PREFIX }), model.role)
  return inShell(path, createElement(TechFileRecordView, { model: model.record, panels: panelsOf(model.record.record) }), model.role)
}

const OPTIONS = ready([
  { kind: 'RECORD' as const, recordType: 'StyleRevision', recordId: '0190f0e2-7408-7000-8000-000000000004', fileId: null, label: 'DEMO-JKT-01 revision 2 (its BOM, routing and construction)', state: 'CURRENT', points: ['A_DESCRIPTION' as const, 'D_DRAWINGS' as const, 'E_EXPLANATIONS' as const], linked: true },
  { kind: 'RECORD' as const, recordType: 'WorkInstructionVersion', recordId: '0190f0e2-7408-7000-8000-000000000011', fileId: null, label: 'Work instruction WI-DEMO-0007 v3', state: 'CURRENT', points: ['E_EXPLANATIONS' as const, 'J_PRODUCTION_CONTROL' as const], linked: false },
  { kind: 'FILE' as const, recordType: 'TechnicalFile', recordId: null, fileId: '0190f0e2-7409-7000-8000-000000000001', label: 'Disegno tecnico DEMO-JKT-01 rev2.pdf', state: 'AVAILABLE', points: ['D_DRAWINGS' as const, 'E_EXPLANATIONS' as const], linked: true },
])

export const designScreen = defineDesignScreen<RecordDesignModel>({
  screen: 'SCR-120-file',
  title: 'Technical file',
  view: RecordDesign,
  holdsPage: true,
  cases: [
    { id: 'annex', label: 'Annex III checklist: 13 points, evidence linked or missing, Complete held with the open points', model: tab('owner', 'annex'), note: 'Point (b) links a superseded assessment: it says so.' },
    { id: 'annex-created', label: 'Just created: the receipt says nothing is reviewed yet', model: tab('owner', 'annex', { notice: { tone: 'success', key: 'done.created' } }) },
    { id: 'evidence-find', label: 'Link evidence: the finder of records and files (the fitting ones first)', model: tab('owner', 'annex', { evidence: { point: 'E_EXPLANATIONS', itemId: OPEN_RECORD.points[4]!.items[0]!.id, mode: 'link', options: OPTIONS, choice: '', note: '', upload: null, writing: IDLE } }) },
    { id: 'evidence-upload', label: 'Link evidence: a drawing uploaded from this device', model: tab('owner', 'annex', { evidence: { point: 'D_DRAWINGS', itemId: null, mode: 'link', options: OPTIONS, choice: 'UPLOAD', note: '', upload: { name: 'Spaccato DEMO-JKT-01.pdf', size: 482_113, type: 'application/pdf' }, writing: IDLE } }) },
    { id: 'evidence-na', label: 'Not applicable: why, in words', model: tab('owner', 'annex', { evidence: { point: 'J_PRODUCTION_CONTROL', itemId: OPEN_RECORD.points[9]!.items[0]!.id, mode: 'na', options: LOADING, choice: '', note: '', upload: null, writing: IDLE } }) },
    {
      id: 'evidence-refused',
      label: 'Link refused: our title with the API\'s line',
      model: tab('owner', 'annex', { evidence: { point: 'E_EXPLANATIONS', itemId: null, mode: 'link', options: OPTIONS, choice: 'RECORD:WorkInstructionVersion:0190f0e2-7408-7000-8000-000000000011', note: '', upload: null, writing: { busy: false, problem: { tone: 'danger', key: 'refused.evidence', detail: ['That record is not of style DEMO-JKT-01.'] } } } }),
    },
    { id: 'complete', label: 'A complete file: read only, Build evidence pack first', model: base('owner', COMPLETE_RECORD) },
    { id: 'archived', label: 'An archived file: kept until, why', model: base('owner', ARCHIVED_RECORD) },
    { id: 'edit', label: 'Edit: certificate, owner, note', model: tab('owner', 'annex', { fileDialog: { dialog: { kind: 'edit', certificateId: OPEN_RECORD.file.certificate?.id ?? '', keeperId: PEOPLE.me.id, note: '', retainUntil: '' }, writing: IDLE }, keepers: ready([PEOPLE.me, PEOPLE.luca, PEOPLE.sara]), certificates: ready([]) }) },
    { id: 'reopen', label: 'Reopen with a reason', model: base('owner', COMPLETE_RECORD, { fileDialog: { dialog: { kind: 'reopen', reason: '' }, writing: IDLE } }) },
    { id: 'archive', label: 'Archive with a reason and a keep-until day', model: tab('owner', 'annex', { fileDialog: { dialog: { kind: 'archive', reason: 'Style no longer made.', retainUntil: '' }, writing: IDLE } }) },
    { id: 'complete-refused', label: 'Complete refused (409): the open points in the API\'s words', model: tab('owner', 'annex', { notice: { tone: 'danger', key: 'refused.record', detail: ['Point (b) is not reviewed.', 'Point (e) has no evidence.'] } }) },
    { id: 'risk', label: 'Risk assessment: the draft revision 2, hazards on the garment, autosave per cell, sign-off waiting', model: tab('owner', 'risk') },
    { id: 'risk-zone', label: 'A zone picked on the garment: its hazards, add one there', model: tab('owner', 'risk', { riskUi: { shown: null, zone: 'ELBOW_L', marks: {}, selected: [], reasoning: null, reasoningMark: null, sign: null, writing: IDLE } }) },
    {
      id: 'risk-marks',
      label: 'Cells saving and one refused (its reason on the mark)',
      model: tab('owner', 'risk', { riskUi: { shown: null, zone: null, marks: { [`${RISK.assessments[1]!.rows[0]!.id}:control`]: { state: 'saving' }, [`${RISK.assessments[1]!.rows[1]!.id}:garmentZone`]: { state: 'refused', problem: 'problem.zone' } }, selected: [], reasoning: null, reasoningMark: null, sign: null, writing: IDLE } }),
    },
    { id: 'risk-signed', label: 'A signed revision: read only, Start revision 2', model: tab('owner', 'risk', { risk: ready(RISK_SIGNED) }) },
    { id: 'risk-empty', label: 'No assessment yet: Start revision 1', model: tab('owner', 'risk', { risk: ready(RISK_EMPTY) }) },
    { id: 'risk-loading', label: 'Risk assessment loading', model: tab('owner', 'risk', { risk: LOADING }) },
    { id: 'risk-error', label: 'Risk assessment failed: the rest stays', model: tab('owner', 'risk', { risk: failed('problem.unavailable') }) },
    { id: 'sign', label: 'Sign revision 2: typed name and function', model: tab('owner', 'risk', { riskUi: { shown: null, zone: null, marks: {}, selected: [], reasoning: null, reasoningMark: null, sign: { name: PEOPLE.me.name, fn: 'Quality manager', writing: IDLE }, writing: IDLE } }) },
    { id: 'sign-code', label: 'Sign: the fresh code (StepUpModal)', model: tab('owner', 'risk', { riskUi: { shown: null, zone: null, marks: {}, selected: [], reasoning: null, reasoningMark: null, sign: { name: PEOPLE.me.name, fn: 'Quality manager', writing: { busy: true, problem: null } }, writing: IDLE }, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.sign', problem: null } }) },
    { id: 'signed-reopened', label: 'Signed on a complete file: it went back to open', model: tab('owner', 'risk', { risk: ready(RISK_SIGNED), notice: { tone: 'warning', key: 'done.signedReopened', params: { revision: 2 } } }) },
    { id: 'tests', label: 'Test reports: control tests, the certificate\'s file, Link a report', model: tab('owner', 'tests') },
    { id: 'tests-empty', label: 'Test reports: none yet', model: tab('owner', 'tests', { reports: ready({ ...REPORTS, reports: [] }) }) },
    { id: 'tests-error', label: 'Test reports failed', model: tab('owner', 'tests', { reports: failed('problem.unavailable') }) },
    { id: 'production', label: 'Production control: per batch (complete, missing, failed, in production) and the plan with what is due', model: tab('owner', 'production') },
    { id: 'production-loading', label: 'Production control loading', model: tab('owner', 'production', { production: LOADING }) },
    { id: 'record-test', label: 'Record test: result, day, lab, the lab report', model: tab('owner', 'production', { testDialog: { kind: 'record', testId: PRODUCTION.tests[1]!.id, schedule: emptySchedule(TODAY), record: { ...emptyRecord(TODAY), result: 'PASS', testedBy: 'Laboratorio Demo', file: { name: 'Rapporto DEMO-RP-122.pdf', size: 233_001, type: 'application/pdf' } }, writing: IDLE } }) },
    { id: 'schedule-test', label: 'Schedule test: what, how often, when, for which batch', model: tab('owner', 'production', { testDialog: { kind: 'schedule', testId: null, schedule: emptySchedule(TODAY, 'LABEL_DURABILITY', PRODUCTION.batches[0]!.workOrder.id), record: emptyRecord(TODAY), writing: IDLE } }) },
    { id: 'packs', label: 'Evidence pack: a built pack with its links (views, withdraw), a failed one', model: tab('owner', 'pack') },
    { id: 'packs-building', label: 'A pack being built: JobProgress', model: tab('owner', 'pack', { packs: ready({ ...PACKS, packs: [BUILDING_PACK, BUILT_PACK] }) }) },
    { id: 'packs-empty', label: 'No packs yet: Build new pack', model: tab('owner', 'pack', { packs: ready({ ...PACKS, packs: [] }) }) },
    { id: 'build-pack', label: 'Build evidence pack from the record', model: tab('owner', 'pack', { pack: { file: { id: OPEN_RECORD.file.id, number: OPEN_RECORD.file.number, style: { code: OPEN_RECORD.file.style.code, name: OPEN_RECORD.file.style.name } }, draft: { ...emptyPack('de', 'LOT-DEMO-0044'), recipient: 'Marktaufsicht Demo' }, parties: null, shipments: null, busy: false, problem: null, pack: null, startedAt: null, online: true, held: null } }) },
    { id: 'share', label: 'Send by link: party, password, end day, e-mail', model: tab('owner', 'pack', { share: { packId: BUILT_PACK.id, draft: { ...emptyShare(TODAY, 'it', BUILT_PACK.recipientParty!.id), email: 'pruefung@marktaufsicht-demo.example' }, parties: ready([{ id: BUILT_PACK.recipientParty!.id, code: 'DEMO-AUT-DE', name: 'Marktaufsicht Demo' }]), writing: IDLE, done: null } }) },
    { id: 'share-code', label: 'Send by link: the fresh code', model: tab('owner', 'pack', { share: { packId: BUILT_PACK.id, draft: { ...emptyShare(TODAY, 'it', BUILT_PACK.recipientParty!.id), password: 'Demo-pass-2026', email: 'pruefung@marktaufsicht-demo.example' }, parties: null, writing: { busy: true, problem: null }, done: null }, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.share', problem: 'stepUp.problem.wrong' } }) },
    { id: 'share-done', label: 'Sent without e-mail: the address shown once, Copy', model: tab('owner', 'pack', { share: { packId: BUILT_PACK.id, draft: emptyShare(TODAY, 'it'), parties: null, writing: IDLE, done: { pack: BUILT_PACK, linkId: BUILT_PACK.links[0]!.id, url: 'https://factory.example/l#token=DEMO-ONLY', delivery: null } } }) },
    { id: 'withdraw', label: 'Withdraw a link', model: tab('owner', 'pack', { withdraw: { packId: BUILT_PACK.id, linkId: BUILT_PACK.links[0]!.id, reason: '', writing: IDLE } }) },
    { id: 'packs-failed-only', label: 'A failed pack: why, Remove', model: tab('owner', 'pack', { packs: ready({ ...PACKS, packs: [FAILED_PACK] }) }) },
    { id: 'activity', label: 'Activity: the thread, files and history', model: tab('owner', 'activity') },
    { id: 'dock', label: 'The thread beside the file on a wide screen (⌘J)', model: tab('owner', 'annex', { dockOpen: true }) },
    { id: 'changed', label: 'Changed by someone else while a pop-up was open: Read it again', model: tab('owner', 'annex', { changedAt: NOW }) },
    { id: 'offline', label: 'Offline: every write held with the reason', model: tab('owner', 'annex', { online: false, live: 'offline' }) },
    { id: 'inspector', label: 'Quality inspector (keeps, signs, sends)', model: tab('inspector', 'annex') },
    { id: 'read-only', label: 'Read only: every action held with its reason', model: tab('readOnly', 'annex') },
    { id: 'read-only-risk', label: 'Read only: the risk assessment, nothing editable', model: tab('readOnly', 'risk') },
    { id: 'not-found', label: 'Not found (another company\'s, or gone)', model: { role: 'owner', state: 'problem', problem: 'problem.notFound' } },
    { id: 'forbidden', label: 'Sales: not for the role', model: { role: 'sales', state: 'problem', problem: 'problem.forbidden' } },
    { id: 'loading', label: 'Loading', model: { role: 'owner', state: 'loading' } },
    { id: 'error', label: "The API didn't answer", model: { role: 'owner', state: 'problem', problem: 'problem.unavailable' } },
  ],
})
