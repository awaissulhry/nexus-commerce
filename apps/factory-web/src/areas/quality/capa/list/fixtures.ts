import { createElement, useEffect, useState } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PREFIX, ROLE_PERMISSIONS, type RoleCase } from '../../_shared/fixtures'
import type { CapaRow, CapaView } from '../api'
import { COMPANY_ID, COUNTS, CUSTOMERS, ME, NAMES, NOW, OPEN_ROWS, PEOPLE, ROWS, SOURCE_CHOICES, TODAY } from '../demo/fixtures'
import { capaCan, closeLinesOfRow, emptyNewDraft, HOME_ADDRESS, type CapaAddress } from '../model'
import type { CloseDialogModel } from '../view/CloseCapaDialog'
import type { CapaListModel, NewDialog } from './view-model'
import { CapaListView } from './view/CapaListView'

/**
 * SCR-146 Corrective actions — made-up data only (CAPA-DEMO-…, Demo names). Each case is a state the Owner reviews: the
 * list with its tiles, each tile pressed, the board by stage (one type at a time; a drop on Closed opens the close with
 * its checks), New CAPA by hand and opened from records, the role cases and every state of a list. In the browser the
 * rows, the mode, the selection and the drafts work for real.
 */

/** The permissions of a role template, plus Home (what that role's person holds). */
const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']
const ROLES = {
  owner: [...ROLE_PERMISSIONS.owner, 'quality.capa.view', 'quality.capa.manage', 'quality.ncr.view', 'quality.complaints.view'],
  inspector: template('quality_inspector'),
  production: template('production_manager'),
  sales: template('sales'),
  readOnly: template('read_only'),
  warehouse: template('warehouse'),
} as const
type Role = keyof typeof ROLES
const SHELL: Record<Role, RoleCase> = { owner: 'owner', inspector: 'inspector', production: 'production', sales: 'sales', readOnly: 'readOnly', warehouse: 'warehouse' }

interface DesignModel {
  readonly role: Role
  readonly model: CapaListModel
}

function viewRows(view: CapaView): CapaRow[] {
  return ROWS.filter((row) => {
    const open = row.status !== 'CLOSED' && row.status !== 'CANCELLED'
    if (view === 'open') return open
    if (view === 'mine') return open && (row.ownerId === ME || row.team.some((member) => member.userId === ME))
    if (view === 'overdue') return open && row.actions.overdue > 0
    if (view === 'closed') return row.status === 'CLOSED'
    if (view === 'cancelled') return row.status === 'CANCELLED'
    return true
  })
}

const list = (over: Partial<CapaListModel> = {}, role: Role = 'owner'): DesignModel => ({
  role,
  model: {
    prefix: PREFIX,
    me: ME,
    companyId: COMPANY_ID,
    today: TODAY,
    can: capaCan(ROLES[role]),
    address: HOME_ADDRESS,
    rows: { items: OPEN_ROWS, more: false, problem: null },
    counts: COUNTS,
    people: NAMES,
    asOf: NOW,
    live: 'live',
    updates: 0,
    notice: null,
    moving: null,
    dialog: null,
    close: null,
    ...over,
  },
})
const at = (address: Partial<CapaAddress>): CapaAddress => ({ ...HOME_ADDRESS, ...address })
const board = (over: Partial<CapaListModel> = {}, role: Role = 'owner', type: 'CAPA' | 'EIGHT_D' | null = null): DesignModel => list({ address: at({ mode: 'board', type }), ...over }, role)

const newDialog = (over: Partial<NewDialog> = {}): NewDialog => ({
  kind: 'new',
  draft: emptyNewDraft(TODAY, ME),
  people: PEOPLE,
  found: { q: '', items: null, problem: null },
  customers: { items: null, problem: null },
  from: null,
  busy: false,
  notice: null,
  ...over,
})
const closeOf = (row: CapaRow, over: Partial<CloseDialogModel> = {}): CloseDialogModel => ({ capaId: row.id, number: row.number, type: row.type, version: row.version, lines: closeLinesOfRow(row), note: '', busy: false, notice: null, offline: false, canClose: true, ...over })
const READY = ROWS.find((row) => row.status === 'CHECK')!
const EIGHT_D = ROWS[0]!

function CapaDesign({ model: design }: { model: DesignModel }) {
  const [address, setAddress] = useState(design.model.address)
  const [dialog, setDialog] = useState(design.model.dialog)
  const [close, setClose] = useState(design.model.close)
  useEffect(() => {
    setAddress(design.model.address)
    setDialog(design.model.dialog)
    setClose(design.model.close)
  }, [design])
  const items = design.model.rows.items && address.view !== design.model.address.view ? viewRows(address.view) : design.model.rows.items
  const model: CapaListModel = { ...design.model, address, rows: { ...design.model.rows, items }, dialog, close }
  return inShell(
    '/quality/capa',
    createElement(CapaListView, {
      model,
      actions: {
        onView: (view) => setAddress((current) => ({ ...current, view })),
        onMode: (mode) => setAddress((current) => ({ ...current, mode })),
        onType: (type) => setAddress((current) => ({ ...current, type })),
        onPriority: (priority) => setAddress((current) => ({ ...current, priority })),
        onClearFilters: () => setAddress(HOME_ADDRESS),
        onNew: () => setDialog(newDialog()),
        onDialogClose: () => setDialog(null),
        onNewDraft: (patch) => setDialog((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current)),
        onFindSources: (q) => setDialog((current) => (current ? { ...current, found: { q, items: SOURCE_CHOICES, problem: null } } : current)),
        onPickSource: (choice) => setDialog((current) => (current ? { ...current, draft: { ...current.draft, sources: [...current.draft.sources, { ...choice, held: null }] } } : current)),
        onDropSource: (recordId) => setDialog((current) => (current ? { ...current, draft: { ...current.draft, sources: current.draft.sources.filter((source) => source.recordId !== recordId) } } : current)),
        onFindCustomers: () => setDialog((current) => (current ? { ...current, customers: { items: CUSTOMERS, problem: null } } : current)),
        onSubmitNew: () => setDialog(null),
        onBoardMove: async (row, lane) => {
          if (lane === 'CLOSED') setClose(closeOf(row))
          return false
        },
        close: { onNote: (note) => setClose((current) => (current ? { ...current, note } : current)), onCancel: () => setClose(null), onSubmit: () => setClose(null) },
      },
    }),
    SHELL[design.role],
  )
}

const sourcesPicked = SOURCE_CHOICES.map((choice) => ({ ...choice, held: null }))

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-146',
  title: 'Corrective actions',
  view: CapaDesign,
  cases: [
    { id: 'list', label: 'Owner: the open CAPAs and 8Ds, the tiles, the rows and the list', model: list(), note: 'A tile is a saved row; the keys sit in the footer icon. Select rows: Copy N numbers (Export N appears with the export engine).' },
    { id: 'tile-overdue', label: 'Tile pressed: actions overdue', model: list({ address: at({ view: 'overdue' }), rows: { items: viewRows('overdue'), more: false, problem: null } }) },
    { id: 'tile-mine', label: 'Tile pressed: mine (owner, team or an open action of mine)', model: list({ address: at({ view: 'mine' }), rows: { items: viewRows('mine'), more: false, problem: null } }) },
    { id: 'rows-closed', label: 'Rows: closed', model: list({ address: at({ view: 'closed' }), rows: { items: viewRows('closed'), more: false, problem: null } }) },
    { id: 'rows-all', label: 'Rows: all (closed and cancelled included)', model: list({ address: at({ view: 'all' }), rows: { items: viewRows('all'), more: false, problem: null } }) },
    { id: 'type-8d', label: 'Type: 8D only, high priority', model: list({ address: at({ type: 'EIGHT_D', priority: 'HIGH' }), rows: { items: OPEN_ROWS.filter((row) => row.type === 'EIGHT_D' && row.priority === 'HIGH'), more: false, problem: null } }) },
    { id: 'board', label: 'Board (CAPA): Plan → Act → Check → Closed', model: board(), note: 'Drag a card, or focus it and press Space, then ← → and Enter. A drop on Closed opens the close.' },
    { id: 'board-8d', label: 'Board (8D): D1 … D8 → Closed', model: board({}, 'owner', 'EIGHT_D') },
    { id: 'board-close', label: 'Board: a drop on Closed — every check met, the closing words to write', model: board({ close: closeOf(READY) }) },
    { id: 'board-close-held', label: 'Close held: not at its last stage, actions still open (in words)', model: board({ close: closeOf(EIGHT_D, { note: 'Seam allowance fixed.' }) }, 'owner', 'EIGHT_D') },
    { id: 'board-close-refused', label: 'Close refused by the factory (our words for its codes)', model: board({ close: closeOf(READY, { note: 'Done.', notice: { say: { key: 'problem.held' }, tone: 'danger', lines: [{ key: 'refused.ACTIONS_OPEN' }] } }) }) },
    { id: 'board-moved', label: 'Board: a card moved (the receipt)', model: board({ notice: { say: { key: 'board.moved', params: { number: 'CAPA-DEMO-0006', stage: 'CHECK' } }, tone: 'success' } }) },
    { id: 'board-refused', label: 'Board: a move refused (changed meanwhile)', model: board({ notice: { say: { key: 'problem.stale' }, tone: 'danger' } }) },
    { id: 'board-read-only', label: 'Board for sales: every move held with its reason', model: board({}, 'sales') },
    { id: 'board-offline', label: 'Board offline: moves wait', model: board({ live: 'offline' }) },
    { id: 'new', label: 'New CAPA by hand: an 8D for a customer, two sources found and added', model: list({ dialog: newDialog({ draft: { ...emptyNewDraft(TODAY, ME), type: 'EIGHT_D', title: 'Zip breaks after a week', customerId: CUSTOMERS[0]!.id, customerLabel: `${CUSTOMERS[0]!.code} · ${CUSTOMERS[0]!.name}`, sources: sourcesPicked }, found: { q: 'zip', items: SOURCE_CHOICES, problem: null }, customers: { items: CUSTOMERS, problem: null } }) }) },
    { id: 'new-empty', label: 'New CAPA: Create held until the title is said', model: list({ dialog: newDialog() }) },
    { id: 'new-from', label: 'New CAPA opened from two NCRs (the address names them; one is escalated elsewhere)', model: list({ address: at({ isNew: true, from: { recordType: 'Nonconformance', ids: SOURCE_CHOICES.map((choice) => choice.recordId) } }), dialog: newDialog({ draft: { ...emptyNewDraft(TODAY, ME), title: SOURCE_CHOICES[0]!.title, sources: [sourcesPicked[0]!, { ...sourcesPicked[1]!, held: 'ESCALATED_ELSEWHERE' }] }, from: { reading: false, problem: null } }) }) },
    { id: 'new-from-reading', label: 'New CAPA from records: still reading them', model: list({ dialog: newDialog({ from: { reading: true, problem: null } }) }) },
    { id: 'new-refused', label: 'New CAPA refused (our words for the fields named)', model: list({ dialog: newDialog({ draft: { ...emptyNewDraft(TODAY, ME), title: 'Snap pulls out' }, notice: { say: { key: 'problem.fields' }, tone: 'danger', lines: [{ key: 'field.ownerId' }] } }) }) },
    { id: 'new-no-find', label: 'New CAPA for a person who sees no NCR or complaint (finding held with its reason)', model: list({ dialog: newDialog() }, 'production') },
    { id: 'selection', label: 'Selection: Copy 2 numbers', model: list({ selected: [OPEN_ROWS[0]!.id, OPEN_ROWS[1]!.id] }) },
    { id: 'live-updates', label: 'Live: 2 updates waiting behind Show', model: list({ updates: 2 }), note: 'Rows never move under the cursor.' },
    { id: 'more', label: 'More rows to show (the next page)', model: list({ rows: { items: OPEN_ROWS, more: true, problem: null } }) },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows, x selects, the keys in the footer icon', model: list({ focusRow: 1, selected: [OPEN_ROWS[1]!.id] }) },
    { id: 'shortcuts', label: 'The keys dialog (?)', model: list({ keysOpen: true }) },
    { id: 'inspector', label: 'Quality inspector: everything', model: list({}, 'inspector') },
    { id: 'production', label: 'Production manager: follows CAPAs up too', model: list({}, 'production') },
    { id: 'sales', label: 'Sales: reads; New CAPA held with its reason', model: list({}, 'sales') },
    { id: 'read-only', label: 'Read only: reads; New CAPA held', model: list({}, 'readOnly') },
    { id: 'no-permission', label: 'Warehouse: no permission (which permission, who grants it)', model: list({}, 'warehouse') },
    { id: 'offline', label: 'Offline: the last copy with its time, New CAPA held', model: list({ live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: list({ rows: { items: null, more: false, problem: null }, counts: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The API didn't answer (never an empty list; tiles say —)", model: list({ rows: { items: null, more: false, problem: 'problem.unavailable' }, counts: null, asOf: null, live: 'offline' }) },
    { id: 'empty', label: 'First day: no CAPA yet', model: list({ rows: { items: [], more: false, problem: null }, counts: { open: 0, actionsOverdue: 0, mine: 0 } }) },
    { id: 'filtered-empty', label: 'A row with nothing in it (Clear filters)', model: list({ address: at({ view: 'overdue', q: 'zip' }), rows: { items: [], more: false, problem: null } }) },
  ],
})
