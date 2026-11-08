import { createElement, useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { useT } from '../../../../lib/i18n/provider'
import { STEP_UP_CLOSED, type StepUpState } from '../../_shared/hooks'
import { failedRead, ready, reading } from '../../_shared/model'
import { at, canFor, inShell, ME, NOW, PREFIX, uid, type RoleCase } from '../../_shared/fixtures'
import { QualityMessages, RecordProblem, RecordSkeleton } from '../../_shared/parts'
import { ANSWERED, CANCELLED, FAILED, FAILING_BY_COUNTS, FAILING_HARD, FINAL, FINAL_SECOND, FINAL_SERIAL, INSPECTION, INSPECTORS, LIBRARY, PASSED, readOf, RELEASES } from '../demo/fixtures'
import { answer, changedLine, checklistRows, defectKey, defectLinesOf, planDraftOf, releaseDraftOf, signDraftOf, withPicked, type DefectsTabModel, type InspectionRecordModel, type RecordDialog, type RecordTab } from '../model'
import type { DefectBody, Inspection } from '../api'
import { InspectionRecordView } from './view/InspectionRecordView'
// B-W2b-127: the record's W2b parts (the plan's checks, Sample & AQL, Measurements, the photo set, Amendments, the gate).
import { ROLE_PERMISSIONS } from '../../_shared/fixtures'
import { AMENDMENTS, AMENDMENTS_MINE, AMENDMENTS_NONE, AQL, AQL_OPEN, AQL_W1, CAUSES, PLANNED, PLANNED_SIGNED, plannedRead, PROFILES, SHEET, SHEET_SIGNED } from '../depth/demo/fixtures'
import { AMEND_DRAFT, depthCan, draftFor, fieldKey } from '../depth/model'
import type { AmendmentsState } from '../depth/use-amendments'
import type { FinalDepthState } from '../depth/use-final-depth'

type Depth = NonNullable<InspectionRecordModel['depth']>

/** The record's W2b state for a design case: the role's rights, nothing read for W1 unless a case says so. */
const depthOf = (role: RoleCase, over: { final?: Partial<FinalDepthState>; amendments?: Partial<AmendmentsState>; chartFrom?: number } = {}): Depth => ({
  can: depthCan(ROLE_PERMISSIONS[role]),
  final: { sheet: null, aql: ready(AQL_W1), causes: ready(CAUSES), photoSrc: {}, unit: 1, marks: {}, profiles: null, profileDraft: null, profileBusy: false, profileProblem: null, ...over.final },
  amendments: { read: null, dialog: null, draft: AMEND_DRAFT, refuseReason: '', busy: false, problem: null, lines: [], done: null, ...over.amendments },
  chartFrom: over.chartFrom ?? 1,
})

/**
 * SCR-076 the inspection record — made-up data only. Each case is a state the Owner reviews: an open inspection being
 * recorded (answers saving per row, the result now with its rule in words), the sign dialog (as computed, an override
 * with its reason, the code), the held reasons (maker, not yours, unanswered), a passed one with the release per cell
 * (the gate in words; the second person and why; a serial cell; a refusal with the API's lines), failed and cancelled
 * ones, the plan, defects and cancel dialogs, the role cases and the read states. The wrapper keeps the answers and the
 * dialogs, so they work in the browser.
 */

type DesignModel =
  | { readonly kind: 'record'; readonly role: RoleCase; readonly model: InspectionRecordModel; readonly stepUp?: StepUpState }
  | { readonly kind: 'state'; readonly role: RoleCase; readonly state: 'loading' | 'notFound' | 'error' | 'forbidden' }

const record = (over: Partial<InspectionRecordModel> = {}, role: RoleCase = 'owner'): DesignModel => {
  const read = over.read ?? readOf(INSPECTION)
  return {
    kind: 'record',
    role,
    model: {
      prefix: PREFIX,
      me: ME,
      can: canFor(role),
      tab: 'checks',
      read,
      checklist: checklistRows(read.inspection),
      final: ready(FINAL),
      releases: ready(RELEASES),
      style: ready({ code: 'DEMO-JKT', name: 'Demo touring jacket' }),
      asOf: NOW,
      live: 'live',
      depth: depthOf(role),
      ...over,
    },
  }
}

/** The Defects & photos tab of an inspection (the library read, two photos of one line). */
const defectsOf = (lines: readonly DefectBody[], over: Partial<DefectsTabModel> = {}): DefectsTabModel => ({
  lines,
  saving: 'idle',
  library: ready(LIBRARY),
  photos: ready([{ id: 'photo-1', name: `defect-${lines[0]?.code ?? 'X'}-1.jpg`, createdAt: NOW }]),
  photoSrc: {},
  ...over,
})
const WITH_DEFECTS = withPicked(withPicked(defectLinesOf(INSPECTION), LIBRARY[1]!), LIBRARY[3]!)
const defectsCase = (over: Partial<DefectsTabModel> = {}, extra: Partial<InspectionRecordModel> = {}, role: RoleCase = 'owner') =>
  record({ tab: 'defects', defects: defectsOf(WITH_DEFECTS, over), ...extra }, role)

/** B-W2b-17: the inspection with the three lines saved (each with its id: they can be picked for an NCR). */
const SAVED_DEFECTS: Inspection = {
  ...INSPECTION,
  defects: WITH_DEFECTS.map((line, index) => ({ id: uid('7722', index + 1), defectClass: line.defectClass, code: line.code, defectCodeId: line.defectCodeId ?? null, zone: line.zone ?? null, description: null, quantity: line.quantity, workOrderSizeId: line.workOrderSizeId ?? null, note: line.note ?? null, causeCodeId: line.causeCodeId ?? null })),
}
const picksCase = (selected: readonly string[], role: RoleCase = 'owner') => record({ read: readOf(SAVED_DEFECTS), tab: 'defects', defects: defectsOf(WITH_DEFECTS, { selected }) }, role)

const passed = (over: Partial<InspectionRecordModel> = {}, role: RoleCase = 'owner') =>
  record({ read: readOf(PASSED, { workOrder: { id: PASSED.workOrderId, number: 'DEMO-WO-0142', status: 'COMPLETED', batchNumber: 'DEMO-BT-0142' } }), tab: 'decision', releases: ready([{ ...RELEASES[0]!, inspectionId: PASSED.id, number: 'DEMO-WO-0142' }]), ...over }, role)

function RecordDesign({ model: design }: { model: DesignModel }) {
  const initial = design.kind === 'record' ? design.model : null
  const [dialog, setDialog] = useState<RecordDialog | null>(initial?.dialog ?? null)
  const [checklist, setChecklist] = useState(initial?.checklist ?? [])
  const [drafts, setDrafts] = useState({ sign: initial?.signDraft, release: initial?.releaseDraft, plan: initial?.planDraft, cancel: initial?.cancelReason ?? '' })
  const [defects, setDefects] = useState(initial?.defects)
  const [assign, setAssign] = useState(initial?.assign ?? null)
  const [depth, setDepth] = useState(initial?.depth)
  useEffect(() => {
    setDepth(initial?.depth)
  }, [initial])
  useEffect(() => {
    setDialog(initial?.dialog ?? null)
    setChecklist(initial?.checklist ?? [])
    setDrafts({ sign: initial?.signDraft, release: initial?.releaseDraft, plan: initial?.planDraft, cancel: initial?.cancelReason ?? '' })
    setDefects(initial?.defects)
    setAssign(initial?.assign ?? null)
  }, [initial])
  let page: ReactNode
  if (design.kind === 'state') {
    const back = createElement(BackLink)
    page = createElement(
      QualityMessages,
      null,
      design.state === 'loading'
        ? createElement(RecordSkeleton)
        : createElement(RecordProblem, { problem: design.state === 'notFound' ? 'problem.notFound' : design.state === 'forbidden' ? 'problem.forbidden' : 'problem.unavailable', back, onRetry: () => undefined }),
    )
  } else {
    const inspection = design.model.read.inspection
    const model: InspectionRecordModel = {
      ...design.model,
      dialog,
      checklist,
      signDraft: drafts.sign ?? (dialog?.kind === 'sign' ? signDraftOf(inspection) : undefined),
      releaseDraft: drafts.release ?? (dialog?.kind === 'release' ? releaseDraftOf(FINAL.cells.find((cell) => cell.workOrderSizeId === dialog.workOrderSizeId) ?? FINAL.cells[1]!) : undefined),
      planDraft: drafts.plan ?? (dialog?.kind === 'plan' ? planDraftOf(inspection) : undefined),
      cancelReason: drafts.cancel,
      defects: defects ?? defectsOf(defectLinesOf(inspection)),
      assign,
      depth,
    }
    const amend = (change: Partial<AmendmentsState>) => setDepth((current) => (current ? { ...current, amendments: { ...current.amendments, ...change } } : current))
    const final = (change: Partial<FinalDepthState>) => setDepth((current) => (current ? { ...current, final: { ...current.final, ...change } } : current))
    page = createElement(InspectionRecordView, {
      model,
      stepUp: design.stepUp ?? STEP_UP_CLOSED,
      actions: {
        onDialog: setDialog,
        onAnswer: (code: string, change: { ok?: boolean | null; note?: string | null }) => setChecklist((rows) => answer(rows, code, change)),
        onSignDraft: (sign) => setDrafts((current) => ({ ...current, sign })),
        onReleaseDraft: (release) => setDrafts((current) => ({ ...current, release })),
        onPlanDraft: (plan) => setDrafts((current) => ({ ...current, plan })),
        onCancelReason: (cancel) => setDrafts((current) => ({ ...current, cancel })),
        onLines: (lines: readonly DefectBody[]) => setDefects((current) => ({ ...(current ?? defectsOf([])), lines: [...lines], saving: 'saved' })),
        onAssign: () => setAssign({ ids: [inspection.id], siteId: inspection.siteId, people: ready(INSPECTORS), value: '', busy: false, problem: null, lines: [] }),
        onAssignValue: (value: string) => setAssign((current) => (current ? { ...current, value } : current)),
        onAssignClose: () => setAssign(null),
        onPickDefects: (keys: readonly string[]) => setDefects((current) => ({ ...(current ?? defectsOf([])), selected: [...keys] })),
        depth: {
          onUnit: (unit: number) => final({ unit }),
          onChartPage: (chartFrom: number) => setDepth((current) => (current ? { ...current, chartFrom } : current)),
          onOpenProfile: () => final({ profileDraft: { profileId: null, reason: '' }, profiles: ready(PROFILES) }),
          onProfileDraft: (profileDraft) => final({ profileDraft }),
          onOpen: (next) => {
            const fields = depth?.amendments.read?.value?.fields.filter((field) => field.waiting === null) ?? []
            amend({ dialog: next, problem: null, lines: [], draft: next?.kind === 'amend' && fields[0] ? draftFor(fields[0]) : AMEND_DRAFT, refuseReason: '' })
          },
          onDraft: (draft) => amend({ draft }),
          onRefuseReason: (refuseReason: string) => amend({ refuseReason }),
          onDismiss: () => amend({ done: null, problem: null, lines: [] }),
        },
      },
    })
  }
  return inShell('/quality/inspections', page, design.role)
}

const tab = (value: RecordTab) => value

/** ‹ Inspections in the page's language (the record's problem states). */
function BackLink() {
  const t = useT('quality')
  return createElement(Link, { className: 'fw-q-link', href: `${PREFIX}/quality/inspections` }, t('record.back'))
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-076',
  title: 'Inspection record, release and reversal',
  view: RecordDesign,
  cases: [
    {
      id: 'open',
      label: 'Open: recording the checks (each answer saves on its own)',
      model: record({ saving: { CE_MARK: 'saved', CARE_LABEL: 'saving' } }),
      note: 'OK / Not OK / N/A per check; a Not OK asks what is wrong. "Result now" says the rule in words.',
    },
    { id: 'open-ready', label: 'Every check answered: Sign result is free (s)', model: record({ read: readOf(ANSWERED), checklist: checklistRows(ANSWERED) }) },
    { id: 'sign', label: 'Sign result: as computed (a fresh code follows)', model: record({ read: readOf(ANSWERED), checklist: checklistRows(ANSWERED), dialog: { kind: 'sign' } }) },
    {
      id: 'sign-override',
      label: 'Sign result: a pass over a fail by the acceptance numbers alone (override + reason)',
      model: record({ read: readOf(FAILING_BY_COUNTS), checklist: checklistRows(FAILING_BY_COUNTS), dialog: { kind: 'sign' }, signDraft: { result: 'PASS', overrideReason: '', statement: false, note: '' } }),
      note: 'Its release will need a second person.',
    },
    { id: 'sign-never', label: 'Sign result: never a pass over a check not OK', model: record({ read: readOf(FAILING_HARD), checklist: checklistRows(FAILING_HARD), dialog: { kind: 'sign' } }) },
    { id: 'sign-step-up', label: 'Sign result: the fresh code (step-up)', model: { ...record({ read: readOf(ANSWERED), checklist: checklistRows(ANSWERED), dialog: { kind: 'sign' }, busy: true }), stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.sign', problem: null } } as DesignModel },
    { id: 'sign-wrong-code', label: 'Sign result: a code that was not accepted', model: { ...record({ read: readOf(ANSWERED), checklist: checklistRows(ANSWERED), dialog: { kind: 'sign' }, busy: true }), stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.sign', problem: 'stepUp.problem.wrong' } } as DesignModel },
    { id: 'sign-statement', label: 'A station-only site: the signer states they made none of the garments', model: record({ read: readOf(ANSWERED, { statementNeeded: true }), checklist: checklistRows(ANSWERED), dialog: { kind: 'sign' } }) },
    { id: 'held-maker', label: 'Held: you made some of these garments (another inspector signs)', model: record({ read: readOf(ANSWERED, { maker: { made: true, words: 'x' } }), checklist: checklistRows(ANSWERED) }) },
    { id: 'held-not-yours', label: "Held: another inspector's inspection (opened at the bench)", model: record({ read: readOf({ ...ANSWERED, inspector: { kind: 'FLOOR', workerId: 'w', userId: null } }, { yours: false }), checklist: checklistRows(ANSWERED) }) },
    { id: 'passed', label: 'Passed: who signed, the release per colour and size, this inspection’s releases', model: passed() },
    { id: 'release', label: 'Release BLK 52: every check done, you may release alone', model: passed({ dialog: { kind: 'release', workOrderSizeId: FINAL.cells[1]!.workOrderSizeId } }) },
    { id: 'release-gate-open', label: 'Release BLK 54: the gate in words, held with the first open check', model: passed({ dialog: { kind: 'release', workOrderSizeId: FINAL.cells[2]!.workOrderSizeId }, releaseDraft: releaseDraftOf(FINAL.cells[2]!) }) },
    { id: 'release-second-person', label: 'Release: a listed customer needs a second person (you signed the result)', model: passed({ final: ready(FINAL_SECOND), dialog: { kind: 'release', workOrderSizeId: FINAL_SECOND.cells[1]!.workOrderSizeId }, releaseDraft: releaseDraftOf(FINAL_SECOND.cells[1]!) }) },
    { id: 'release-serial', label: 'Release a serial-tracked cell: tick the serials', model: passed({ final: ready(FINAL_SERIAL), dialog: { kind: 'release', workOrderSizeId: FINAL_SERIAL.cells[0]!.workOrderSizeId }, releaseDraft: releaseDraftOf(FINAL_SERIAL.cells[0]!) }) },
    {
      id: 'release-refused',
      label: 'Release refused by the gate (every open check, the API’s sentences)',
      model: passed({
        dialog: { kind: 'release', workOrderSizeId: FINAL.cells[1]!.workOrderSizeId },
        dialogProblem: 'release.problem.gate',
        dialogLines: ['Certificate: Not covered: certificate CERT-DEMO-0001 was suspended today. → Ask the notified body, or make the order without this size.'],
      }),
    },
    { id: 'release-step-up', label: 'Release: the fresh code (step-up)', model: { ...passed({ dialog: { kind: 'release', workOrderSizeId: FINAL.cells[1]!.workOrderSizeId }, busy: true }), stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.release', problem: null } } as DesignModel },
    { id: 'released', label: 'A receipt: released, packing allowed', model: passed({ notice: { key: 'release.done', tone: 'success', params: { count: 8, number: 'DEMO-REL-0006' } } }) },
    { id: 'failed', label: 'Failed: nothing released, the garments on hold', model: record({ read: readOf(FAILED, { yours: false }), checklist: checklistRows(FAILED), tab: tab('decision') }) },
    { id: 'failed-checks', label: 'Failed: the checks as signed (read only)', model: record({ read: readOf(FAILED, { yours: false }), checklist: checklistRows(FAILED) }) },
    { id: 'cancelled', label: 'Cancelled', model: record({ read: readOf(CANCELLED), checklist: checklistRows(CANCELLED) }) },
    { id: 'plan', label: 'The sampling plan dialog', model: record({ dialog: { kind: 'plan' } }) },
    // W2a (B-W2a-67): Defects & photos, Assign inspector, the decision as Accept · Conditional · Reject.
    { id: 'defects-tab', label: 'Defects & photos: the library’s codes, severity, zone, garments, size, photo, note', model: defectsCase(), note: 'Saved after each change; a line names a code once per class.' },
    { id: 'defects-saving', label: 'Defects: a change saving', model: defectsCase({ saving: 'saving' }) },
    { id: 'defects-refused', label: 'Defects: refused by the API (its words under ours)', model: defectsCase({ saving: 'failed', problem: 'defects.problem.refused', lines_refused: ['At most the sample (5).'] }) },
    { id: 'defects-pick', label: 'Add defect: pick from the library (grouped, searchable)', model: defectsCase({}, { dialog: { kind: 'pick' } }) },
    { id: 'defects-zone', label: 'Where on the garment: the GarmentZoneMap (or the list)', model: defectsCase({}, { dialog: { kind: 'zone', index: 1 } }) },
    { id: 'defects-photo', label: 'A photo with markup (camera or a file; arrows and circles)', model: defectsCase({}, { dialog: { kind: 'photo', index: 0 } }) },
    { id: 'defects-empty', label: 'No defect recorded yet', model: record({ tab: 'defects', defects: defectsOf([], { photos: ready([]) }) }) },
    { id: 'defects-library-failed', label: 'The library could not be read (the list still shows)', model: defectsCase({ library: failedRead('problem.unavailable') }, { dialog: { kind: 'pick' } }) },
    { id: 'defects-signed', label: 'A signed inspection: its defects read only', model: record({ read: readOf(FAILED, { yours: false }), checklist: checklistRows(FAILED), tab: 'defects', defects: defectsOf(changedLine(WITH_DEFECTS, 0, { quantity: 2 })) }) },
    // ---- B-W2b-17: due in the band; "Create NCR from N defects" (design ins-defects) ----
    { id: 'w2b-due', label: 'W2b Due in the band: by when the open inspection is due', model: record() },
    { id: 'w2b-due-overdue', label: 'W2b Overdue in the band: said in words and in the danger tone', model: record({ read: readOf({ ...INSPECTION, dueAt: at(28, 16, 0), overdue: true }) }) },
    { id: 'w2b-defects-picked', label: 'W2b Defects: 2 lines picked — "Create NCR from 2 defects" (New NCR takes only them)', model: picksCase(WITH_DEFECTS.slice(1, 3).map((line) => defectKey(line))), note: 'The NCR prefill reads only the picked lines: their worst class, the lead defect, their zone and garments.' },
    { id: 'w2b-defects-none', label: 'W2b Defects: nothing picked — the head "Create NCR…" takes every line', model: picksCase([]) },
    { id: 'w2b-defects-unsaved', label: 'W2b Defects: a line not saved yet cannot be picked (its box says why)', model: record({ tab: 'defects', defects: defectsOf(WITH_DEFECTS, { selected: [defectKey(WITH_DEFECTS[0]!)] }) }) },
    { id: 'w2b-defects-no-ncr', label: 'W2b Defects picked by a reader who raises no NCR: held with the reason', model: picksCase(WITH_DEFECTS.slice(1, 3).map((line) => defectKey(line)), 'readOnly') },
    { id: 'assign', label: 'Assign inspector from the band (a maker held with the reason)', model: record({ assign: { ids: [INSPECTION.id], siteId: INSPECTION.siteId, people: ready(INSPECTORS), value: `USER:${INSPECTORS.inspectors[1]!.id}`, busy: false, problem: null, lines: [] } }) },
    { id: 'held-assigned', label: 'Held: assigned to another inspector (they record and sign it)', model: record({ read: readOf({ ...ANSWERED, assigned: { kind: 'USER', userId: 'someone', workerId: null, name: 'Demo Inspector Two' } }, { yours: false }), checklist: checklistRows(ANSWERED) }) },
    { id: 'sign-conditional', label: 'Sign result: Conditional — accepted against a fail by counts, a second person releases', model: record({ read: readOf(FAILING_BY_COUNTS), checklist: checklistRows(FAILING_BY_COUNTS), dialog: { kind: 'sign' }, signDraft: { result: 'PASS', overrideReason: 'Customer concession DEMO-CC-01 in writing.', statement: false, note: '' } }) },
    { id: 'cancel', label: 'Cancel the inspection (a reason)', model: record({ dialog: { kind: 'cancel' } }) },
    { id: 'stale', label: 'Changed by someone else while a dialog is open: Reload', model: record({ stale: '10:42', dialog: null }) },
    { id: 'inspector', label: 'Quality inspector: the same record', model: record({}, 'inspector') },
    { id: 'production', label: 'Production manager: sees, records nothing (held with the reason)', model: passed({}, 'production') },
    { id: 'read-only', label: 'Read-only: sees, every action held', model: record({}, 'readOnly') },
    { id: 'no-permission', label: 'Sales: no permission', model: { kind: 'state', role: 'sales', state: 'forbidden' } },
    { id: 'loading', label: 'Loading', model: { kind: 'state', role: 'owner', state: 'loading' } },
    { id: 'not-found', label: 'Not found (or another company’s)', model: { kind: 'state', role: 'owner', state: 'notFound' } },
    { id: 'error', label: "The API didn't answer", model: { kind: 'state', role: 'owner', state: 'error' } },
    { id: 'release-state-failed', label: 'The release state could not be read (the rest works)', model: passed({ final: failedRead('problem.unavailable') }) },
    { id: 'release-state-loading', label: 'The release state still reading', model: passed({ final: reading() }) },
    // ---- B-W2b-127: Inspections in depth (design rec:Inspection W2b parts, pop:ins-amend, the gate) ----
    { id: 'w2b127-plan-checks', label: 'W2b-127 On a plan: the plan version’s checks for unit 1 (Pass / Fail / Not applicable, 1 2 3 on a row), the serial and batch check, the result in words', model: record({ read: plannedRead(), depth: depthOf('owner', { final: { sheet: ready(SHEET) } }) }), note: 'A failed check asks its note first; a critical "not applicable" asks the reason. A measurement is answered on the chart, a photo at the bench.' },
    { id: 'w2b127-plan-unit2', label: 'W2b-127 On a plan, unit 2: the zip failed with its note; a value saving, another refused', model: record({ read: plannedRead(), depth: depthOf('owner', { final: { sheet: ready(SHEET), unit: 2, marks: { 'check:ZIP': { state: 'saving' }, 'check:ARMOUR': { state: 'refused', problem: 'checks.problem.conflict' } } } }) }) },
    { id: 'w2b127-plan-read-only', label: 'W2b-127 On a plan, production manager: read only (held with the reason)', model: record({ read: plannedRead(), depth: depthOf('production', { final: { sheet: ready(SHEET) } }) }, 'production') },
    { id: 'w2b127-plan-reading', label: 'W2b-127 On a plan: the sheet still reading', model: record({ read: plannedRead(), depth: depthOf('owner', { final: { sheet: reading() } }) }) },
    { id: 'w2b127-plan-failed', label: 'W2b-127 On a plan: the sheet could not be read (Try again)', model: record({ read: plannedRead(), depth: depthOf('owner', { final: { sheet: failedRead('problem.unavailable') } }) }) },
    { id: 'w2b127-aql', label: 'W2b-127 Sample & AQL: the derivation (AqlSummary), the result now per class in words, 3 of 5 inspected, the profile and where it comes from', model: record({ read: plannedRead(), tab: 'aql', depth: depthOf('owner', { final: { sheet: ready(SHEET), aql: ready(AQL) } }) }), note: 'Read only: the counts come from the bench. Change profile is held once counting starts.' },
    { id: 'w2b127-aql-change', label: 'W2b-127 Sample & AQL › Change profile (before counting): the chain’s profile, or another with the reason', model: record({ read: plannedRead(), tab: 'aql', depth: depthOf('owner', { final: { sheet: ready(SHEET), aql: ready(AQL_OPEN), profiles: ready(PROFILES), profileDraft: { profileId: PROFILES[2]!.id, reason: '' } } }) }) },
    { id: 'w2b127-aql-w1', label: 'W2b-127 Sample & AQL of a W1 inspection: its typed plan', model: record({ tab: 'aql', depth: depthOf('owner', { final: { aql: ready(AQL_W1) } }) }) },
    { id: 'w2b127-aql-error', label: 'W2b-127 Sample & AQL could not be read', model: record({ read: plannedRead(), tab: 'aql', depth: depthOf('owner', { final: { aql: failedRead('problem.unavailable') } }) }) },
    { id: 'w2b127-measurements', label: 'W2b-127 Measurements: points down, units across; values with "over by 0.8 cm" (never colour alone); Create defect on the out-of-tolerance value', model: record({ read: plannedRead(), tab: 'measurements', depth: depthOf('owner', { final: { sheet: ready(SHEET), marks: { 'cell:CHEST:52:3': { state: 'refused', problem: 'chart.problem.decimal' } } } }) }) },
    { id: 'w2b127-measurements-signed', label: 'W2b-127 Measurements of a signed inspection: read only', model: record({ read: plannedRead(PLANNED_SIGNED), tab: 'measurements', depth: depthOf('owner', { final: { sheet: ready(SHEET_SIGNED) } }) }) },
    { id: 'w2b127-measurements-none', label: 'W2b-127 Measurements: this plan takes none', model: record({ read: plannedRead(), tab: 'measurements', depth: depthOf('owner', { final: { sheet: ready({ ...SHEET, chart: { ...SHEET.chart, points: [], values: 0, outOfTolerance: 0 } }) } }) }) },
    { id: 'w2b127-measurements-w1', label: 'W2b-127 Measurements of a W1 inspection: none (they come with a plan)', model: record({ tab: 'measurements' }) },
    { id: 'w2b127-defects', label: 'W2b-127 Defects & photos: the Cause column (the group’s cause codes) and the required photo set (Front ✓ · Label missing, holds Sign result)', model: record({ read: plannedRead({ ...PLANNED, defects: SAVED_DEFECTS.defects.map((defect, index) => ({ ...defect, causeCodeId: index === 0 ? CAUSES[0]!.id : null })) }), tab: 'defects', defects: defectsOf(WITH_DEFECTS.map((line, index) => ({ ...line, causeCodeId: index === 0 ? CAUSES[0]!.id : null }))), depth: depthOf('owner', { final: { sheet: ready(SHEET) } }) }) },
    { id: 'w2b127-amendments', label: 'W2b-127 Decision › Amendments: A1 countersigned, one waiting with its sign-off (asked by Marta Demo; you countersign)', model: passed({ depth: depthOf('owner', { amendments: { read: ready(AMENDMENTS) } }) }) },
    { id: 'w2b127-amend-dialog', label: 'W2b-127 Amend signed result: the field, the new value, the reason, before → after, who signs second', model: passed({ depth: depthOf('owner', { amendments: { read: ready(AMENDMENTS), dialog: { kind: 'amend' }, draft: { ...draftFor(AMENDMENTS.fields[3]!), value: '58.6', reason: '' } } }) }) },
    { id: 'w2b127-amend-refused', label: 'W2b-127 Amend refused: the correction would change a verdict (reverse and inspect again)', model: passed({ depth: depthOf('owner', { amendments: { read: ready(AMENDMENTS), dialog: { kind: 'amend' }, draft: { field: fieldKey(AMENDMENTS.fields[3]!), value: '59.8', reason: 'Read wrong at the bench.' }, problem: 'amend.refusal.VERDICT', lines: ['59.8 against 58 ± 1 cm would turn a pass into a fail.'] } }) }) },
    { id: 'w2b127-amend-mine', label: 'W2b-127 A correction I asked: the countersign is held (another person signs)', model: passed({ depth: depthOf('owner', { amendments: { read: ready(AMENDMENTS_MINE) } }) }) },
    { id: 'w2b127-refuse', label: 'W2b-127 Refuse a correction: the reason; no code (a refusal changes nothing)', model: passed({ depth: depthOf('owner', { amendments: { read: ready(AMENDMENTS), dialog: { kind: 'refuse', amendmentId: AMENDMENTS.corrections[1]!.id }, refuseReason: 'The note belongs on the NCR.' } }) }) },
    { id: 'w2b127-countersign-code', label: 'W2b-127 Countersign: the fresh 6-digit code', model: { ...passed({ depth: depthOf('owner', { amendments: { read: ready(AMENDMENTS), busy: true } }) }), stepUp: { open: true, busy: false, sentence: 'depth:amend.stepUp', problem: null } } as DesignModel },
    { id: 'w2b127-amend-none', label: 'W2b-127 Amendments: none yet (Amend signed result open)', model: passed({ depth: depthOf('owner', { amendments: { read: ready(AMENDMENTS_NONE), done: 'amend.done.refused' } }) }) },
    { id: 'w2b127-amend-read-only', label: 'W2b-127 Amendments for read-only: seen, asking held with the reason', model: passed({ depth: depthOf('readOnly', { amendments: { read: ready({ ...AMENDMENTS, may: { request: false, sign: false } }) } }) }, 'readOnly') },
    { id: 'w2b127-amendments-failed', label: 'W2b-127 Amendments could not be read', model: passed({ depth: depthOf('owner', { amendments: { read: failedRead('problem.unavailable') } }) }) },
    { id: 'w2b127-gate', label: 'W2b-127 Release gate: each cell’s gate opens in words (GateExplainer: what is open, who can clear it)', model: passed({ depth: depthOf('owner', { amendments: { read: ready(AMENDMENTS_NONE) } }) }), note: 'Press "2 checks open" on BLK 54.' },
    { id: 'w2b127-signed-plan', label: 'W2b-127 A signed inspection on a plan: Amended pill, the report and its share link in ⋯ (new tabs)', model: record({ read: plannedRead(PLANNED_SIGNED), depth: depthOf('owner', { final: { sheet: ready(SHEET_SIGNED) }, amendments: { read: ready(AMENDMENTS) } }) }) },
  ],
})
