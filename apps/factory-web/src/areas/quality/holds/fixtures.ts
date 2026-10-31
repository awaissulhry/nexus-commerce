import { createElement, Fragment, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { RecordPanelsView } from '../../../record-panels/view/RecordPanelsView'
import { designScreen as panelsScreen } from '../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../record-panels/model'
import { STEP_UP_CLOSED, type StepUpState } from '../_shared/hooks'
import { failedRead, qualityCan, ready, reading } from '../_shared/model'
import { canFor, inShell, ME, NOW, PREFIX, ROLE_PERMISSIONS, uid, type RoleCase } from '../_shared/fixtures'
import type { Hold, HoldDetail } from './api'
import { CLOSED, COUNTS, DETAIL_CR_VI, DETAIL_MAKER, DETAIL_PLACER, DETAIL_READY, DETAIL_RELEASED, DETAIL_STATEMENT, detailOf, HOLDS, PEOPLE, PREVIEW, PREVIEW_PROBLEMS, PREVIEW_WORK_ORDER, QUARANTINE_PLACE, REASONS, REASON_WORDS, RELEASED } from './demo/fixtures'
import { placeDraftOf, RELEASE_DRAFT, type HoldsDialog, type HoldsListModel, type PlaceDraft, type PlaceModel, type RecordTab, type ReleaseDraft, type View } from './model'
import { PlaceHoldDialog } from './place/view/PlaceHoldDialog'
import { HoldsView } from './view/HoldsView'

/**
 * SCR-078 Quality › Holds — made-up data only (DEMO-LOT-…, DEMO-WO-…, DEMO-HIDE-…, Demo people). Each case is a state the
 * Owner reviews: the list with its tiles and the quarantine notice, each tile pressed, a hold in its DetailModal on each
 * tab, every release check failing in turn, the release with its fresh code, refused and done, the bulk release held and
 * allowed, the owner and expected release saved inline, the quarantine move popover, Place hold empty / prefilled from
 * an inspection / with a refused record / refused, Decide in NCR (it opens New NCR), the role cases and every state of a list. In
 * the browser the ticks, the views, the tabs, the dialogs and the drafts work for real (the wrapper keeps them).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: HoldsListModel
  readonly stepUp?: StepUpState
  readonly place?: PlaceModel
}

const ALL = [...HOLDS, ...RELEASED, ...CLOSED]
const DETAILS: Record<string, HoldDetail> = Object.fromEntries([DETAIL_READY, DETAIL_PLACER, DETAIL_MAKER, DETAIL_STATEMENT, DETAIL_CR_VI, DETAIL_RELEASED].map((detail) => [detail.hold.id, detail]))
const detailFor = (id: string): HoldDetail => DETAILS[id] ?? detailOf(ALL.find((hold) => hold.id === id) ?? HOLDS[0]!)

const rowsOf = (view: View): Hold[] => {
  switch (view) {
    case 'open':
      return HOLDS
    case 'mine':
      return HOLDS.filter((hold) => hold.ownerId === ME)
    case 'overdue':
      return HOLDS.filter((hold) => hold.overdue)
    case 'system':
      return HOLDS.filter((hold) => hold.placedBy.kind === 'SYSTEM')
    case 'quarantine':
      return HOLDS.filter((hold) => hold.quarantine === 'ASKED')
    case 'released':
      return RELEASED
    case 'closed':
      return CLOSED
    case 'all':
      return ALL
  }
}

const list = (over: Partial<HoldsListModel> = {}, role: RoleCase = 'owner'): DesignModel => ({
  role,
  model: {
    prefix: PREFIX,
    me: ME,
    can: canFor(role),
    today: '2026-10-29',
    view: 'open',
    subjectType: null,
    subjectId: null,
    rows: ready(HOLDS),
    truncated: false,
    limit: 50,
    counts: ready(COUNTS),
    reasons: REASON_WORDS,
    people: { [HOLDS[0]!.siteId]: ready(PEOPLE) },
    cells: {},
    asOf: NOW,
    live: 'live',
    updates: 0,
    selected: [],
    details: {},
    ...over,
  },
})

const openOn = (detail: HoldDetail, tab: RecordTab = 'hold') => ({ open: { id: detail.hold.id, detail: ready(detail), tab } })

const panelsPreview = (hold: Hold): RecordPanelsViewModel => {
  const base = panelsScreen.cases.find((entry) => entry.id === 'conversation')?.model ?? panelsScreen.cases[0]!.model
  return { ...base, record: { type: 'QualityHold', id: hold.id, companyId: hold.companyId, siteId: hold.siteId }, title: `${hold.subjects[0]?.label ?? ''}`, party: null }
}

const placeModel = (draft: PlaceDraft, over: Partial<PlaceModel> = {}): PlaceModel => ({
  open: true,
  draft,
  preview: draft.ids.length + draft.codes.length > 0 ? ready(PREVIEW) : null,
  reasons: ready(REASONS),
  people: ready(PEOPLE),
  today: '2026-10-29',
  busy: false,
  problem: null,
  held: null,
  ...over,
})

const LOT_DRAFT: PlaceDraft = { ...placeDraftOf({ subjectType: 'Lot', codes: ['DEMO-LOT-0231', 'DEMO-LOT-0233'] }), reasonCode: 'SUPPLIER_CHECK', ownerId: ME, expectedReleaseOn: '2026-10-31', quarantineLocationId: QUARANTINE_PLACE.id }
const FROM_INSPECTION: PlaceDraft = { ...placeDraftOf({ subjectType: 'WorkOrder', subjectIds: [uid('7822', 1)], sourceType: 'Inspection', sourceId: uid('7701', 9), fromLabel: 'inspection DEMO-INS-0009 (failed)' }), reasonCode: 'QUALITY_CHECK' }

function HoldsDesign({ model: design }: { model: DesignModel }) {
  const [view, setView] = useState<View>(design.model.view)
  const [selected, setSelected] = useState<readonly string[]>(design.model.selected)
  const [dialog, setDialog] = useState<HoldsDialog | null>(design.model.dialog ?? null)
  const [open, setOpen] = useState(design.model.open ?? null)
  const [releaseDraft, setReleaseDraft] = useState<ReleaseDraft>(design.model.releaseDraft ?? RELEASE_DRAFT)
  const [assignTo, setAssignTo] = useState<string | null>(design.model.assignTo ?? null)
  const [place, setPlace] = useState<PlaceModel | null>(design.place ?? null)
  useEffect(() => {
    setView(design.model.view)
    setSelected(design.model.selected)
    setDialog(design.model.dialog ?? null)
    setOpen(design.model.open ?? null)
    setPlace(design.place ?? null)
  }, [design])
  const changedView = view !== design.model.view
  const model: HoldsListModel = {
    ...design.model,
    view,
    rows: design.model.rows.value && changedView ? ready(rowsOf(view)) : design.model.rows,
    selected,
    details: { ...DETAILS, ...design.model.details },
    dialog,
    open,
    releaseDraft,
    assignTo,
  }
  const hold = open?.detail.value?.hold ?? null
  return inShell(
    '/quality/holds',
    createElement(
      Fragment,
      null,
      createElement(HoldsView, {
        model,
        stepUp: design.stepUp ?? STEP_UP_CLOSED,
        panels: hold && design.model.can.threadsRead ? createElement(RecordPanelsView, { model: panelsPreview(hold) }) : null,
        actions: {
          onView: (next: View) => {
            setView(next)
            setSelected([])
          },
          onSelect: (ids: readonly string[]) => setSelected([...ids]),
          onDialog: setDialog,
          onOpen: (id: string | null) => setOpen(id ? { id, detail: ready(detailFor(id)), tab: open?.tab ?? 'hold' } : null),
          onTab: (tab: RecordTab) => setOpen((current) => (current ? { ...current, tab } : current)),
          onPlace: () => setPlace(placeModel(placeDraftOf(null))),
          onReleaseDraft: setReleaseDraft,
          onAssignTo: setAssignTo,
        },
      }),
      place ? createElement(PlaceHoldDialog, { model: place, onDraft: (draft: PlaceDraft) => setPlace({ ...place, draft, preview: draft.ids.length + draft.codes.length > 0 ? place.preview ?? ready(PREVIEW) : null }), onClose: () => setPlace(null) }) : null,
    ),
    design.role,
  )
}

const unknownCounts = failedRead<typeof COUNTS>('problem.unavailable')

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-078',
  title: 'Holds',
  view: HoldsDesign,
  cases: [
    { id: 'list', label: 'Owner: everything on hold, the tiles, the quarantine notice', model: list(), note: 'A tile is a saved view; its chip shows in the toolbar. No "value on hold" tile: the API serves no value yet. The footer icon holds the keys.' },
    { id: 'tile-overdue', label: 'Tile pressed: overdue', model: list({ view: 'overdue', rows: ready(rowsOf('overdue')) }) },
    { id: 'tile-system', label: 'Tile pressed: placed by the system', model: list({ view: 'system', rows: ready(rowsOf('system')) }) },
    { id: 'tile-mine', label: 'Tile pressed: waiting for my decision', model: list({ view: 'mine', rows: ready(rowsOf('mine')) }) },
    { id: 'tile-quarantine', label: 'Tile pressed: waiting quarantine move (the notice gives way to the list)', model: list({ view: 'quarantine', rows: ready(rowsOf('quarantine')) }) },
    { id: 'view-released', label: 'View: released holds (read only)', model: list({ view: 'released', rows: ready(RELEASED) }) },
    { id: 'view-closed', label: 'View: closed in an NCR', model: list({ view: 'closed', rows: ready(CLOSED) }) },
    { id: 'one-record', label: "One record's holds (Q3: from a lot, a work order, an inspection)", model: list({ subjectId: HOLDS[1]!.subjects[0]!.id, rows: ready([HOLDS[1]!]) }) },
    { id: 'quarantine-pop', label: 'The quarantine move popover (asked, not confirmed)', model: list({ moveOpen: HOLDS[0]!.id }), note: "The floor's move task comes with W2b (QHS-078): said in the popover." },
    { id: 'inline-saving', label: 'Inline: owner saving, expected release saved', model: list({ cells: { [`${HOLDS[0]!.id}:owner`]: { state: 'saving' }, [`${HOLDS[1]!.id}:expected`]: { state: 'saved' } } }) },
    { id: 'inline-refused', label: 'Inline: a change refused (someone changed it meanwhile)', model: list({ cells: { [`${HOLDS[0]!.id}:owner`]: { state: 'refused', problem: 'cell.conflict' } } }) },
    { id: 'selection-allowed', label: 'Selection: Release 2 holds allowed, Assign owner, Print tags, Export', model: list({ selected: [HOLDS[0]!.id, HOLDS[6]!.id], details: { [HOLDS[0]!.id]: DETAIL_READY, [HOLDS[6]!.id]: detailOf(HOLDS[6]!) } }) },
    { id: 'selection-held', label: 'Selection: Release 3 held with the reason (one needs a re-inspection, one was placed by you)', model: list({ selected: [HOLDS[0]!.id, HOLDS[1]!.id, HOLDS[4]!.id] }) },
    { id: 'detail-hold', label: 'A hold in its DetailModal: Hold (owner, expected release and note editable)', model: list(openOn(DETAIL_READY)) },
    { id: 'detail-work-order', label: 'A work order on hold: the work orders it holds, overdue', model: list(openOn(DETAIL_MAKER)) },
    { id: 'detail-decision', label: 'Decision: every check met, Release ready', model: list(openOn(DETAIL_READY, 'decision')) },
    { id: 'check-placer', label: 'Decision: you placed it — another person releases', model: list(openOn(DETAIL_PLACER, 'decision')) },
    { id: 'check-maker', label: 'Decision: you made some of the garments; no re-inspection yet', model: list(openOn(DETAIL_MAKER, 'decision')) },
    { id: 'check-statement', label: 'Decision: the floor names stations only — the statement is signed in the release', model: list(openOn(DETAIL_STATEMENT, 'decision')) },
    { id: 'check-cr-vi', label: 'Decision: waiting for a Cr VI PASS', model: list(openOn(DETAIL_CR_VI, 'decision')) },
    { id: 'detail-activity', label: 'Activity: the thread, files and history of the hold', model: list(openOn(DETAIL_READY, 'activity')) },
    { id: 'detail-released', label: 'A released hold: read only', model: list({ view: 'released', rows: ready(RELEASED), ...openOn(DETAIL_RELEASED) }) },
    { id: 'detail-loading', label: 'A hold still reading', model: list({ open: { id: HOLDS[0]!.id, detail: reading(), tab: 'hold' } }) },
    { id: 'detail-error', label: 'A hold that could not be read', model: list({ open: { id: HOLDS[0]!.id, detail: failedRead('problem.unavailable'), tab: 'hold' } }) },
    { id: 'release', label: 'Release: the checks, the note, then the fresh code', model: list({ ...openOn(DETAIL_READY), dialog: { kind: 'release', ids: [HOLDS[0]!.id] } }) },
    { id: 'release-statement', label: 'Release: the signed statement where the floor names stations only', model: list({ ...openOn(DETAIL_STATEMENT), dialog: { kind: 'release', ids: [HOLDS[3]!.id] }, releaseDraft: { note: '', statement: false } }) },
    { id: 'release-step-up', label: 'Release: the fresh code (step-up)', model: { ...list({ ...openOn(DETAIL_READY), dialog: { kind: 'release', ids: [HOLDS[0]!.id] }, busy: true }), stepUp: { open: true, busy: false, sentence: 'release.stepUpSentence', problem: null } }, note: 'The DS step-up dialog; its own words (Cancel, Two-factor code) are still English (named in the notes).' },
    { id: 'release-refused', label: 'Release refused by the API (409: its words under ours)', model: list({ ...openOn(DETAIL_READY), dialog: { kind: 'release', ids: [HOLDS[0]!.id] }, dialogProblem: 'release.refused', dialogLines: ['Re-inspection signed (now: missing for DEMO-WO-0142).'] }) },
    { id: 'release-bulk', label: 'Release 2 holds: one line each, the code asked once', model: list({ selected: [HOLDS[0]!.id, HOLDS[6]!.id], details: { [HOLDS[6]!.id]: detailOf(HOLDS[6]!) }, dialog: { kind: 'release', ids: [HOLDS[0]!.id, HOLDS[6]!.id] } }) },
    { id: 'release-done', label: 'Released: the receipt with the work orders back where they were', model: list({ notice: { key: 'notice.releasedLifted', params: { count: 1, lifted: 1 }, tone: 'success' } }) },
    { id: 'bulk-partly', label: 'A bulk release partly refused: each refusal named', model: list({ notice: { key: 'notice.bulkPartly', params: { done: 1, refused: 1 }, tone: 'warning', detail: ['Work order DEMO-WO-0142: Re-inspection signed (now: missing for DEMO-WO-0142).'] } }) },
    { id: 'assign', label: 'Assign owner to 2 holds of one site', model: list({ selected: [HOLDS[0]!.id, HOLDS[2]!.id], dialog: { kind: 'assign', ids: [HOLDS[0]!.id, HOLDS[2]!.id] }, assignTo: uid('3333', 11) }) },
    { id: 'place', label: 'Place hold: empty', model: { ...list(), place: placeModel(placeDraftOf(null)) } },
    { id: 'place-lots', label: 'Place hold: 2 lots scanned, the preview, reason, owner, quarantine', model: { ...list(), place: placeModel(LOT_DRAFT) } },
    { id: 'place-problems', label: 'Place hold: a code not found and a rejected lot (held with the reason)', model: { ...list(), place: placeModel({ ...LOT_DRAFT, codes: [...LOT_DRAFT.codes, 'DEMO-LOT-9999', 'DEMO-LOT-0190'] }, { preview: ready(PREVIEW_PROBLEMS) }) } },
    { id: 'place-from-inspection', label: 'Place hold from a failed inspection: the work order goes on hold', model: { ...list(), place: placeModel(FROM_INSPECTION, { preview: ready(PREVIEW_WORK_ORDER) }) } },
    { id: 'place-refused', label: 'Place hold refused (400: the fields named)', model: { ...list(), place: placeModel(LOT_DRAFT, { problem: 'place.problem.refused', lines: ['The expected release is today or later.'], fields: ['expectedReleaseOn'] }) } },
    { id: 'live-updates', label: 'Live: 3 updates waiting behind Show', model: list({ updates: 3 }), note: 'Rows never move under the cursor.' },
    { id: 'offline', label: 'Offline: the last copy with its time', model: list({ live: 'offline' }) },
    { id: 'more', label: 'More than one page (Show more)', model: list({ rows: ready(Array.from({ length: 60 }, (_, index) => ({ ...HOLDS[index % HOLDS.length]!, id: uid('7899', index + 1) }))) }) },
    { id: 'max', label: 'At the most a list shows (Show more held with its reason)', model: list({ truncated: true, limit: 200, rows: ready(Array.from({ length: 200 }, (_, index) => ({ ...HOLDS[index % HOLDS.length]!, id: uid('7898', index + 1) }))) }) },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows, x selects, the keys in the footer icon', model: list({ focusRow: 2, selected: [HOLDS[1]!.id] }) },
    { id: 'shortcuts', label: 'The keys dialog (?)', model: list({ dialog: { kind: 'shortcuts' } }) },
    { id: 'inspector', label: 'Quality inspector: places, changes and releases', model: list({}, 'inspector') },
    { id: 'production', label: 'Production manager: places and changes; Release held with the reason', model: list(openOn(DETAIL_READY, 'decision'), 'production') },
    { id: 'supervisor', label: 'Floor supervisor: places and changes; Release held with the reason', model: list({ selected: [HOLDS[0]!.id] }, 'supervisor') },
    { id: 'warehouse', label: 'Warehouse: reads what is on hold; every change held with its reason', model: list(openOn(DETAIL_READY), 'warehouse') },
    { id: 'read-only', label: 'Read-only (the template reads holds): sees, changes nothing', model: list({ selected: [HOLDS[0]!.id], can: qualityCan([...ROLE_PERMISSIONS.readOnly, 'quality.holds.view']) }, 'readOnly') },
    { id: 'no-permission', label: 'Sales: no permission (which permission, who grants it)', model: list({}, 'sales') },
    { id: 'loading', label: 'Loading', model: list({ rows: reading(), counts: reading(), asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The API didn't answer (never an empty list; tiles say they could not count)", model: list({ rows: failedRead('problem.unavailable'), counts: unknownCounts, asOf: null, live: 'offline' }) },
    { id: 'empty', label: 'Nothing on hold', model: list({ rows: ready([]), counts: ready({ open: 0, overdue: 0, system: 0, mine: 0, waitingQuarantine: 0 }) }) },
    { id: 'filtered-empty', label: 'A view with nothing in it', model: list({ view: 'overdue', rows: ready([]) }) },
  ],
})
