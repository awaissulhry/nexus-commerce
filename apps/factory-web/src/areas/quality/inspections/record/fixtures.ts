import { createElement, useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { useT } from '../../../../lib/i18n/provider'
import { STEP_UP_CLOSED, type StepUpState } from '../../_shared/hooks'
import { failedRead, ready, reading } from '../../_shared/model'
import { canFor, inShell, ME, NOW, PREFIX, type RoleCase } from '../../_shared/fixtures'
import { QualityMessages, RecordProblem, RecordSkeleton } from '../../_shared/parts'
import { ANSWERED, CANCELLED, FAILED, FAILING_BY_COUNTS, FAILING_HARD, FINAL, FINAL_SECOND, FINAL_SERIAL, INSPECTION, PASSED, readOf, RELEASES } from '../demo/fixtures'
import { answer, checklistRows, defectsDraftOf, planDraftOf, releaseDraftOf, signDraftOf, type InspectionRecordModel, type RecordDialog, type RecordTab } from '../model'
import { InspectionRecordView } from './view/InspectionRecordView'

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
      ...over,
    },
  }
}

const passed = (over: Partial<InspectionRecordModel> = {}, role: RoleCase = 'owner') =>
  record({ read: readOf(PASSED, { workOrder: { id: PASSED.workOrderId, number: 'DEMO-WO-0142', status: 'COMPLETED', batchNumber: 'DEMO-BT-0142' } }), tab: 'decision', releases: ready([{ ...RELEASES[0]!, inspectionId: PASSED.id, number: 'DEMO-WO-0142' }]), ...over }, role)

function RecordDesign({ model: design }: { model: DesignModel }) {
  const initial = design.kind === 'record' ? design.model : null
  const [dialog, setDialog] = useState<RecordDialog | null>(initial?.dialog ?? null)
  const [checklist, setChecklist] = useState(initial?.checklist ?? [])
  const [drafts, setDrafts] = useState({ sign: initial?.signDraft, release: initial?.releaseDraft, plan: initial?.planDraft, defects: initial?.defectsDraft, cancel: initial?.cancelReason ?? '' })
  useEffect(() => {
    setDialog(initial?.dialog ?? null)
    setChecklist(initial?.checklist ?? [])
    setDrafts({ sign: initial?.signDraft, release: initial?.releaseDraft, plan: initial?.planDraft, defects: initial?.defectsDraft, cancel: initial?.cancelReason ?? '' })
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
      defectsDraft: drafts.defects ?? (dialog?.kind === 'defects' ? defectsDraftOf(inspection) : undefined),
      cancelReason: drafts.cancel,
    }
    page = createElement(InspectionRecordView, {
      model,
      stepUp: design.stepUp ?? STEP_UP_CLOSED,
      actions: {
        onDialog: setDialog,
        onAnswer: (code: string, change: { ok?: boolean | null; note?: string | null }) => setChecklist((rows) => answer(rows, code, change)),
        onSignDraft: (sign) => setDrafts((current) => ({ ...current, sign })),
        onReleaseDraft: (release) => setDrafts((current) => ({ ...current, release })),
        onPlanDraft: (plan) => setDrafts((current) => ({ ...current, plan })),
        onDefectsDraft: (defects) => setDrafts((current) => ({ ...current, defects })),
        onCancelReason: (cancel) => setDrafts((current) => ({ ...current, cancel })),
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
    { id: 'defects', label: 'The defects dialog (one line per class and code)', model: record({ dialog: { kind: 'defects' } }) },
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
  ],
})
