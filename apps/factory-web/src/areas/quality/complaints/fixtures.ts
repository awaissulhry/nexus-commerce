import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { addressOf, blankLogDraft, triageDraftOf, type ComplaintsAddress } from './model'
import { canFor, complaintOf, COUNTS, CALM_COUNTS, CUSTOMERS, inShell, JACKET, ME, NEW_IDS, NOW, OPEN_ROWS, PEOPLE, PREFIX, ROWS, SAFETY_ALERT, SAFETY_ID, STYLES, TODAY, type RoleCase } from './demo/fixtures'
import type { ComplaintsListModel, LogModel, TriageModel } from './view-model'
import { ComplaintsView } from './view/ComplaintsView'

/**
 * Design cases of Quality › Complaints (SCR-113, the W2a part: the list, the safety banner, the tiles, Log complaint
 * and the triage DetailModal; the W1 PPE register keeps SCR-113 itself). Made-up data only (demo.ts).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly list: ComplaintsListModel
}

const address = (patch: Partial<ComplaintsAddress> = {}): ComplaintsAddress => ({ ...addressOf(null), ...patch })

function listModel(role: RoleCase, over: Partial<ComplaintsListModel> = {}): ComplaintsListModel {
  const view = over.address?.view ?? 'open'
  const items = view === 'all' ? ROWS : view === 'new' ? ROWS.filter((row) => row.status === 'NEW') : view === 'safety' ? ROWS.filter((row) => row.category === 'SAFETY') : OPEN_ROWS
  // The API drops the order's value for a reader without the price grain; the cases do the same.
  const priced = canFor(role).price ? items : items.map((row) => (row.order ? { ...row, order: { ...row.order, netAmount: undefined } } : row))
  return {
    prefix: PREFIX,
    can: canFor(role),
    address: address({ view }),
    rows: { items: priced, people: PEOPLE.owners, more: false, loadingMore: false, problem: null },
    counts: COUNTS,
    countsFailed: false,
    asOf: NOW,
    live: 'live',
    offline: false,
    updates: 0,
    today: TODAY,
    notice: null,
    triage: null,
    log: null,
    acknowledge: null,
    ...over,
  }
}

export function triageModel(id: string, over: Partial<TriageModel> = {}, role: RoleCase = 'owner'): TriageModel {
  const base = ROWS.find((row) => row.id === id)!
  const complaint = complaintOf(base)
  const may = canFor(role)
  const value = may.manage ? complaint : { ...complaint, actions: complaint.actions.map((entry) => (entry.action === 'triage' ? { ...entry, allowed: false, held: 'NO_PERMISSION' as const } : entry)) }
  return {
    queue: NEW_IDS,
    id,
    loaded: { status: 'ready', value },
    photos: [{ id: 'demo-photo-1', name: 'pocket.jpg', src: null }],
    draft: triageDraftOf(complaint, ME, PEOPLE.owners),
    people: PEOPLE,
    peopleProblem: null,
    styles: STYLES,
    showProblems: false,
    busy: false,
    problem: null,
    confirmSafety: false,
    today: TODAY,
    offline: false,
    ...over,
  }
}

export function logModel(over: Partial<LogModel> = {}): LogModel {
  return {
    draft: blankLogDraft(TODAY),
    customers: { items: CUSTOMERS, problem: null },
    contacts: null,
    orders: null,
    shipments: null,
    returns: null,
    styles: STYLES,
    preview: null,
    previewing: false,
    showProblems: false,
    busy: false,
    problem: null,
    today: TODAY,
    canPhotos: true,
    ...over,
  }
}

/** The list with its own address, triage draft and log draft (tiles, menus, the dialogs' fields work in review). */
function ComplaintsDesign({ model }: { model: DesignModel }) {
  const [list, setList] = useState<ComplaintsListModel>(model.list)
  useEffect(() => setList(model.list), [model.list])
  return inShell(
    '/quality/complaints',
    createElement(ComplaintsView, {
      model: list,
      actions: {
        onAddress: (patch) => setList((current) => ({ ...current, address: { ...current.address, ...patch } })),
        onClearFilters: () => setList((current) => ({ ...current, address: address() })),
        onTriageDraft: (patch) => setList((current) => (current.triage ? { ...current, triage: { ...current.triage, draft: { ...current.triage.draft, ...patch } } } : current)),
        onTriageClose: () => setList((current) => ({ ...current, triage: null })),
        onTriageGo: (id) => setList((current) => ({ ...current, triage: triageModel(id) })),
        onTriageCancelSafety: () => setList((current) => (current.triage ? { ...current, triage: { ...current.triage, confirmSafety: false } } : current)),
        onLog: () => setList((current) => ({ ...current, log: logModel() })),
        onLogDraft: (patch) => setList((current) => (current.log ? { ...current, log: { ...current.log, draft: { ...current.log.draft, ...patch } } } : current)),
        onLogClose: () => setList((current) => ({ ...current, log: null })),
        onAcknowledge: (alert) => setList((current) => ({ ...current, acknowledge: { alert, busy: false, problem: null } })),
        onAcknowledgeClose: () => setList((current) => ({ ...current, acknowledge: null })),
      },
    }),
    model.role,
  )
}

const safetyDraft = (id: string) => {
  const model = triageModel(id)
  return { ...model, draft: { ...model.draft, category: 'SAFETY' as const, severity: 'CRITICAL' as const, styleId: JACKET.id } }
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-113-complaints',
  title: 'Complaints (W2a: list, safety banner, log, triage)',
  view: ComplaintsDesign,
  cases: [
    {
      id: 'owner',
      label: 'Owner: the open complaints, the safety banner (Acknowledge)',
      model: { role: 'owner', list: listModel('owner') },
      note: 'One safety complaint the owner has not acknowledged: the banner stays until then. Tiles are named saved filters.',
    },
    {
      id: 'inspector',
      label: 'Quality inspector: triages; Acknowledge held with its reason',
      model: { role: 'inspector', list: listModel('inspector') },
      note: 'Only the owner acknowledges a safety alert (quality.complaints.acknowledge): the button stays focusable and says why.',
    },
    {
      id: 'sales',
      label: 'Sales: logs complaints; Triage held with its reason',
      model: { role: 'sales', list: listModel('sales') },
    },
    {
      id: 'read-only',
      label: 'Read-only: sees, changes nothing (each step held with the permission)',
      model: { role: 'readOnly', list: listModel('readOnly') },
    },
    { id: 'no-permission', label: 'No permission: which one and who grants it', model: { role: 'none', list: listModel('none') } },
    { id: 'tile-new', label: 'Tile pressed: new to triage', model: { role: 'owner', list: listModel('owner', { address: address({ view: 'new' }) }) } },
    { id: 'tile-safety', label: 'Tile pressed: safety – open', model: { role: 'owner', list: listModel('owner', { address: address({ view: 'safety' }) }) } },
    { id: 'all', label: 'Rows: all complaints (closed too)', model: { role: 'owner', list: listModel('owner', { address: address({ view: 'all' }) }) } },
    {
      id: 'filtered',
      label: 'Filtered: no row matches (Clear filters)',
      model: { role: 'owner', list: listModel('owner', { address: address({ q: 'zzz', category: 'FIT' }), rows: { items: [], people: [], more: false, loadingMore: false, problem: null } }) },
    },
    {
      id: 'empty',
      label: 'First day: no complaints',
      model: { role: 'owner', list: listModel('owner', { rows: { items: [], people: [], more: false, loadingMore: false, problem: null }, counts: { ...CALM_COUNTS, tiles: { new: 0, safety: 0, dueSoon: 0, open: 0, answeredMonth: 0 } } }) },
    },
    {
      id: 'loading',
      label: 'Loading',
      model: { role: 'owner', list: listModel('owner', { rows: { items: null, people: [], more: false, loadingMore: false, problem: null }, counts: null, asOf: null, live: 'connecting' }) },
    },
    {
      id: 'error',
      label: "The API didn't answer (never drawn as an empty list)",
      model: { role: 'owner', list: listModel('owner', { rows: { items: null, people: [], more: false, loadingMore: false, problem: 'quality:problem.unavailable' }, counts: null, countsFailed: true, asOf: null, live: 'offline' }) },
    },
    {
      id: 'offline',
      label: 'Offline: the last copy with its time, writes held',
      model: { role: 'owner', list: listModel('owner', { live: 'offline', offline: true }) },
    },
    { id: 'live-updates', label: 'Live: 2 updates waiting behind Show', model: { role: 'owner', list: listModel('owner', { updates: 2 }) } },
    { id: 'more', label: 'More than one page (Show more)', model: { role: 'owner', list: listModel('owner', { rows: { items: OPEN_ROWS, people: [], more: true, loadingMore: false, problem: null } }) } },
    {
      id: 'selection',
      label: 'Selection: Triage 2, Copy numbers, Export (CSV)',
      model: { role: 'owner', list: listModel('owner', { selected: [...NEW_IDS, SAFETY_ID] }) },
    },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows, x selects; keys in the footer icon', model: { role: 'owner', list: listModel('owner', { focusRow: 1 }) } },
    { id: 'shortcuts', label: 'All shortcuts (?)', model: { role: 'owner', list: listModel('owner', { helpOpen: true }) } },
    {
      id: 'acknowledge',
      label: 'The owner acknowledges the safety alert (an optional note)',
      model: { role: 'owner', list: listModel('owner', { acknowledge: { alert: SAFETY_ALERT, busy: false, problem: null } }) },
    },
    {
      id: 'triage',
      label: 'Triage (new complaint, J / K walk the queue)',
      model: { role: 'owner', list: listModel('owner', { address: address({ view: 'new' }), triage: triageModel(NEW_IDS[0]!) }) },
      note: 'Category as radio cards, severity, owner, answer due (suggested 10 working days); Save and next ⌘↵.',
    },
    {
      id: 'triage-problems',
      label: 'Triage: Save pressed with things missing',
      model: {
        role: 'owner',
        list: listModel('owner', { triage: triageModel(NEW_IDS[1]!, { draft: { category: 'SAFETY', severity: null, ownerId: '', answerDueOn: '', styleId: '', risk: 'ASSESSING', note: '' }, showProblems: true }) }),
      },
      note: 'A safety complaint without a style: the PPE register keeps an entry per style.',
    },
    {
      id: 'triage-safety-confirm',
      label: 'Triage Safety: the confirm names who is told and what happens',
      model: { role: 'owner', list: listModel('owner', { triage: { ...safetyDraft(NEW_IDS[0]!), confirmSafety: true } }) },
      note: 'Told now: the owner and quality by name; the PPE register entry; nothing to the customer or an authority; no stock held by this step.',
    },
    {
      id: 'triage-held',
      label: 'Triage held: a sales person opens a new complaint',
      model: { role: 'sales', list: listModel('sales', { triage: triageModel(NEW_IDS[0]!, {}, 'sales') }) },
    },
    {
      id: 'triage-refused',
      label: 'Triage refused: someone changed it in the meantime',
      model: { role: 'owner', list: listModel('owner', { triage: triageModel(NEW_IDS[0]!, { problem: 'refusal.conflict' }) }) },
    },
    { id: 'log', label: 'Log complaint (blank)', model: { role: 'owner', list: listModel('owner', { log: logModel() }) } },
    {
      id: 'log-found',
      label: 'Log complaint: a scanned serial found the garment, and another open complaint',
      model: {
        role: 'owner',
        list: listModel('owner', {
          log: logModel({
            draft: { ...blankLogDraft(TODAY), partyId: CUSTOMERS[0]!.id, serial: 'S-DEMO-000431', styleId: JACKET.id, size: '50', batchNumber: 'B-DEMO-0142', description: 'The zip of the left pocket broke (made-up).' },
            orders: [{ id: 'demo-o1', number: 'SO-DEMO-001' }],
            shipments: [{ id: 'demo-s1', number: 'SH-DEMO-001' }],
            returns: [],
            contacts: [{ id: 'demo-c1', name: 'Dario Demo', email: 'dario.demo@example.com', status: 'ACTIVE' }],
            preview: {
              ok: true,
              problems: [],
              warnings: [],
              draft: { companyId: null, partyId: CUSTOMERS[0]!.id, styleId: JACKET.id, size: '50', batchNumber: 'B-DEMO-0142', shipmentId: 'demo-s1', salesOrderId: 'demo-o1' },
              garment: { madeOn: '2026-10-02', workOrderNumber: 'WO-DEMO-0142', batchNumber: 'B-DEMO-0142', shipment: { id: 'demo-s1', number: 'SH-DEMO-001' }, forThisCustomer: true },
              others: [{ id: SAFETY_ID, number: 'CMP-DEMO-0012', status: 'TRIAGED', receivedAt: NOW, summary: 'The shoulder protector moved in a fall (made-up)' }],
            },
          }),
        }),
      },
    },
    {
      id: 'log-problems',
      label: 'Log complaint: pressed with the customer and the words missing',
      model: { role: 'owner', list: listModel('owner', { log: logModel({ showProblems: true }) }) },
    },
    {
      id: 'log-no-customers',
      label: 'Log complaint: a role that cannot list customers (scan the serial)',
      model: { role: 'inspector', list: listModel('inspector', { log: logModel({ customers: { items: null, problem: 'log.customerNoRight' }, styles: null, canPhotos: false }) }) },
    },
    {
      id: 'notice',
      label: 'A receipt after a safety triage',
      model: { role: 'owner', list: listModel('owner', { notice: { tone: 'warning', words: { key: 'done.safetyRaised', params: { number: 'CMP-DEMO-0012', reference: 'REG-DEMO-0007' } } } }) },
    },
  ],
})
