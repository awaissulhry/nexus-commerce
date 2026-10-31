import { createElement, useEffect, useState } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/view/RecordPanelsView'
import { STEP_UP_CLOSED, type StepUpState } from '../../_shared/hooks'
import { at, inShell, ME, NOW, PREFIX, ROLE_PERMISSIONS, uid, type RoleCase } from '../../_shared/fixtures'
import type { Decision, NcrRecord } from '../api'
import { DEFECTS, DISPOSITIONS, HOLD_REASONS, OPERATIONS, PEOPLE, RECORD, RECORD_CLOSED, RECORD_OPEN, RECORD_READY, ROWS, SITES, STOCK } from '../demo/fixtures'
import { checksSay, factsOfRecord, ncrCan, type RecordTab } from '../model'
import type { CloseDialogModel } from '../view/CloseNcrDialog'
import { choicesOf, draftOf, EMPTY_CARRY, EMPTY_HOLD, NEW_ACTION, NO_CHOICES, stockLinesOf, TIME_ZONE, type Loaded, type NcrRecordModel, type ProblemDraft, type RecordChoices, type RecordDialog } from './view-model'
import { NcrRecordView } from './view/NcrRecordView'

/**
 * SCR-145 — the NCR record (Quality › Nonconformances › an NCR) with made-up data only (NCR-DEMO-…, Demo people, made-up
 * quantities): each tab of a contained NCR, the Problem tab editing and read-only, a fresh NCR whose "Mark contained" is
 * held with what is missing, every dialog (an action with its hold, done with evidence, decide, carry out by stock lines,
 * the held SCRAP of garments still in work, the rework order, a repair, a supplier claim, link, close with the checklist
 * and the code), a closed and a cancelled NCR, refusals, the stale banner, the page's states and the role cases.
 */

type RoleKey = 'owner' | 'inspector' | 'production' | 'sales' | 'viewOnly' | 'noAccess'

interface RecordCase {
  readonly role: RoleKey
  readonly record: NcrRecordModel
  readonly panels: RecordPanelsViewModel | null
}

const templatePermissions = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']
const PERMISSIONS: Readonly<Record<RoleKey, readonly string[]>> = {
  owner: ROLE_PERMISSIONS.owner,
  inspector: templatePermissions('quality_inspector'),
  production: templatePermissions('production_manager'),
  sales: templatePermissions('sales'),
  viewOnly: ['home.view', 'quality.ncr.view', 'threads.read', 'files.read', 'workorders.view'],
  noAccess: ROLE_PERMISSIONS.readOnly,
}
const SHELL_ROLE: Readonly<Record<RoleKey, RoleCase>> = { owner: 'owner', inspector: 'inspector', production: 'production', sales: 'sales', viewOnly: 'readOnly', noAccess: 'readOnly' }
const PERSON_OF: Readonly<Partial<Record<RoleKey, string>>> = { inspector: uid('5201', 1), production: uid('5201', 2) }

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel

const CHOICES: RecordChoices = {
  ...NO_CHOICES,
  defects: choicesOf(DEFECTS),
  dispositions: choicesOf(DISPOSITIONS),
  holdReasons: choicesOf(HOLD_REASONS),
  claimReasons: choicesOf([
    { id: uid('5371', 1), code: 'THICKNESS', labelIt: 'Spessore fuori tolleranza', labelEn: 'Thickness out of tolerance', needsDetail: false },
    { id: uid('5371', 2), code: 'DEFECTS', labelIt: 'Difetti oltre il capitolato', labelEn: 'Defects beyond the agreed grade', needsDetail: true },
  ]),
  stock: choicesOf(STOCK),
  sites: choicesOf(SITES),
  operations: choicesOf(OPERATIONS),
  repairs: choicesOf([
    { id: uid('5390', 1), number: 'REP-DEMO-0004', stage: 'RECEIVED', serial: 'DEMO-SN-000412', problem: 'Zip pull missing on the front.' },
    { id: uid('5390', 2), number: 'REP-DEMO-0005', stage: 'AWAITING_GOODS', serial: null, problem: 'Pocket seam reported open by the customer.' },
  ]),
  claims: choicesOf([{ id: uid('5391', 1), number: 'CLM-DEMO-0003', status: 'DRAFT', kind: 'RETURN' }]),
}

const code = (index: number): NonNullable<Decision['disposition']> => {
  const found = DISPOSITIONS[index]!
  return { id: found.id, code: found.code, labelEn: found.labelEn, labelIt: found.labelIt, icon: null, colour: null, outcome: found.outcome, stockMoveReason: found.stockMoveReason, followUp: found.followUp, reinspection: found.reinspection, words: found.stockAction }
}
const open = (seq: number, disposition: number, quantity: string, over: Partial<Decision> = {}): Decision => ({
  id: uid('5335', seq),
  seq,
  disposition: code(disposition),
  quantity,
  note: null,
  decidedAt: at(29, 8, 0),
  decidedById: uid('5201', 1),
  approvalRequired: false,
  approvedAt: null,
  approvedById: null,
  state: 'TO_CARRY_OUT',
  mayApprove: false,
  doneAt: null,
  stockMove: null,
  followUp: null,
  version: 1,
  ...over,
})

/** A contained NCR whose whole quantity is decided and approved: Decided may be marked; closing waits for the carry-outs. */
const allDecided = (value: NcrRecord): NcrRecord => ({
  ...value,
  next: { stage: 'DECIDED', checks: [{ key: 'STAGE', ok: true, words: 'x' }, { key: 'ALL_DECIDED', ok: true, words: 'x' }, { key: 'APPROVED', ok: true, words: 'x' }], ready: true },
  closing: { checks: [{ key: 'ALL_DECIDED', ok: true, words: 'x' }, { key: 'APPROVED', ok: true, words: 'x' }, { key: 'CARRIED_OUT', ok: false, words: 'x' }, { key: 'HOLDS', ok: true, words: 'x' }], ready: false },
  actions: { ...value.actions, decide: null },
})

/** The supplier NCR of a leather lot: a SCRAP and a RETURN TO SUPPLIER to carry out. */
const LOT_NCR: NcrRecord = {
  ...RECORD,
  ncr: { ...RECORD.ncr, ...ROWS[1]!, stage: 'CONTAINED', containmentOverdue: false, description: 'Thickness measured at 0.9 mm on a 1.2 mm order.', foundBy: { kind: 'USER', userId: ME, workerId: null }, closedById: null, closeNote: null, closeSignatureSha256: null, cancelReason: null, createdById: ME, decided: { decided: '51.8', left: '0', words: 'x' } },
  containment: [{ ...RECORD.containment[0]!, hold: { id: uid('5311', 2), status: 'ACTIVE', subjectType: 'Lot', count: 1 } }],
  decisions: [open(1, 1, '12', { approvalRequired: true, approvedAt: at(29, 9, 0), approvedById: uid('5201', 2) }), open(2, 5, '39.8')],
  links: [{ id: uid('5341', 1), recordType: 'Lot', recordId: uid('5304', 2), label: 'Lot DEMO-LOT-0007', note: null, createdAt: at(26, 14, 5), createdById: ME }],
  holds: [{ id: uid('5311', 2), status: 'ACTIVE', subjectType: 'Lot', subjectIds: [uid('5304', 2)], reasonCode: 'SUSPECT', reasonNote: 'Thickness out of tolerance', placedAt: at(26, 15, 0), decidedHere: true }],
  register: null,
}
const LOT_RECORD: NcrRecord = allDecided({ ...LOT_NCR, ncr: { ...LOT_NCR.ncr, sourceType: 'Lot', sourceId: uid('5304', 2) } })

/** The garment NCR with its scrap approved: still the work in progress's, so its scrap cannot be posted here. */
const GARMENT_SCRAP: NcrRecord = allDecided({ ...RECORD, decisions: [RECORD.decisions[0]!, { ...RECORD.decisions[1]!, approvedAt: at(28, 15, 0), approvedById: uid('5201', 2), state: 'TO_CARRY_OUT', mayApprove: false, version: 2 }, open(3, 0, '12')], ncr: { ...RECORD.ncr, decided: { decided: '40', left: '0', words: 'x' } } })
const REPAIR_RECORD: NcrRecord = allDecided({ ...RECORD, decisions: [RECORD.decisions[0]!, open(4, 4, '3')], ncr: { ...RECORD.ncr, quantityAffected: '23', decided: { decided: '23', left: '0', words: 'x' } } })
const CANCELLED: NcrRecord = { ...RECORD_OPEN, ncr: { ...RECORD_OPEN.ncr, stage: 'CANCELLED', cancelledAt: at(29, 10, 0), cancelReason: 'Raised twice: the same bundle is NCR-DEMO-0031.' }, actions: { edit: 'x', contain: 'x', decide: 'x', close: 'x', cancel: 'x' }, next: { stage: null, checks: [], ready: false } }

const closeDialog = (note: string): CloseDialogModel => ({
  ncrId: RECORD_READY.ncr.id,
  number: RECORD_READY.ncr.number,
  checks: checksSay(RECORD_READY.closing.checks, { ...factsOfRecord(RECORD_READY), activeHolds: 1 }, 'CLOSED'),
  ready: true,
  note,
  busy: false,
  notice: null,
  readProblem: null,
  held: null,
})

function record(role: RoleKey, tab: RecordTab, value: NcrRecord | null, over: Partial<NcrRecordModel> = {}): RecordCase {
  const me = PERSON_OF[role] ?? ME
  const loaded: Loaded = value ? { status: 'ready', record: value } : { status: 'loading' }
  return {
    role,
    panels: tab === 'activity' && value ? { ...conversation, record: { type: 'Nonconformance', id: value.ncr.id, companyId: value.ncr.companyId, siteId: value.ncr.siteId }, title: `${value.ncr.number} · ${value.ncr.title}`, party: null } : null,
    record: {
      prefix: PREFIX,
      me,
      can: ncrCan(PERMISSIONS[role]),
      tab,
      loaded,
      timeZone: TIME_ZONE,
      now: NOW,
      live: 'live',
      asOf: NOW,
      people: PEOPLE.map((person) => ({ ...person, me: person.id === me })),
      site: { code: SITES[0]!.code, name: SITES[0]!.name },
      photos: { items: [{ id: uid('5360', 2), name: 'pocket-seam-left.jpg', contentType: 'image/jpeg' }], problem: null },
      uploading: 0,
      draft: null,
      saving: false,
      cells: {},
      choices: CHOICES,
      dialog: null,
      notice: null,
      stale: null,
      busy: false,
      close: null,
      stepUp: STEP_UP_CLOSED,
      ...over,
    },
  }
}

/** In the browser the drafts, dialogs and keys work for real (the wrapper keeps them); nothing is sent. */
function RecordDesign({ model }: { model: RecordCase }) {
  const [dialog, setDialog] = useState<RecordDialog | null>(model.record.dialog)
  const [draft, setDraft] = useState<ProblemDraft | null>(model.record.draft)
  const [keys, setKeys] = useState(!!model.record.keysOpen)
  const [close, setClose] = useState<CloseDialogModel | null>(model.record.close)
  const [stepUp, setStepUp] = useState<StepUpState>(model.record.stepUp)
  useEffect(() => {
    setDialog(model.record.dialog)
    setDraft(model.record.draft)
    setKeys(!!model.record.keysOpen)
    setClose(model.record.close)
    setStepUp(model.record.stepUp)
  }, [model])
  const value = model.record.loaded.status === 'ready' ? model.record.loaded.record : null
  const view = createElement(NcrRecordView, {
    model: { ...model.record, dialog, draft, keysOpen: keys, close, stepUp },
    panelsPreview: model.panels ?? undefined,
    actions: {
      onDialog: setDialog,
      onDraft: (patch) => value && setDraft((now) => ({ ...(now ?? draftOf(value.ncr, TIME_ZONE)), ...patch })),
      onDiscard: () => setDraft(null),
      onKeys: setKeys,
      onClose: () => value && setClose({ ...closeDialog(''), ncrId: value.ncr.id, number: value.ncr.number, checks: checksSay(value.closing.checks, factsOfRecord(value), 'CLOSED'), ready: value.closing.ready }),
      close: { onNote: (note) => setClose((now) => (now ? { ...now, note } : now)), onCancel: () => setClose(null), onSubmit: () => setStepUp({ open: true, busy: false, sentence: 'close.stepUp', problem: null }) },
      onStepUpCancel: () => setStepUp(STEP_UP_CLOSED),
    },
  })
  return inShell(`/quality/ncr/${value?.ncr.id ?? 'x'}`, view, SHELL_ROLE[model.role])
}

const carry = (decisionId: string, lines: ReturnType<typeof stockLinesOf>, over: Partial<typeof EMPTY_CARRY> = {}): RecordDialog => ({ kind: 'carryOut', decisionId, draft: { ...EMPTY_CARRY, lines, ...over }, busy: false, notice: null })

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-145',
  title: 'NCR record',
  view: RecordDesign,
  cases: [
    { id: 'problem', label: 'Problem & evidence: a contained NCR, its aside (Stepper, what Decided still needs, the countdown, the PPE register)', model: record('owner', 'problem', RECORD), note: 'The zone picker stands in for the design\'s GarmentZoneMap (new).' },
    { id: 'problem-editing', label: 'Problem & evidence editing: two changes, the EditModeBar (⌘S)', model: record('owner', 'problem', RECORD, { draft: { ...draftOf(RECORD.ncr, TIME_ZONE), title: 'Seam opens at the left armour pocket', quantitySuspect: '16' } }) },
    { id: 'problem-read-only', label: 'Problem & evidence after Decided: read-only, said why', model: record('owner', 'problem', RECORD_READY) },
    { id: 'containment', label: 'Containment: two actions done, a hold placed with the NCR', model: record('owner', 'containment', RECORD) },
    { id: 'disposition', label: 'Disposition: 28 of 40 decided; a rework carried out, a scrap waiting approval', model: record('owner', 'disposition', RECORD) },
    { id: 'linked', label: 'Linked records: source, holds, follow-ups, others, the PPE register entry', model: record('owner', 'linked', RECORD) },
    { id: 'activity', label: 'Activity: the record panels (thread, files, history)', model: record('owner', 'activity', RECORD) },
    { id: 'open-fresh', label: 'A fresh NCR: an open action, "Mark contained" held with what is missing', model: record('inspector', 'problem', RECORD_OPEN) },
    { id: 'open-containment', label: 'A fresh NCR: its open action with owner and due time to set (autosave per cell)', model: record('inspector', 'containment', RECORD_OPEN, { cells: { [`${RECORD_OPEN.containment[0]!.id}:due`]: { state: 'saved' } } }) },
    { id: 'add-action-hold', label: 'Add action: Hold stock, placing the hold here (what, why, note)', model: record('inspector', 'containment', RECORD_OPEN, { dialog: { kind: 'addAction', draft: { ...NEW_ACTION, kind: 'HOLD_STOCK', ownerId: uid('5201', 1), hold: { ...EMPTY_HOLD, subject: `WorkOrder:${RECORD_OPEN.ncr.workOrder!.id}`, reasonCode: 'NCR' } }, busy: false, notice: null } }) },
    { id: 'done-action', label: 'Mark an action done: the evidence (a note or a photo)', model: record('inspector', 'containment', RECORD_OPEN, { dialog: { kind: 'doneAction', actionId: RECORD_OPEN.containment[0]!.id, evidence: 'Both sleeves checked on the line: no more torn linings.', photoName: 'sleeve-check.jpg', hold: EMPTY_HOLD, busy: false, notice: null } }) },
    { id: 'decide', label: 'Decide by quantity: the code, what is left, the note', model: record('inspector', 'disposition', RECORD, { dialog: { kind: 'decide', draft: { dispositionCodeId: DISPOSITIONS[2]!.id, quantity: '12', note: 'Light marks only: second quality.' }, busy: false, notice: null } }) },
    { id: 'carry-scrap-lot', label: 'Carry out SCRAP of a leather lot: the stock lines from where it lies', model: record('owner', 'disposition', LOT_RECORD, { dialog: carry(LOT_RECORD.decisions[0]!.id, stockLinesOf(STOCK, '12')) }) },
    { id: 'carry-held-garments', label: 'SCRAP of garments still in work: Carry out held with the reason (B-W2a-47 gap)', model: record('owner', 'disposition', GARMENT_SCRAP), note: 'Never a fake success: scrap at the scan, or decide Rework and scrap there.' },
    { id: 'rework', label: 'Create rework order (QHS-091): the operation of the work order', model: record('production', 'disposition', GARMENT_SCRAP, { dialog: { kind: 'rework', decisionId: GARMENT_SCRAP.decisions[2]!.id, operationId: OPERATIONS[1]!.id, description: 'Re-sew the pocket seam.', busy: false, notice: null } }) },
    { id: 'carry-repair', label: 'Carry out a REPAIR: name its repair (Sales › Repairs)', model: record('owner', 'disposition', REPAIR_RECORD, { dialog: carry(REPAIR_RECORD.decisions[1]!.id, [], { followUpId: uid('5390', 1) }) }) },
    { id: 'carry-claim', label: 'Carry out RETURN TO SUPPLIER: the move to the returns place and a draft supplier claim', model: record('owner', 'disposition', LOT_RECORD, { dialog: carry(LOT_RECORD.decisions[1]!.id, stockLinesOf(STOCK, '39.8'), { toLocationId: SITES[0]!.locations[1]!.id, claimReason: 'THICKNESS', claimRemedy: 'CREDIT' }) }) },
    { id: 'carry-refused', label: 'A carry-out refused: our words, the factory\'s sentence under them', model: record('owner', 'disposition', LOT_RECORD, { dialog: { ...(carry(LOT_RECORD.decisions[0]!.id, stockLinesOf(STOCK, '10')) as Extract<RecordDialog, { kind: 'carryOut' }>), notice: { say: { key: 'problem.invalid' }, tone: 'danger', detail: ['The moves take 10.0000 FT2; the decision is 12.0000 FT2: move exactly that, or change the decision first.'] } } }) },
    { id: 'approve-own', label: 'Approve held for who decided it (four eyes)', model: record('inspector', 'disposition', RECORD) },
    { id: 'approve-production', label: 'Production manager: approves the scrap; cannot close (Close held)', model: record('production', 'disposition', RECORD) },
    { id: 'link', label: 'Link…: a record found by number, with a note', model: record('owner', 'linked', RECORD, { dialog: { kind: 'link', query: 'DEMO-LOT', hits: [{ recordType: 'Lot', recordId: uid('5304', 2), number: 'DEMO-LOT-0007', title: 'Demo cowhide 1.2 mm', subtitle: 'Demo Tannery' }, { recordType: 'Shipment', recordId: uid('5392', 1), number: 'SH-DEMO-0012', title: 'Demo Moto Srl', subtitle: null }], searching: false, picked: null, note: '', busy: false, notice: null } }) },
    { id: 'close', label: 'Close NCR: the checklist complete, the closing note typed', model: record('owner', 'problem', RECORD_READY, { close: closeDialog('Every garment reworked or scrapped; the line briefed.') }) },
    { id: 'close-step-up', label: 'Close NCR: the e-signature asks a fresh code', model: record('owner', 'problem', RECORD_READY, { close: { ...closeDialog('Every garment reworked or scrapped; the line briefed.'), busy: true }, stepUp: { open: true, busy: false, sentence: 'close.stepUp', problem: null } }), note: 'The DS step-up dialog; its own field words are still English (the open StepUpModal gap).' },
    { id: 'closed', label: 'Closed: read-only, who closed it and why', model: record('owner', 'problem', RECORD_CLOSED) },
    { id: 'cancelled', label: 'Cancelled: its reason', model: record('owner', 'problem', CANCELLED) },
    { id: 'cancel-dialog', label: 'Cancel NCR…: the reason', model: record('inspector', 'problem', RECORD_OPEN, { dialog: { kind: 'cancelNcr', reason: '', busy: false, notice: null } }) },
    { id: 'refused', label: 'A move refused: a check not met (our words)', model: record('owner', 'problem', RECORD, { notice: { say: { key: 'problem.checks' }, tone: 'danger' } }) },
    { id: 'stale', label: 'Changed meanwhile: the banner instead of reading under the person\'s hands', model: record('owner', 'disposition', RECORD, { stale: '10:42' }) },
    { id: 'offline', label: 'Offline: the last copy with its time', model: record('owner', 'problem', RECORD, { live: 'offline' }) },
    { id: 'sales', label: 'Sales: sees it and links records; follows nothing up (held with the reason)', model: record('sales', 'linked', RECORD) },
    { id: 'view-only', label: 'A role that only sees NCRs: every action held with its reason', model: record('viewOnly', 'disposition', RECORD) },
    { id: 'keys', label: 'The keys (?)', model: record('owner', 'problem', RECORD, { keysOpen: true }) },
    { id: 'loading', label: 'Loading', model: record('owner', 'problem', null, { asOf: null, live: 'connecting' }) },
    { id: 'error', label: "Couldn't be read (Try again)", model: record('owner', 'problem', null, { loaded: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'not-found', label: 'Not found', model: record('owner', 'problem', null, { loaded: { status: 'notFound' } }) },
    { id: 'no-permission', label: 'No permission (quality.ncr.view): which permission, who grants it', model: record('noAccess', 'problem', null, { loaded: { status: 'forbidden' } }) },
  ],
})
