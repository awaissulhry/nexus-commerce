import { createElement, Fragment, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { STEP_UP_CLOSED, type StepUpState } from '../_shared/hooks'
import { failedRead, ready, reading } from '../_shared/model'
import { at, canFor, inShell, ME, NOW, PREFIX, uid, type RoleCase } from '../_shared/fixtures'
import { INSPECTORS, LOTS, RELEASE_DETAIL, RELEASES, RETURN_RECORD, RETURNS, ROWS, RULE, SERIAL_DETAIL, SHIPPED_DETAIL, WO_CELLS, WORK_ORDERS } from './demo/fixtures'
import { NEW_DRAFT, RETURN_DRAFT, ruleDraftOf, REVERSE_DRAFT, type AssignState, type DueState, type InspectionsListModel, type ListDialog, type NewDraft, type ReturnDraft, type View } from './model'
import { InspectionsView } from './view/InspectionsView'
// B-W2b-127: incoming and in-line rows in the one list, Amended results, Print N reports, New inspection's In-line and plan.
import { AMENDED_ROWS, DEPTH_ROWS, INCOMING_ROWS, INLINE_ROWS, PLANS, PLANS_NONE } from './depth/demo/fixtures'
import { depthCan, rowKey, type KindFilter } from './depth/model'
import { ROLE_PERMISSIONS } from '../_shared/fixtures'

/**
 * SCR-075 Inspections — made-up data only (DEMO-WO-…, DEMO-INS-…, DEMO-REL-…, DEMO-LOT-…, Demo customers). Each case is a
 * state the Owner reviews: the list with its tiles and the release rule at rest, each tile pressed (the reversed releases
 * and the lots on hold are their own lists), a release in its DetailModal on each tab, Reverse with its impact, New
 * inspection, the quality rules (loosening asks a reason, then a code), the role cases, and every state of a list. In the
 * browser the ticks, the views, the dialogs and the drafts work for real (the wrapper keeps them).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: InspectionsListModel
  readonly stepUp?: StepUpState
}

const counts = { open: { count: 3, capped: false }, overdue: { count: 1, capped: false }, waiting: { count: 2, capped: false }, failed: { count: 1, capped: false }, reversed: { count: 2, capped: false }, lots: { count: 3, capped: false } }

const list = (over: Partial<InspectionsListModel> = {}, role: RoleCase = 'owner'): DesignModel => ({
  role,
  model: {
    prefix: PREFIX,
    me: ME,
    companyName: 'Officina Demo S.r.l.',
    can: canFor(role),
    view: 'all',
    rows: ready(ROWS),
    releases: ready(RELEASES),
    lots: ready(LOTS),
    limit: 50,
    tiles: counts,
    rule: ready(RULE),
    asOf: NOW,
    live: 'live',
    updates: 0,
    selected: [],
    kind: 'all',
    depth: depthCan(ROLE_PERMISSIONS[role]),
    incoming: ready(INCOMING_ROWS),
    inline: ready(INLINE_ROWS),
    ...over,
  },
})

/** A final row's key in the one list (the frame selects by kind and id). */
const fk = (id: string): string => rowKey('FINAL', id)

const viewRows = (view: View) =>
  view === 'open'
    ? ROWS.filter((row) => row.status === 'OPEN')
    : view === 'waiting'
      ? ROWS.filter((row) => row.toRelease > 0 && !row.onHold)
      : view === 'failed'
        ? ROWS.filter((row) => row.undecided)
        : view === 'mine'
          ? ROWS.filter((row) => row.assigned?.userId === ME)
          : view === 'overdue'
            ? ROWS.filter((row) => row.overdue)
            : view === 'amended'
              ? AMENDED_ROWS
              : ROWS

const OPEN_ROWS = ROWS.filter((row) => row.status === 'OPEN')
const dueState = (over: Partial<DueState> = {}): DueState => ({ ids: OPEN_ROWS.slice(0, 2).map((row) => row.id), value: at(31, 16, 0), busy: false, problem: null, lines: [], ...over })
const assignState = (over: Partial<AssignState> = {}): AssignState => ({ ids: [OPEN_ROWS[1]!.id], siteId: OPEN_ROWS[1]!.siteId, people: ready(INSPECTORS), value: '', busy: false, problem: null, lines: [], ...over })
const returnNew = (draft: Partial<NewDraft>, returnDraft: ReturnDraft = RETURN_DRAFT, record = false) =>
  list({ dialog: { kind: 'new' }, pick: { workOrders: ready(WORK_ORDERS), cells: null }, newDraft: { ...NEW_DRAFT, ...draft }, returns: ready(RETURNS), returnRecord: record ? ready(RETURN_RECORD) : null, returnDraft })
function InspectionsDesign({ model: design }: { model: DesignModel }) {
  const [view, setView] = useState<View>(design.model.view)
  const [selected, setSelected] = useState<readonly string[]>(design.model.selected)
  const [dialog, setDialog] = useState<ListDialog | null>(design.model.dialog ?? null)
  const [open, setOpen] = useState(design.model.open ?? null)
  const [newDraft, setNewDraft] = useState(design.model.newDraft ?? NEW_DRAFT)
  const [ruleDraft, setRuleDraft] = useState(design.model.ruleDraft)
  const [reverseDraft, setReverseDraft] = useState(design.model.reverseDraft ?? REVERSE_DRAFT)
  const [assign, setAssign] = useState(design.model.assign ?? null)
  const [returnDraft, setReturnDraft] = useState(design.model.returnDraft ?? RETURN_DRAFT)
  const [due, setDue] = useState(design.model.due ?? null)
  const [kind, setKind] = useState<KindFilter>(design.model.kind ?? 'all')
  useEffect(() => {
    setDue(design.model.due ?? null)
    setAssign(design.model.assign ?? null)
    setNewDraft(design.model.newDraft ?? NEW_DRAFT)
    setReturnDraft(design.model.returnDraft ?? RETURN_DRAFT)
  }, [design])
  useEffect(() => {
    setView(design.model.view)
    setKind(design.model.kind ?? 'all')
    setSelected(design.model.selected)
    setDialog(design.model.dialog ?? null)
    setOpen(design.model.open ?? null)
  }, [design])
  const model: InspectionsListModel = {
    ...design.model,
    view,
    // A kind chip other than Final reads no final row (the container does the same).
    rows: kind !== 'all' && kind !== 'FINAL' && design.model.rows.value ? ready([]) : design.model.rows.value && view !== design.model.view ? ready(viewRows(view)) : design.model.rows,
    selected,
    dialog,
    open,
    newDraft,
    ruleDraft: ruleDraft ?? (dialog?.kind === 'rules' && design.model.rule.value ? ruleDraftOf(design.model.rule.value) : undefined),
    reverseDraft,
    assign,
    returnDraft,
    due,
    kind,
    // The other kinds join only Every inspection and Open (the container reads them for those views only).
    incoming: view === 'all' || view === 'open' ? (kind === 'all' || kind === 'INCOMING' ? (design.model.incoming ?? null) : null) : null,
    inline: view === 'all' || view === 'open' ? (kind === 'all' || kind === 'INLINE' ? (design.model.inline ?? null) : null) : null,
  }
  return inShell(
    '/quality/inspections',
    createElement(
      Fragment,
      null,
      createElement(InspectionsView, {
      model,
      stepUp: design.stepUp ?? STEP_UP_CLOSED,
      actions: {
        onView: (next: View) => {
          setView(next)
          setSelected([])
        },
        onSelect: (ids: readonly string[]) => setSelected([...ids]),
        onDialog: setDialog,
        onOpenRelease: (id: string | null) => setOpen(id ? { id, detail: ready(id === SERIAL_DETAIL.release.id ? SERIAL_DETAIL : RELEASE_DETAIL) } : null),
        onNewDraft: setNewDraft,
        onPickWorkOrder: (id: string) => setNewDraft((draft) => ({ ...draft, workOrderId: id })),
        onRuleDraft: setRuleDraft,
        onReverseDraft: setReverseDraft,
        onAssign: (rows: readonly { id: string; siteId: string }[]) => setAssign(assignState({ ids: rows.map((row) => row.id) })),
        onAssignValue: (value: string) => setAssign((current) => (current ? { ...current, value } : current)),
        onAssignClose: () => setAssign(null),
        onReturnDraft: setReturnDraft,
        onDue: (rows: readonly { id: string }[]) => setDue(dueState({ ids: rows.map((row) => row.id) })),
        onDueValue: (value: string) => setDue((current) => (current ? { ...current, value } : current)),
        onDueClose: () => setDue(null),
        onKind: (next: KindFilter) => {
          setKind(next)
          setSelected([])
        },
      },
      }),
    ),
    design.role,
  )
}

const openRelease = (detail = RELEASE_DETAIL, tab?: 'release' | 'gate' | 'reversal') => ({ id: detail.release.id, detail: ready(detail), ...(tab ? { tab } : {}) })

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-075',
  title: 'Inspections',
  view: InspectionsDesign,
  cases: [
    { id: 'list', label: 'Owner: every inspection, the tiles, the release rule at rest', model: list(), note: 'A tile is a saved view; its chip shows in the toolbar. The footer icon holds the keys.' },
    { id: 'tile-open', label: 'Tile pressed: open inspections', model: list({ view: 'open', rows: ready(viewRows('open')) }) },
    { id: 'tile-waiting', label: 'Tile pressed: waiting for release', model: list({ view: 'waiting', rows: ready(viewRows('waiting')) }) },
    { id: 'tile-failed', label: 'Tile pressed: failed - not decided (no hold, no NCR from it yet)', model: list({ view: 'failed', rows: ready(viewRows('failed')) }), note: 'W2a. Goods on hold moved to Quality › Holds (Owner answer Q3): the W1 "On hold" view is gone; its old address opens Holds.' },
    { id: 'mine', label: 'Waiting for me: the inspections assigned to me', model: list({ view: 'mine', rows: ready(viewRows('mine')) }) },
    { id: 'assign', label: 'Assign inspector: the site’s inspectors; a maker is held with the reason', model: list({ assign: assignState() }), note: 'A worker is named in the picker, never in the list (Owner answer W1).' },
    { id: 'assign-bulk', label: 'Selection: Assign 2 inspections (open ones of one site)', model: list({ selected: OPEN_ROWS.slice(0, 2).map((row) => fk(row.id)), assign: assignState({ ids: OPEN_ROWS.slice(0, 2).map((row) => row.id), value: `USER:${INSPECTORS.inspectors[1]!.id}` }) }) },
    { id: 'assign-held', label: 'Selection with a signed inspection: Assign held with its reason', model: list({ selected: [fk(OPEN_ROWS[0]!.id), fk(ROWS[3]!.id)] }) },
    { id: 'assign-refused', label: 'Assign refused by the API (each inspection in words)', model: list({ assign: assignState({ value: `USER:${INSPECTORS.inspectors[1]!.id}`, problem: 'assign.problem.refused', lines: ['DEMO-INS-0011: Made garments of work order DEMO-WO-0149: another inspector, who made none of them, inspects it.'] }) }) },
    { id: 'assign-inline', label: 'Inline Inspector cell: saving one, refused another', model: list({ people: { [OPEN_ROWS[0]!.siteId]: ready(INSPECTORS) }, marks: { [OPEN_ROWS[0]!.id]: { state: 'saving' }, [OPEN_ROWS[1]!.id]: { state: 'refused', problem: 'assign.problem.refused', lines: ['Changed meanwhile: read it again.'] } } }) },
    // ---- B-W2b-17: by when an inspection is due (design qi-grid inline "Due", the Overdue view) ----
    { id: 'w2b-due', label: 'W2b Due column: due later, overdue (said in words), none; autosaved inline', model: list({ marks: { [`due:${OPEN_ROWS[0]!.id}`]: { state: 'saved' } } }), note: 'A decided inspection shows its due time read only; the bench list says the due time and who it is assigned to (the API answers both).' },
    { id: 'w2b-tile-overdue', label: 'W2b Tile pressed: overdue (open and past the due time)', model: list({ view: 'overdue', rows: ready(viewRows('overdue')) }) },
    { id: 'w2b-due-saving', label: 'W2b Inline Due: saving one, refused another (in the API’s words under ours)', model: list({ marks: { [`due:${OPEN_ROWS[0]!.id}`]: { state: 'saving' }, [`due:${OPEN_ROWS[1]!.id}`]: { state: 'refused', problem: 'due.problem.refused', lines: ['The inspection is due later than now.'] } } }) },
    { id: 'w2b-due-bulk', label: 'W2b Selection: Set due date for 2 open inspections (one call)', model: list({ selected: OPEN_ROWS.slice(0, 2).map((row) => fk(row.id)), due: dueState() }) },
    { id: 'w2b-due-clear', label: 'W2b Set due date: no due time (clears it)', model: list({ selected: OPEN_ROWS.slice(0, 2).map((row) => fk(row.id)), due: dueState({ value: '' }) }) },
    { id: 'w2b-due-held', label: 'W2b Selection with a signed inspection: Set due date held with its reason', model: list({ selected: [fk(OPEN_ROWS[0]!.id), fk(ROWS[3]!.id)] }) },
    { id: 'w2b-due-refused', label: 'W2b Set due date refused by the API (each inspection named)', model: list({ selected: OPEN_ROWS.slice(0, 2).map((row) => fk(row.id)), due: dueState({ problem: 'due.problem.conflict', lines: ['DEMO-INS-0011 is passed: only an open inspection has a due time.'] }) }) },
    { id: 'w2b-due-read-only', label: 'W2b Production manager: Due read only (held: no right)', model: list({ view: 'open', rows: ready(viewRows('open')) }, 'production') },
    { id: 'w2b-new-due', label: 'W2b New inspection: due by (the office sets it)', model: list({ dialog: { kind: 'new' }, pick: { workOrders: ready(WORK_ORDERS), cells: ready(WO_CELLS) }, newDraft: { ...NEW_DRAFT, workOrderId: WORK_ORDERS[0]!.id, lotSize: '24', sampleSize: '5', acceptMajor: '0', acceptMinor: '1', dueAt: at(31, 16, 0) } }) },
    { id: 'tile-reversed', label: 'Tile pressed: the releases taken back (their own list)', model: list({ view: 'reversed' }) },
    { id: 'tile-lots', label: 'Tile pressed: the lots on hold (open a lot in Tests & substances)', model: list({ view: 'lots' }) },
    { id: 'release', label: 'A release in its DetailModal: what was released and by whom', model: list({ view: 'reversed', open: openRelease() }) },
    { id: 'release-gate', label: 'A release: the gate at release (certificates then and today)', model: list({ view: 'reversed', open: openRelease(RELEASE_DETAIL, 'gate') }) },
    { id: 'release-reversal', label: 'A release: taken back, its PPE register entry, what more would do', model: list({ view: 'reversed', open: openRelease(RELEASE_DETAIL, 'reversal') }) },
    { id: 'release-second', label: 'A serial release that needed a second person (listed customer)', model: list({ view: 'reversed', open: { id: RELEASES[1]!.id, detail: ready({ ...SERIAL_DETAIL, release: RELEASES[1]! }) } }) },
    { id: 'release-loading', label: 'A release still reading', model: list({ view: 'reversed', open: { id: RELEASE_DETAIL.release.id, detail: reading() } }) },
    { id: 'reverse', label: 'Take back: the impact first, the reason kind and the note', model: list({ view: 'reversed', open: openRelease(), dialog: { kind: 'reverse', releaseId: RELEASE_DETAIL.release.id }, reverseDraft: { ...REVERSE_DRAFT, quantity: '4', reasonCode: 'DEFECT_FOUND_LATER', reason: 'Stain on the right cuff found at packing.' } }) },
    { id: 'reverse-serial', label: 'Take back a serial release: pick the serials and where they go', model: list({ view: 'reversed', open: openRelease(SERIAL_DETAIL), dialog: { kind: 'reverse', releaseId: SERIAL_DETAIL.release.id }, reverseDraft: { ...REVERSE_DRAFT, serialIds: [SERIAL_DETAIL.release.serials[0]!.id], serialsTo: 'MADE', reasonCode: 'RECALL', reason: 'Recall of the demo batch.' } }) },
    { id: 'reverse-held', label: 'Take back held: everything left is shipped (said before the click)', model: list({ view: 'reversed', open: openRelease(SHIPPED_DETAIL) }) },
    { id: 'reverse-refused', label: 'Take back refused by the API (lines under our words)', model: list({ view: 'reversed', open: openRelease(), dialog: { kind: 'reverse', releaseId: RELEASE_DETAIL.release.id }, reverseDraft: { ...REVERSE_DRAFT, quantity: '6', reasonCode: 'WRONG_RESULT', reason: 'Wrong result recorded.' }, dialogProblem: 'reverse.problem.refused', dialogLines: ['6 garment(s) of this release can be taken back now: 6 in the house → put on hold · 2 on a shipment not yet gone.'] }) },
    { id: 'reverse-done', label: 'Taken back: the receipt and the PPE register entry that follows them', model: list({ view: 'reversed', reverseAnswer: { quantity: 4, register: { opened: true, entryId: uid('8901', 8), reference: 'REG-DEMO-0008', words: 'x' } } }) },
    { id: 'new', label: 'New inspection: pick a work order', model: list({ dialog: { kind: 'new' }, pick: { workOrders: ready(WORK_ORDERS), cells: null } }) },
    { id: 'new-picked', label: 'New inspection: finished garments said, the plan typed', model: list({ dialog: { kind: 'new' }, pick: { workOrders: ready(WORK_ORDERS), cells: ready(WO_CELLS) }, newDraft: { ...NEW_DRAFT, workOrderId: WORK_ORDERS[0]!.id, lotSize: '24', sampleSize: '5', acceptMajor: '0', acceptMinor: '1' } }) },
    { id: 'new-kinds', label: 'New inspection: the kind first (In-line opens with W2b-127)', model: list({ dialog: { kind: 'new' }, pick: { workOrders: ready(WORK_ORDERS), cells: null } }) },
    { id: 'new-inspector', label: 'New inspection: the inspector picked at once (a maker held)', model: list({ dialog: { kind: 'new' }, pick: { workOrders: ready(WORK_ORDERS), cells: ready(WO_CELLS) }, newPeople: ready(INSPECTORS), newDraft: { ...NEW_DRAFT, workOrderId: WORK_ORDERS[0]!.id, lotSize: '24', sampleSize: '5', acceptMajor: '0', acceptMinor: '1', assignee: `USER:${INSPECTORS.inspectors[1]!.id}` } }) },
    { id: 'new-lot', label: 'New inspection › Incoming lot: done in Tests & substances (linked)', model: list({ dialog: { kind: 'new' }, pick: { workOrders: ready(WORK_ORDERS), cells: null }, newDraft: { ...NEW_DRAFT, kind: 'LOT' } }) },
    { id: 'new-return', label: 'New inspection › Return: pick a return waiting for its inspection', model: returnNew({ kind: 'RETURN' }) },
    { id: 'new-return-grades', label: 'New inspection › Return: grade each line received (a protective garment said)', model: returnNew({ kind: 'RETURN' }, { returnId: RETURN_RECORD.id, lines: { [RETURN_RECORD.lines[0]!.id]: { grade: 'DAMAGED', cause: 'OUR_DEFECT', note: 'Seam open at the left shoulder.' }, [RETURN_RECORD.lines[1]!.id]: { grade: '', cause: '', note: '' } } }, true) },
    { id: 'new-return-held', label: 'New inspection › Return held: no right to inspect returns', model: list({ dialog: { kind: 'new' }, pick: { workOrders: ready(WORK_ORDERS), cells: null }, newDraft: { ...NEW_DRAFT, kind: 'RETURN' } }, 'production') },
    { id: 'new-refused', label: 'New inspection refused (no inspection numbering, the work order changed)', model: list({ dialog: { kind: 'new' }, pick: { workOrders: ready(WORK_ORDERS), cells: ready(WO_CELLS) }, newDraft: { ...NEW_DRAFT, workOrderId: WORK_ORDERS[0]!.id, lotSize: '24', sampleSize: '5', acceptMajor: '0', acceptMinor: '1' }, dialogProblem: 'new.problem.refused' }) },
    { id: 'rules', label: 'Quality rules: who releases (the owner)', model: list({ dialog: { kind: 'rules' } }) },
    { id: 'rules-loosen', label: 'Quality rules: loosening asks a reason (then a fresh code)', model: list({ dialog: { kind: 'rules' }, ruleDraft: { ...ruleDraftOf(RULE), customers: RULE.customers.filter((customer) => customer.listedOn === 'TENANT'), reason: '' } }) },
    { id: 'rules-tighten', label: 'Quality rules: tightening to "always" asks nothing', model: list({ dialog: { kind: 'rules' }, ruleDraft: { ...ruleDraftOf(RULE), rule: 'ALWAYS' } }) },
    { id: 'rules-step-up', label: 'Quality rules: the fresh code (step-up)', model: { ...list({ dialog: { kind: 'rules' }, ruleDraft: { ...ruleDraftOf(RULE), customers: RULE.customers.filter((customer) => customer.listedOn === 'TENANT'), reason: 'The customer moved to the standard rule by contract.' }, busy: true }), stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.loosenRule', problem: null } }, note: 'The DS step-up dialog; its own words (Cancel, Two-factor code) are still English (named in the notes).' },
    { id: 'rules-read-only', label: 'Quality rules for an inspector: read, not changed (held with its reason)', model: list({ dialog: { kind: 'rules' } }, 'inspector') },
    { id: 'selection', label: 'Selection: Export 3 (CSV)', model: list({ selected: ROWS.slice(0, 3).map((row) => fk(row.id)) }) },
    { id: 'live-updates', label: 'Live: 3 updates waiting behind Show', model: list({ updates: 3 }), note: 'Rows never move under the cursor.' },
    { id: 'offline', label: 'Offline: the last copy with its time', model: list({ live: 'offline' }) },
    { id: 'more', label: 'More than one page (Show more)', model: list({ rows: ready([...ROWS, ...ROWS, ...ROWS, ...ROWS, ...ROWS, ...ROWS].map((row, index) => ({ ...row, id: `${row.id.slice(0, -4)}${String(index).padStart(4, '0')}` })).slice(0, 50)) }) },
    { id: 'max', label: 'At the most a list shows (Show more held with its reason)', model: list({ limit: 200, rows: ready(Array.from({ length: 200 }, (_, index) => ({ ...ROWS[index % ROWS.length]!, id: `${ROWS[0]!.id.slice(0, -4)}${String(index).padStart(4, '0')}` }))) }) },
    { id: 'notice', label: 'A receipt: the rule saved', model: list({ notice: { key: 'rules.saved', tone: 'success' } }) },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows, x selects, the keys in the footer icon', model: list({ focusRow: 2, selected: [fk(ROWS[1]!.id)] }) },
    { id: 'shortcuts', label: 'The keys dialog (?)', model: list({ dialog: { kind: 'shortcuts' } }) },
    { id: 'inspector', label: 'Quality inspector: the same list; rules read only', model: list({}, 'inspector') },
    { id: 'production', label: 'Production manager: sees, decides nothing (New held, no lots)', model: list({ tiles: { ...counts, lots: { count: null, capped: false } } }, 'production') },
    { id: 'read-only', label: 'Read-only: every action held with its reason', model: list({ selected: [fk(ROWS[0]!.id)] }, 'readOnly') },
    { id: 'no-permission', label: 'Sales: no permission (which permission, who grants it)', model: list({}, 'sales') },
    { id: 'loading', label: 'Loading', model: list({ rows: reading(), tiles: {}, rule: reading(), asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The API didn't answer (never an empty list; tiles say they could not count)", model: list({ rows: failedRead('problem.unavailable'), rule: failedRead('problem.unavailable'), tiles: { open: { count: null, capped: false }, overdue: { count: null, capped: false }, waiting: { count: null, capped: false }, failed: { count: null, capped: false }, reversed: { count: null, capped: false }, lots: { count: null, capped: false } }, asOf: null, live: 'offline' }) },
    { id: 'empty', label: 'First day: no inspection yet', model: list({ rows: ready([]), tiles: { open: { count: 0, capped: false }, overdue: { count: 0, capped: false }, waiting: { count: 0, capped: false }, failed: { count: 0, capped: false }, reversed: { count: 0, capped: false }, lots: { count: 0, capped: false } } }) },
    { id: 'filtered-empty', label: 'A view with nothing in it (every failed inspection decided)', model: list({ view: 'failed', rows: ready([]) }) },
    // ---- B-W2b-127: Inspections in depth (design qi-grid W2b parts, qi-new In-line, the report verbs) ----
    { id: 'w2b127-one-list', label: 'W2b-127 One list: incoming, in-line and final rows; Kind, Subject, Supplier, Lot size, Sample n of N, Plan + version', model: list({ rows: ready(DEPTH_ROWS) }), note: 'Newest first across the three kinds; a final row keeps its inline Inspector and Due. No person in a list: an incoming row says at the bench / in the office.' },
    { id: 'w2b127-kind-incoming', label: 'W2b-127 Kind chip: Incoming only', model: list({ rows: ready(DEPTH_ROWS), kind: 'INCOMING' }) },
    { id: 'w2b127-kind-inline', label: 'W2b-127 Kind chip: In-line only (a first piece holding a run, an end-of-line fail with its DHU)', model: list({ rows: ready(DEPTH_ROWS), kind: 'INLINE' }) },
    { id: 'w2b127-kind-final-view', label: 'W2b-127 A final-only view (Waiting for release): one line says why the other kinds are not listed', model: list({ view: 'waiting', rows: ready(viewRows('waiting')) }) },
    { id: 'w2b127-amended', label: 'W2b-127 Saved view: Amended results (a countersigned correction)', model: list({ view: 'amended', rows: ready(AMENDED_ROWS), incoming: null, inline: null }) },
    { id: 'w2b127-amended-empty', label: 'W2b-127 Amended results: none yet', model: list({ view: 'amended', rows: ready([]), incoming: null, inline: null }) },
    { id: 'w2b127-print', label: 'W2b-127 Selection: Print 2 reports (signed final inspections; a new tab)', model: list({ rows: ready(DEPTH_ROWS), selected: [fk(ROWS[3]!.id), fk(ROWS[8]!.id)] }) },
    { id: 'w2b127-print-held', label: 'W2b-127 Selection with an open and an incoming row: Print, Assign and Due held with the reason', model: list({ rows: ready(DEPTH_ROWS), selected: [fk(ROWS[0]!.id), rowKey('INCOMING', INCOMING_ROWS[0]!.id)] }) },
    { id: 'w2b127-part-failed', label: 'W2b-127 The in-line checks could not be read: a banner with Try again, the rest of the list stands', model: list({ rows: ready(DEPTH_ROWS), inline: failedRead('problem.unavailable') }) },
    { id: 'w2b127-capped', label: 'W2b-127 The in-line read stopped at 500 (said; the count says "at least")', model: list({ rows: ready(DEPTH_ROWS), inlineCapped: true }) },
    { id: 'w2b127-warehouse', label: 'W2b-127 Warehouse: incoming rows (quality.incoming.view) — the page itself needs quality.inspections.view', model: list({}, 'warehouse') },
    { id: 'w2b127-new-inline', label: 'W2b-127 New inspection › In-line: which check, the work order, a first piece names its bundle', model: list({ dialog: { kind: 'new' }, pick: { workOrders: ready(WORK_ORDERS), cells: null }, newDraft: { ...NEW_DRAFT, kind: 'INLINE', workOrderId: WORK_ORDERS[0]!.id } }) },
    { id: 'w2b127-new-inline-held', label: 'W2b-127 New inspection › In-line held for read-only (quality.inprocess.record, said)', model: list({ dialog: { kind: 'new' }, pick: { workOrders: ready(WORK_ORDERS), cells: null }, newDraft: { ...NEW_DRAFT, kind: 'INLINE' } }, 'readOnly') },
    { id: 'w2b127-new-plan', label: 'W2b-127 New inspection › Final on the plan that applies (the sample from ISO 2859-1, drawn by AqlSummary)', model: list({ dialog: { kind: 'new' }, pick: { workOrders: ready(WORK_ORDERS), cells: ready(WO_CELLS) }, plans: ready(PLANS), newDraft: { ...NEW_DRAFT, workOrderId: WORK_ORDERS[0]!.id, lotSize: '480', typed: false } }) },
    { id: 'w2b127-new-plan-other', label: 'W2b-127 New inspection › another plan: the reason asked (kept with the inspection)', model: list({ dialog: { kind: 'new' }, pick: { workOrders: ready(WORK_ORDERS), cells: ready(WO_CELLS) }, plans: ready(PLANS), newDraft: { ...NEW_DRAFT, workOrderId: WORK_ORDERS[0]!.id, lotSize: '480', typed: false, planId: PLANS.plans[1]!.id } }) },
    { id: 'w2b127-new-plan-none', label: 'W2b-127 New inspection › no final plan applies: type the sample by hand', model: list({ dialog: { kind: 'new' }, pick: { workOrders: ready(WORK_ORDERS), cells: ready(WO_CELLS) }, plans: ready(PLANS_NONE), newDraft: { ...NEW_DRAFT, workOrderId: WORK_ORDERS[0]!.id, lotSize: '24', typed: false } }) },
  ],
})
