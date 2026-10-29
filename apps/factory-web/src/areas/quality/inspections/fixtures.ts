import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { STEP_UP_CLOSED, type StepUpState } from '../_shared/hooks'
import { failedRead, ready, reading } from '../_shared/model'
import { canFor, inShell, ME, NOW, PREFIX, uid, type RoleCase } from '../_shared/fixtures'
import { LOTS, RELEASE_DETAIL, RELEASES, ROWS, RULE, SERIAL_DETAIL, SHIPPED_DETAIL, WO_CELLS, WORK_ORDERS } from './demo/fixtures'
import { NEW_DRAFT, ruleDraftOf, REVERSE_DRAFT, type InspectionsListModel, type ListDialog, type View } from './model'
import { InspectionsView } from './view/InspectionsView'

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

const counts = { open: { count: 2, capped: false }, waiting: { count: 2, capped: false }, onHold: { count: 2, capped: false }, reversed: { count: 2, capped: false }, lots: { count: 3, capped: false } }

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
    ...over,
  },
})

const viewRows = (view: View) =>
  view === 'open' ? ROWS.filter((row) => row.status === 'OPEN') : view === 'waiting' ? ROWS.filter((row) => row.toRelease > 0 && !row.onHold) : view === 'onHold' ? ROWS.filter((row) => row.onHold) : ROWS

function InspectionsDesign({ model: design }: { model: DesignModel }) {
  const [view, setView] = useState<View>(design.model.view)
  const [selected, setSelected] = useState<readonly string[]>(design.model.selected)
  const [dialog, setDialog] = useState<ListDialog | null>(design.model.dialog ?? null)
  const [open, setOpen] = useState(design.model.open ?? null)
  const [newDraft, setNewDraft] = useState(design.model.newDraft ?? NEW_DRAFT)
  const [ruleDraft, setRuleDraft] = useState(design.model.ruleDraft)
  const [reverseDraft, setReverseDraft] = useState(design.model.reverseDraft ?? REVERSE_DRAFT)
  useEffect(() => {
    setView(design.model.view)
    setSelected(design.model.selected)
    setDialog(design.model.dialog ?? null)
    setOpen(design.model.open ?? null)
  }, [design])
  const model: InspectionsListModel = {
    ...design.model,
    view,
    rows: design.model.rows.value && view !== design.model.view ? ready(viewRows(view)) : design.model.rows,
    selected,
    dialog,
    open,
    newDraft,
    ruleDraft: ruleDraft ?? (dialog?.kind === 'rules' && design.model.rule.value ? ruleDraftOf(design.model.rule.value) : undefined),
    reverseDraft,
  }
  return inShell(
    '/quality/inspections',
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
      },
    }),
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
    { id: 'tile-on-hold', label: 'Tile pressed: on hold (failed, or garments taken back)', model: list({ view: 'onHold', rows: ready(viewRows('onHold')) }), note: 'Owner answer Q3: goods on hold are reached from here.' },
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
    { id: 'new-refused', label: 'New inspection refused (no inspection numbering, the work order changed)', model: list({ dialog: { kind: 'new' }, pick: { workOrders: ready(WORK_ORDERS), cells: ready(WO_CELLS) }, newDraft: { ...NEW_DRAFT, workOrderId: WORK_ORDERS[0]!.id, lotSize: '24', sampleSize: '5', acceptMajor: '0', acceptMinor: '1' }, dialogProblem: 'new.problem.refused' }) },
    { id: 'rules', label: 'Quality rules: who releases (the owner)', model: list({ dialog: { kind: 'rules' } }) },
    { id: 'rules-loosen', label: 'Quality rules: loosening asks a reason (then a fresh code)', model: list({ dialog: { kind: 'rules' }, ruleDraft: { ...ruleDraftOf(RULE), customers: RULE.customers.filter((customer) => customer.listedOn === 'TENANT'), reason: '' } }) },
    { id: 'rules-tighten', label: 'Quality rules: tightening to "always" asks nothing', model: list({ dialog: { kind: 'rules' }, ruleDraft: { ...ruleDraftOf(RULE), rule: 'ALWAYS' } }) },
    { id: 'rules-step-up', label: 'Quality rules: the fresh code (step-up)', model: { ...list({ dialog: { kind: 'rules' }, ruleDraft: { ...ruleDraftOf(RULE), customers: RULE.customers.filter((customer) => customer.listedOn === 'TENANT'), reason: 'The customer moved to the standard rule by contract.' }, busy: true }), stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.loosenRule', problem: null } }, note: 'The DS step-up dialog; its own words (Cancel, Two-factor code) are still English (named in the notes).' },
    { id: 'rules-read-only', label: 'Quality rules for an inspector: read, not changed (held with its reason)', model: list({ dialog: { kind: 'rules' } }, 'inspector') },
    { id: 'selection', label: 'Selection: Export 3 (CSV)', model: list({ selected: ROWS.slice(0, 3).map((row) => row.id) }) },
    { id: 'live-updates', label: 'Live: 3 updates waiting behind Show', model: list({ updates: 3 }), note: 'Rows never move under the cursor.' },
    { id: 'offline', label: 'Offline: the last copy with its time', model: list({ live: 'offline' }) },
    { id: 'more', label: 'More than one page (Show more)', model: list({ rows: ready([...ROWS, ...ROWS, ...ROWS, ...ROWS, ...ROWS, ...ROWS].map((row, index) => ({ ...row, id: `${row.id.slice(0, -4)}${String(index).padStart(4, '0')}` })).slice(0, 50)) }) },
    { id: 'max', label: 'At the most a list shows (Show more held with its reason)', model: list({ limit: 200, rows: ready(Array.from({ length: 200 }, (_, index) => ({ ...ROWS[index % ROWS.length]!, id: `${ROWS[0]!.id.slice(0, -4)}${String(index).padStart(4, '0')}` }))) }) },
    { id: 'notice', label: 'A receipt: the rule saved', model: list({ notice: { key: 'rules.saved', tone: 'success' } }) },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows, x selects, the keys in the footer icon', model: list({ focusRow: 2, selected: [ROWS[1]!.id] }) },
    { id: 'shortcuts', label: 'The keys dialog (?)', model: list({ dialog: { kind: 'shortcuts' } }) },
    { id: 'inspector', label: 'Quality inspector: the same list; rules read only', model: list({}, 'inspector') },
    { id: 'production', label: 'Production manager: sees, decides nothing (New held, no lots)', model: list({ tiles: { ...counts, lots: { count: null, capped: false } } }, 'production') },
    { id: 'read-only', label: 'Read-only: every action held with its reason', model: list({ selected: [ROWS[0]!.id] }, 'readOnly') },
    { id: 'no-permission', label: 'Sales: no permission (which permission, who grants it)', model: list({}, 'sales') },
    { id: 'loading', label: 'Loading', model: list({ rows: reading(), tiles: {}, rule: reading(), asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The API didn't answer (never an empty list; tiles say they could not count)", model: list({ rows: failedRead('problem.unavailable'), rule: failedRead('problem.unavailable'), tiles: { open: { count: null, capped: false }, waiting: { count: null, capped: false }, onHold: { count: null, capped: false }, reversed: { count: null, capped: false }, lots: { count: null, capped: false } }, asOf: null, live: 'offline' }) },
    { id: 'empty', label: 'First day: no inspection yet', model: list({ rows: ready([]), tiles: { open: { count: 0, capped: false }, waiting: { count: 0, capped: false }, onHold: { count: 0, capped: false }, reversed: { count: 0, capped: false }, lots: { count: 0, capped: false } } }) },
    { id: 'filtered-empty', label: 'A view with nothing in it', model: list({ view: 'onHold', rows: ready([]) }) },
  ],
})
