import { createElement, useEffect, useState } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../../_shared/hooks'
import { inShell, PREFIX, ROLE_PERMISSIONS, uid, type RoleCase } from '../../_shared/fixtures'
import type { EscalatePreview, NcrSummary } from '../api'
import { COMPANY_ID, CONTAINMENT_SETTINGS, COUNTS, DEFECTS, LANES, NOW, PEOPLE, PREFILL, PREFILL_BUNDLE, PREFILL_DEFECTS, RECORD_READY, ROWS, SITES } from '../demo/fixtures'
import { checksSay, containmentDraftOf, factsOfRecord, ncrCan, ncrQueryOf, type NcrCan, type NcrView } from '../model'
import { escalateModelOf, withPreview, type EscalateModel } from '../view/EscalateDialog'
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
  /** B-W2b-113: the owner with the cost grain (the Cost column). */
  ownerCost: [...ROLE_PERMISSIONS.owner, 'money.cost'],
} as const
type Role = keyof typeof ROLES
/** The nearest shell role case (the navigation drawn around the page). */
const SHELL: Record<Role, RoleCase> = { owner: 'owner', inspector: 'inspector', production: 'production', sales: 'sales', warehouse: 'readOnly', readOnly: 'readOnly', maintenance: 'readOnly', ownerCost: 'owner' }

// ---- B-W2b-113: the CAPA and Cost columns, Escalate to CAPA (made up) -------------------------------------------------------

const CAPA_OPEN = { id: uid('5390', 1), number: 'CAPA-DEMO-0004', status: 'ACT' as const }
const EIGHT_D = { id: uid('5390', 2), number: '8D-DEMO-0002', status: 'D3' as const }
/** The rows as the API sends them to a reader with the cost grain: the CAPA each one names, its cost (minor units). */
const COST_OF: readonly (number | null)[] = [24_700, null, 3_500, 12_050, 0, 98_000]
const ROWS_W2B: NcrSummary[] = ROWS.map((row, index) => ({ ...row, capa: index === 2 ? CAPA_OPEN : index === 4 ? EIGHT_D : null, cost: COST_OF[index] ?? null }))
/** The same rows for a reader without the grain: the API leaves the cost out. */
const ROWS_NO_COST: NcrSummary[] = ROWS_W2B.map(({ cost: _cost, ...row }) => row)
const openRowsOf = (rows: readonly NcrSummary[]) => rows.filter((row) => row.stage !== 'CLOSED' && row.stage !== 'CANCELLED')

const record = (row: NcrSummary, over: Partial<EscalatePreview['records'][number]> = {}): EscalatePreview['records'][number] => ({
  recordType: 'Nonconformance',
  recordId: row.id,
  number: row.number,
  title: row.title,
  companyId: COMPANY_ID,
  state: row.stage,
  reasons: row.severity === 'CRITICAL' ? ['CRITICAL'] : row.source === 'COMPLAINT' || row.source === 'RETURN' ? ['CUSTOMER'] : [],
  escalatedTo: null,
  problem: null,
  ...over,
})
const PREVIEW: EscalatePreview = {
  records: [record(ROWS_W2B[0]!, { reasons: ['CRITICAL', 'REPEAT_DEFECT'] }), record(ROWS_W2B[1]!)],
  companyId: COMPANY_ID,
  sameCompany: true,
  ready: true,
  capas: [
    { id: CAPA_OPEN.id, number: CAPA_OPEN.number, title: 'Open seams on the shoulder of the rider jacket', type: 'CAPA', status: 'ACT', customer: null, version: 3 },
    { id: EIGHT_D.id, number: EIGHT_D.number, title: 'Protector pocket missing on a size run', type: 'EIGHT_D', status: 'D3', customer: { id: uid('5390', 9), code: 'DEMO-C1', name: 'Demo Moto Srl' }, version: 5 },
  ],
  mayOpen: true,
  mayView: true,
  asOf: NOW,
}
const PREVIEW_HELD: EscalatePreview = {
  ...PREVIEW,
  ready: false,
  records: [
    record(ROWS_W2B[0]!, { reasons: ['CRITICAL'] }),
    record(ROWS_W2B[2]!, { escalatedTo: { capaId: CAPA_OPEN.id, number: CAPA_OPEN.number, status: 'ACT' }, problem: { path: 'held/ESCALATED_ELSEWHERE', message: 'x' } }),
    record({ ...ROWS_W2B[1]!, number: 'NCR-DEMO-0019', stage: 'CANCELLED' }, { problem: { path: 'held/NCR_CANCELLED', message: 'x' } }),
  ],
}
const OPENED = new Date(NOW)
const escalateOf = (preview: EscalatePreview | null, over: Partial<EscalateModel> = {}): EscalateModel => {
  const ncrs = (preview?.records ?? PREVIEW.records).map((entry) => ({ id: entry.recordId, number: entry.number }))
  const opened = escalateModelOf(ncrs, OPENED)
  return { ...(preview ? withPreview(opened, preview) : opened), ...over }
}

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

const newDialog = (over: Partial<Extract<ListDialog, { kind: 'new' }>> = {}): ListDialog => ({ kind: 'new', draft: EMPTY_DRAFT, from: null, defects: DEFECTS, containment: { hours: 24 }, busy: false, notice: null, ...over })
const fromRecord = { recordType: 'Inspection', recordId: PREFILL.fromId }
/** B-W2b-17: the containment-time dialog. */
const containmentTime = (over: Partial<Extract<ListDialog, { kind: 'containmentTime' }>> = {}): ListDialog => ({ kind: 'containmentTime', answer: CONTAINMENT_SETTINGS, problem: null, draft: containmentDraftOf(CONTAINMENT_SETTINGS.settings), busy: false, notice: null, ...over })

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
  const [escalate, setEscalate] = useState(design.model.escalate ?? null)
  useEffect(() => {
    setAddress(design.model.address)
    setDialog(design.model.dialog)
    setClose(design.model.close)
    setEscalate(design.model.escalate ?? null)
  }, [design])
  const model: NcrListModel = {
    ...design.model,
    address,
    rows: design.model.rows.items && address.view !== design.model.address.view ? { items: viewRows(address.view), truncated: false, problem: null } : design.model.rows,
    dialog,
    close,
    escalate,
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
        onContainmentTime: () => setDialog(containmentTime({ answer: { ...CONTAINMENT_SETTINGS, mayChange: design.model.can.manage } })),
        onContainmentDraft: (patch) => setDialog((current) => (current?.kind === 'containmentTime' ? { ...current, draft: { ...current.draft, ...patch } } : current)),
        onSubmitContainmentTime: () => setDialog(null),
        onDialogClose: () => setDialog(null),
        onBoardMove: async (card, to) => {
          if (to === 'CLOSED') {
            setClose(closeModel({ ncrId: card.id, number: card.number }))
            return false
          }
          return false
        },
        close: { onNote: (note: string) => setClose((current) => (current ? { ...current, note } : current)), onCancel: () => setClose(null), onSubmit: () => setClose(null) },
        // B-W2b-113: the escalate dialog works in the browser on made-up data (the preview of the rows picked).
        onEscalate: (ncrs) => {
          const rows = design.model.rows.items ?? []
          const picked = rows.filter((row) => ncrs.some((ncr) => ncr.id === row.id))
          setEscalate(escalateOf({ ...PREVIEW, records: picked.map((row) => record(row)) }))
        },
        escalate: {
          onChange: (patch) => setEscalate((current) => (current ? { ...current, ...patch } : current)),
          onCancel: () => setEscalate(null),
          onSubmit: () => setEscalate(null),
        },
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
    // ---- B-W2b-17 ------------------------------------------------------------------------------------------------------
    { id: 'w2b-new-from-defects', label: 'W2b New NCR from 2 picked defect lines of an inspection (the lines it took; its title in the reader\'s words)', model: list({ dialog: newDialog({ from: { ...fromRecord, prefill: PREFILL_DEFECTS, problem: null }, draft: draftOf(PREFILL_DEFECTS, EMPTY_DRAFT), containment: { hours: 48 } }) }), note: 'The address carries &defects=<id>,<id> (Inspections › Defects › Create NCR from N defects).' },
    { id: 'w2b-new-title-parts', label: 'W2b New NCR from a bundle: the prefilled title worded from its parts in the reader\'s language', model: list({ dialog: newDialog({ from: { recordType: 'Bundle', recordId: PREFILL_BUNDLE.fromId, prefill: PREFILL_BUNDLE, problem: null }, draft: draftOf(PREFILL_BUNDLE, EMPTY_DRAFT) }) }) },
    { id: 'w2b-new-defects-gone', label: 'W2b New NCR from picked lines no longer on the inspection (said in words)', model: list({ dialog: newDialog({ from: { ...fromRecord, prefill: null, problem: 'new.defectsGone' }, containment: { hours: 24 } }) }) },
    { id: 'w2b-new-containment', label: 'W2b New NCR by hand: the containment due time it gets (the company\'s containment time, 2 days)', model: list({ dialog: newDialog({ draft: { ...EMPTY_DRAFT, siteId: SITES[0]!.id, title: 'Zip pull loose on a size run', quantityAffected: '6', severity: 'MINOR' }, containment: { hours: 48 } }) }) },
    { id: 'w2b-new-containment-reading', label: 'W2b New NCR: the containment time still being read', model: list({ dialog: newDialog({ containment: null }) }) },
    { id: 'w2b-new-containment-failed', label: 'W2b New NCR: the containment time could not be read (the factory sets it at Create)', model: list({ dialog: newDialog({ containment: 'failed' }) }) },
    { id: 'w2b-containment-time', label: 'W2b Containment time…: the company\'s own 48 hours', model: list({ dialog: containmentTime() }), note: 'Opened from the page\'s ⋯ menu.' },
    { id: 'w2b-containment-time-change', label: 'W2b Containment time: changed to 8 hours (Save allowed)', model: list({ dialog: containmentTime({ draft: { follow: false, hours: '8' } }) }) },
    { id: 'w2b-containment-time-follow', label: 'W2b Containment time: follow the time of every company', model: list({ dialog: containmentTime({ draft: { follow: true, hours: '48' } }) }) },
    { id: 'w2b-containment-time-invalid', label: 'W2b Containment time: hours out of range (Save held with the reason)', model: list({ dialog: containmentTime({ draft: { follow: false, hours: '900' } }) }) },
    { id: 'w2b-containment-time-held', label: 'W2b Containment time for a production manager: read only, Save held (quality.settings.manage)', model: list({ dialog: containmentTime({ answer: { ...CONTAINMENT_SETTINGS, mayChange: false } }) }, 'production') },
    { id: 'w2b-containment-time-tenant', label: 'W2b Containment time: no own time, the tenant\'s 24 hours in force', model: list({ dialog: containmentTime({ answer: { settings: { companyId: CONTAINMENT_SETTINGS.settings.companyId, inForce: { hours: 24, source: 'TENANT' }, own: null, version: 0 }, mayChange: true }, draft: { follow: true, hours: '24' } }) }) },
    { id: 'w2b-containment-time-offline', label: 'W2b Containment time offline: Save held', model: list({ live: 'offline', dialog: containmentTime({ draft: { follow: false, hours: '8' } }) }) },
    { id: 'w2b-containment-time-reading', label: 'W2b Containment time: reading', model: list({ dialog: containmentTime({ answer: null }) }) },
    { id: 'w2b-containment-time-error', label: 'W2b Containment time: could not be read (Try again)', model: list({ dialog: containmentTime({ answer: null, problem: 'problem.unavailable' }) }) },
    { id: 'w2b-containment-time-refused', label: 'W2b Containment time: Save refused (changed meanwhile, read again)', model: list({ dialog: containmentTime({ draft: { follow: false, hours: '8' }, notice: { say: { key: 'problem.stale' }, tone: 'danger' } }) }) },
    { id: 'w2b-assign-done', label: 'W2b Assign owner: one command for 3 NCRs of two sites (done)', model: list({ notice: { say: { key: 'list.assigned', params: { count: 3 } }, tone: 'success' } }) },
    { id: 'w2b-assign-refused', label: 'W2b Assign owner refused: each refused NCR in words, nothing changed', model: list({ selected: [ROWS[0]!.id, ROWS[1]!.id, ROWS[2]!.id], dialog: { kind: 'assign', ids: [ROWS[0]!.id, ROWS[1]!.id, ROWS[2]!.id], ownerId: PEOPLE[1]!.id, busy: false, notice: { say: { key: 'assign.refused.title', params: { count: 2, total: 3 } }, tone: 'danger', lines: [{ key: 'assign.refused.stale', params: { number: ROWS[1]!.number } }, { key: 'assign.refused.noRight', params: { number: ROWS[2]!.number } }] } } }) },
    { id: 'w2b-assign-offline', label: 'W2b Assign owner offline: held with the reason', model: list({ live: 'offline', selected: [ROWS[0]!.id, ROWS[1]!.id] }) },
    // ---- B-W2b-113: the CAPA and Cost columns, Escalate to CAPA --------------------------------------------------------
    { id: 'cost-column', label: 'W2b-113 Owner with the cost grain: the CAPA column and the Cost column (minor units in euro)', model: list({ rows: { items: openRowsOf(ROWS_W2B), truncated: false, problem: null } }, 'ownerCost'), note: 'The Cost column shows only for a reader with the cost grain (money.cost); — when the NCR has no cost line yet.' },
    { id: 'no-cost', label: 'W2b-113 Quality inspector without the cost grain: no Cost column (the API leaves the amount out)', model: list({ rows: { items: openRowsOf(ROWS_NO_COST), truncated: false, problem: null } }, 'inspector') },
    { id: 'capa-column', label: 'W2b-113 The CAPA column: the CAPA each NCR is escalated to (a link), — for none', model: list({ rows: { items: openRowsOf(ROWS_NO_COST), truncated: false, problem: null } }) },
    { id: 'escalate-selection', label: 'W2b-113 Selection: Escalate 2 to one CAPA (the third names a CAPA already)', model: list({ rows: { items: openRowsOf(ROWS_NO_COST), truncated: false, problem: null }, selected: [ROWS_W2B[0]!.id, ROWS_W2B[1]!.id, ROWS_W2B[2]!.id] }), note: 'Key e escalates the rows picked, else the focused row; the key sits in the footer icon.' },
    { id: 'escalate', label: 'W2b-113 Escalate to CAPA: link to an open CAPA (the rule that suggests each NCR)', model: list({ rows: { items: openRowsOf(ROWS_NO_COST), truncated: false, problem: null }, escalate: escalateOf(PREVIEW, { capaId: CAPA_OPEN.id }) }) },
    { id: 'escalate-new', label: 'W2b-113 Escalate to CAPA: start a new one (title from the first NCR, due in 30 days)', model: list({ rows: { items: openRowsOf(ROWS_NO_COST), truncated: false, problem: null }, escalate: escalateOf(PREVIEW, { mode: 'new', type: 'EIGHT_D' }) }) },
    { id: 'escalate-held', label: 'W2b-113 Escalate to CAPA: one NCR escalated elsewhere, one cancelled — only the rest goes', model: list({ rows: { items: openRowsOf(ROWS_NO_COST), truncated: false, problem: null }, escalate: escalateOf(PREVIEW_HELD) }) },
    { id: 'escalate-pick', label: 'W2b-113 Escalate to CAPA: the button held until the open CAPA is picked', model: list({ rows: { items: openRowsOf(ROWS_NO_COST), truncated: false, problem: null }, escalate: escalateOf(PREVIEW) }) },
    { id: 'escalate-no-right', label: 'W2b-113 Escalate to CAPA for a person without quality.capa.manage: held with the reason', model: list({ rows: { items: openRowsOf(ROWS_NO_COST), truncated: false, problem: null }, escalate: escalateOf({ ...PREVIEW, mayOpen: false, capas: [] }) }, 'production') },
    { id: 'escalate-loading', label: 'W2b-113 Escalate to CAPA: reading what each NCR would bring', model: list({ rows: { items: openRowsOf(ROWS_NO_COST), truncated: false, problem: null }, escalate: escalateOf(null) }) },
    { id: 'escalate-error', label: 'W2b-113 Escalate to CAPA: the preview could not be read (Try again)', model: list({ rows: { items: openRowsOf(ROWS_NO_COST), truncated: false, problem: null }, escalate: escalateOf(null, { preview: { status: 'error', problem: 'problem.unavailable' } }) }) },
    { id: 'escalate-refused', label: 'W2b-113 Escalate to CAPA refused (our words, the factory\'s sentence under them)', model: list({ rows: { items: openRowsOf(ROWS_NO_COST), truncated: false, problem: null }, escalate: escalateOf(PREVIEW, { capaId: CAPA_OPEN.id, notice: { say: { key: 'escalate.refusedHeld' }, tone: 'danger', detail: ['NCR-DEMO-0036 is escalated to CAPA-DEMO-0004 already.'] } }) }) },
    { id: 'escalate-done', label: 'W2b-113 Escalated: 2 NCRs now name CAPA-DEMO-0004 (the receipt with its link)', model: list({ rows: { items: openRowsOf(ROWS_NO_COST), truncated: false, problem: null }, notice: { say: { key: 'escalate.done', params: { count: 2, capa: CAPA_OPEN.number } }, tone: 'success', link: { href: `${PREFIX}/records/Capa/${CAPA_OPEN.id}`, label: { key: 'escalate.openCapa', params: { capa: CAPA_OPEN.number } } } } }) },
  ],
})
