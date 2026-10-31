import { createElement, useEffect, useState } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../../_shared/hooks'
import { inShell, PREFIX, ROLE_PERMISSIONS, type RoleCase } from '../../_shared/fixtures'
import { COUNTS, DEFECTS, LANES, NOW, PEOPLE, PREFILL, RECORD_READY, ROWS, SITES } from '../demo/fixtures'
import { checksSay, factsOfRecord, ncrCan, ncrQueryOf, type NcrCan, type NcrView } from '../model'
import { draftOf, EMPTY_DRAFT, type ListDialog, type NcrListModel } from './view-model'
import { NcrListView } from './view/NcrListView'

/**
 * SCR-144 Nonconformances — made-up data only (NCR-DEMO-…, Demo names). Each case is a state the Owner reviews: the list
 * with its tiles, each tile pressed, the board (drag or keys; a refused move says why; a drop on Closed opens the
 * closing signature and then the fresh code), New NCR by hand and raised from a record, Assign owner, the role cases and
 * every state of a list. In the browser the views, the mode, the selection and the drafts work for real.
 */

/** The permissions of a role template, plus Home (what that role's person holds). */
const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']
const ROLES = {
  owner: [...ROLE_PERMISSIONS.owner],
  inspector: template('quality_inspector'),
  production: template('production_manager'),
  sales: template('sales'),
  warehouse: template('warehouse'),
  readOnly: template('read_only'),
  maintenance: template('maintenance'),
} as const
type Role = keyof typeof ROLES
/** The nearest shell role case (the navigation drawn around the page). */
const SHELL: Record<Role, RoleCase> = { owner: 'owner', inspector: 'inspector', production: 'production', sales: 'sales', warehouse: 'readOnly', readOnly: 'readOnly', maintenance: 'readOnly' }

interface DesignModel {
  readonly role: Role
  readonly model: NcrListModel
}

const viewRows = (view: NcrView) => {
  const query = ncrQueryOf({ view, q: '', siteId: null })
  return ROWS.filter((row) => {
    if (query.open === false) return true
    if (query.stage?.length) return query.stage.includes(row.stage)
    if (row.stage === 'CLOSED' || row.stage === 'CANCELLED') return false
    if (query.ownerId === 'me') return row.ownerId === PEOPLE[0]!.id
    if (query.severity) return row.severity === query.severity
    if (query.source) return row.source === query.source
    if (query.overdue) return row.containmentOverdue
    if (query.waiting) return Number(row.decided.left) > 0
    return true
  })
}

const can = (role: Role): NcrCan => ncrCan(ROLES[role])

const list = (over: Partial<NcrListModel> = {}, role: Role = 'owner'): DesignModel => ({
  role,
  model: {
    prefix: PREFIX,
    can: can(role),
    address: { view: 'open', q: '', siteId: null, mode: 'list' },
    sites: SITES,
    rows: { items: viewRows('open'), truncated: false, problem: null },
    lanes: { items: LANES, problem: null },
    counts: COUNTS,
    people: PEOPLE,
    asOf: NOW,
    now: NOW,
    live: 'live',
    updates: 0,
    notice: null,
    moving: null,
    dialog: null,
    close: null,
    stepUp: STEP_UP_CLOSED,
    ...over,
  },
})

const board = (over: Partial<NcrListModel> = {}, role: Role = 'owner'): DesignModel => list({ address: { view: 'open', q: '', siteId: null, mode: 'board' }, ...over }, role)

const newDialog = (over: Partial<Extract<ListDialog, { kind: 'new' }>> = {}): ListDialog => ({ kind: 'new', draft: EMPTY_DRAFT, from: null, defects: DEFECTS, busy: false, notice: null, ...over })
const fromRecord = { recordType: 'Inspection', recordId: PREFILL.fromId }

const closeModel = (over: Partial<NonNullable<NcrListModel['close']>> = {}): NonNullable<NcrListModel['close']> => ({
  ncrId: RECORD_READY.ncr.id,
  number: RECORD_READY.ncr.number,
  checks: checksSay(RECORD_READY.closing.checks, factsOfRecord(RECORD_READY), 'CLOSED'),
  ready: true,
  note: '',
  busy: false,
  notice: null,
  readProblem: null,
  held: null,
  ...over,
})

function NcrDesign({ model: design }: { model: DesignModel }) {
  const [address, setAddress] = useState(design.model.address)
  const [dialog, setDialog] = useState(design.model.dialog)
  const [close, setClose] = useState(design.model.close)
  useEffect(() => {
    setAddress(design.model.address)
    setDialog(design.model.dialog)
    setClose(design.model.close)
  }, [design])
  const model: NcrListModel = {
    ...design.model,
    address,
    rows: design.model.rows.items && address.view !== design.model.address.view ? { items: viewRows(address.view), truncated: false, problem: null } : design.model.rows,
    dialog,
    close,
  }
  return inShell(
    '/quality/ncr',
    createElement(NcrListView, {
      model,
      actions: {
        onView: (view: NcrView) => setAddress((current) => ({ ...current, view })),
        onMode: (mode: 'list' | 'board') => setAddress((current) => ({ ...current, mode })),
        onNew: () => setDialog(newDialog()),
        onNewDraft: (patch) => setDialog((current) => (current?.kind === 'new' ? { ...current, draft: { ...current.draft, ...patch } } : current)),
        onAssign: (ids) => setDialog({ kind: 'assign', ids, ownerId: '', busy: false, notice: null }),
        onAssignOwner: (ownerId) => setDialog((current) => (current?.kind === 'assign' ? { ...current, ownerId } : current)),
        onDialogClose: () => setDialog(null),
        onBoardMove: async (card, to) => {
          if (to === 'CLOSED') {
            setClose(closeModel({ ncrId: card.id, number: card.number }))
            return false
          }
          return false
        },
        close: { onNote: (note: string) => setClose((current) => (current ? { ...current, note } : current)), onCancel: () => setClose(null), onSubmit: () => setClose(null) },
      },
    }),
    SHELL[design.role],
  )
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-144',
  title: 'Nonconformances',
  view: NcrDesign,
  cases: [
    { id: 'list', label: 'Owner: the open NCRs, the tiles, the rows and the list', model: list(), note: 'A tile is a saved row; its rows show in the toolbar. The footer icon holds the keys.' },
    { id: 'tile-overdue', label: 'Tile pressed: containment overdue', model: list({ address: { view: 'overdue', q: '', siteId: null, mode: 'list' }, rows: { items: viewRows('overdue'), truncated: false, problem: null } }) },
    { id: 'tile-waiting', label: 'Tile pressed: waiting disposition (quantity not yet decided)', model: list({ address: { view: 'waiting', q: '', siteId: null, mode: 'list' }, rows: { items: viewRows('waiting'), truncated: false, problem: null } }) },
    { id: 'tile-critical', label: 'Tile pressed: critical open', model: list({ address: { view: 'critical', q: '', siteId: null, mode: 'list' }, rows: { items: viewRows('critical'), truncated: false, problem: null } }) },
    { id: 'tile-closed', label: 'Tile pressed: closed (every closed NCR, newest first)', model: list({ address: { view: 'closed', q: '', siteId: null, mode: 'list' }, rows: { items: viewRows('closed'), truncated: false, problem: null } }) },
    { id: 'rows-mine', label: 'Rows: mine', model: list({ address: { view: 'mine', q: '', siteId: null, mode: 'list' }, rows: { items: viewRows('mine'), truncated: false, problem: null } }) },
    { id: 'rows-supplier', label: 'Rows: supplier NCRs', model: list({ address: { view: 'supplier', q: '', siteId: null, mode: 'list' }, rows: { items: viewRows('supplier'), truncated: false, problem: null } }) },
    { id: 'all-sites', label: 'Two sites, all of them: the Site column and filter', model: list({ sites: [...SITES, { ...SITES[0]!, id: '0190f0e2-2222-7000-8000-000000000002', code: 'DEMO-B', name: 'Demo second plant', locations: [] }] }) },
    { id: 'board', label: 'Board: lanes Open → Contained → Decided → Closed, cards with the decided bar', model: board(), note: 'Drag a card, or focus it and press Space, then ← → and Enter.' },
    { id: 'board-refused', label: 'Board: a move refused, the reason in words', model: board({ notice: { say: { key: 'board.notMoved', params: { number: 'NCR-DEMO-0037' } }, tone: 'danger', detail: ['No containment action is done yet: do one first (hold the stock, check the work in progress …).'] } }) },
    { id: 'board-moved', label: 'Board: a card moved (the receipt)', model: board({ notice: { say: { key: 'board.moved', params: { number: 'NCR-DEMO-0031', stage: 'DECIDED' } }, tone: 'success' } }) },
    { id: 'board-close', label: 'Board: a drop on Closed opens the closing signature (checklist met, note to write)', model: board({ close: closeModel() }) },
    { id: 'board-close-held', label: 'Close held: the checklist is not complete (what is missing in words)', model: board({ close: closeModel({ checks: checksSay([{ key: 'CARRIED_OUT', ok: false, words: 'x' }, { key: 'HOLDS', ok: true, words: 'x' }], { ...factsOfRecord(RECORD_READY), notCarriedOut: 2 }, 'CLOSED'), ready: false, note: 'Rework done.' }) }) },
    { id: 'board-close-step-up', label: 'Close: the fresh code (the e-signature)', model: board({ close: closeModel({ note: 'Every garment reworked or scrapped; the line briefed.', busy: true }), stepUp: { open: true, busy: false, sentence: 'close.stepUp', problem: null } }), note: 'The DS step-up dialog; its own field words are still English (named in the notes).' },
    { id: 'board-production', label: 'Board for a production manager: Closed held (no close right), moves allowed', model: board({}, 'production') },
    { id: 'board-read-only', label: 'Board read-only (sales): every move held with its reason', model: board({}, 'sales') },
    { id: 'board-offline', label: 'Board offline: moves wait', model: board({ live: 'offline' }) },
    { id: 'board-loading', label: 'Board loading', model: board({ lanes: { items: null, problem: null }, counts: null, asOf: null, live: 'connecting' }) },
    { id: 'board-empty', label: 'Board: no open NCRs', model: board({ lanes: { items: LANES.map((lane) => ({ ...lane, count: 0, cards: [] })), problem: null } }) },
    { id: 'new', label: 'New NCR by hand: the site, what is wrong, quantity, severity, defect, zone, owner', model: list({ dialog: newDialog({ draft: { ...EMPTY_DRAFT, siteId: SITES[0]!.id, title: 'Zip pull loose on a size run', quantityAffected: '6', severity: 'MINOR', zone: 'ZIP', ownerId: PEOPLE[1]!.id, photos: ['zip-pull.jpg'] } }) }) },
    { id: 'new-empty', label: 'New NCR: Create held until the site, what and how much are said', model: list({ dialog: newDialog() }) },
    { id: 'new-from', label: 'New NCR raised from an inspection (prefilled; the NCR it already has)', model: list({ dialog: newDialog({ from: { ...fromRecord, prefill: PREFILL, problem: null }, draft: draftOf(PREFILL, EMPTY_DRAFT) }) }) },
    { id: 'new-from-reading', label: 'New NCR from a record: still reading what it says', model: list({ dialog: newDialog({ from: { ...fromRecord, prefill: null, problem: null } }) }) },
    { id: 'new-from-failed', label: 'New NCR from a record: the prefill could not be read', model: list({ dialog: newDialog({ from: { ...fromRecord, prefill: null, problem: 'problem.unavailable' }, defects: 'failed' }) }) },
    { id: 'new-refused', label: 'New NCR refused (our words, the factory\'s sentence under them)', model: list({ dialog: newDialog({ draft: { ...EMPTY_DRAFT, siteId: SITES[0]!.id, title: 'Seam', quantityAffected: '4', severity: 'CRITICAL' }, notice: { say: { key: 'new.refused' }, tone: 'danger', detail: ['A zone of the garment map (FRONT, SLEEVE_L …).'] } }) }) },
    { id: 'selection', label: 'Selection: Assign owner 2 · Export 3 (CSV)', model: list({ selected: [ROWS[0]!.id, ROWS[1]!.id, ROWS[2]!.id] }) },
    { id: 'assign', label: 'Assign an owner to the NCRs picked', model: list({ selected: [ROWS[0]!.id, ROWS[2]!.id], dialog: { kind: 'assign', ids: [ROWS[0]!.id, ROWS[2]!.id], ownerId: PEOPLE[1]!.id, busy: false, notice: null } }) },
    { id: 'live-updates', label: 'Live: 3 updates waiting behind Show', model: list({ updates: 3 }), note: 'Rows never move under the cursor.' },
    { id: 'offline', label: 'Offline: the last copy with its time', model: list({ live: 'offline' }) },
    { id: 'truncated', label: 'At the most a list shows (the newest 200)', model: list({ rows: { items: Array.from({ length: 200 }, (_, index) => ({ ...ROWS[index % ROWS.length]!, id: `0190f0e2-5399-7000-8000-${String(index).padStart(12, '0')}`, number: `NCR-DEMO-${String(1000 + index)}` })), truncated: true, problem: null } }) },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows, x selects, the keys in the footer icon', model: list({ focusRow: 1, selected: [ROWS[1]!.id] }) },
    { id: 'shortcuts', label: 'The keys dialog (?)', model: list({ keysOpen: true }) },
    { id: 'inspector', label: 'Quality inspector: everything', model: list({}, 'inspector') },
    { id: 'production', label: 'Production manager: follows up, approves; closes nothing', model: list({}, 'production') },
    { id: 'sales', label: 'Sales: sees and raises; Assign held with its reason', model: list({ selected: [ROWS[0]!.id] }, 'sales') },
    { id: 'warehouse', label: 'Warehouse: sees and raises (from lots, hides, receipts)', model: list({}, 'warehouse') },
    { id: 'read-only', label: 'Read only: New NCR held with its reason', model: list({}, 'readOnly') },
    { id: 'no-permission', label: 'Maintenance: no permission (which permission, who grants it)', model: list({}, 'maintenance') },
    { id: 'loading', label: 'Loading', model: list({ rows: { items: null, truncated: false, problem: null }, counts: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The API didn't answer (never an empty list; tiles say —)", model: list({ rows: { items: null, truncated: false, problem: 'problem.unavailable' }, counts: null, asOf: null, live: 'offline' }) },
    { id: 'empty', label: 'First day: no NCR yet', model: list({ rows: { items: [], truncated: false, problem: null }, counts: { open: 0, containmentOverdue: 0, waitingDisposition: 0, criticalOpen: 0, closedThisMonth: 0, mine: 0 } }) },
    { id: 'filtered-empty', label: 'A row with nothing in it (Clear filters)', model: list({ address: { view: 'critical', q: 'zip', siteId: null, mode: 'list' }, rows: { items: [], truncated: false, problem: null } }) },
  ],
})
