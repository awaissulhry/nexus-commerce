import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { CaseRow, CaseView } from '../api'
import { canFor, COMPANY_ID, CONTACTS, COUNTS, CUSTOMERS, inShell, ME, NOW, OPEN_ROWS, PEOPLE, PREFIX, PREVIEW, RIDER_PREVIEW, ROWS, TODAY, type RoleCase } from '../demo/fixtures'
import { emptyNewDraft, HOME_ADDRESS, type ListAddress } from '../model'
import type { NewCaseModel, ServiceListModel } from './view-model'
import { ServiceListView } from './view/ServiceListView'

/**
 * SCR-217 Warranty & service — made-up data only (SVC-DEMO-…, Demo names). Each case is a state the Owner reviews: the list with
 * its tiles and notices, each tile pressed, the saved rows, the filters as chips, New case (empty, a serial of ours with its
 * warranty check and a possible duplicate, a rider, reading, refused, the camera), the role cases and every state of a list.
 * In the browser the tiles, rows, filters, selection and the draft work for real.
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: ServiceListModel
}

function viewRows(view: CaseView): CaseRow[] {
  return ROWS.filter((row) => {
    const open = row.status !== 'CLOSED'
    if (view === 'open') return open
    if (view === 'new') return row.status === 'NEW'
    if (view === 'waitingCustomer') return row.status === 'WAITING_CUSTOMER'
    if (view === 'waitingPart') return row.status === 'WAITING_PART'
    if (view === 'waiting') return row.status === 'WAITING_CUSTOMER' || row.status === 'WAITING_PART'
    if (view === 'mine') return open && row.ownerId === ME
    if (view === 'closed') return !open
    return true
  })
}

const at = (address: Partial<ListAddress>): ListAddress => ({ ...HOME_ADDRESS, ...address })
const list = (over: Partial<ServiceListModel> = {}, role: RoleCase = 'owner'): DesignModel => ({
  role,
  model: {
    prefix: PREFIX,
    me: ME,
    companyId: COMPANY_ID,
    today: TODAY,
    can: canFor(role),
    address: HOME_ADDRESS,
    rows: { items: OPEN_ROWS, more: false, problem: null },
    counts: COUNTS,
    countsFailed: false,
    people: PEOPLE,
    asOf: NOW,
    live: 'live',
    updates: 0,
    notice: null,
    dismissed: [],
    newCase: null,
    ...over,
  },
})
const rowsOf = (view: CaseView) => ({ items: viewRows(view), more: false, problem: null })

const newCase = (over: Partial<NewCaseModel> = {}): NewCaseModel => ({
  draft: emptyNewDraft(ME),
  customers: { items: CUSTOMERS, problem: null },
  contacts: { items: null, problem: null },
  owners: PEOPLE,
  preview: { reading: false, value: null, problem: null },
  busy: false,
  offline: false,
  notice: null,
  scanning: false,
  ...over,
})
const filled = newCase({
  draft: { ...emptyNewDraft(ME), partyId: CUSTOMERS[0]!.id, contactId: CONTACTS[0]!.id, serial: 'DEMO-SN-0001', size: '52', problem: 'The zip of the left pocket came off after two rides.', customerWants: 'REPAIR', notifyCustomer: true },
  contacts: { items: CONTACTS, problem: null },
  preview: { reading: false, value: PREVIEW, problem: null },
})

function ServiceDesign({ model: design }: { model: DesignModel }) {
  const [address, setAddress] = useState(design.model.address)
  const [dialog, setDialog] = useState(design.model.newCase)
  useEffect(() => {
    setAddress(design.model.address)
    setDialog(design.model.newCase)
  }, [design])
  const items = design.model.rows.items && address.view !== design.model.address.view ? viewRows(address.view) : design.model.rows.items
  const model: ServiceListModel = { ...design.model, address, rows: { ...design.model.rows, items }, newCase: dialog }
  return inShell(
    '/sales/service',
    createElement(ServiceListView, {
      model,
      actions: {
        onAddress: (patch) => setAddress((current) => ({ ...current, ...patch })),
        onClearFilters: () => setAddress(HOME_ADDRESS),
        onNew: () => setDialog(newCase()),
        newCase: {
          onDraft: (patch) => setDialog((current) => (current ? { ...current, draft: { ...current.draft, ...patch }, contacts: patch.partyId ? { items: CONTACTS, problem: null } : current.contacts } : current)),
          onSubmit: () => setDialog(null),
          onClose: () => setDialog(null),
          onScan: (open) => setDialog((current) => (current ? { ...current, scanning: open } : current)),
          onScanned: (code) => setDialog((current) => (current ? { ...current, scanning: false, draft: { ...current.draft, serial: code } } : current)),
          scanner: null,
        },
      },
    }),
    design.role,
  )
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-217',
  title: 'Warranty & service',
  view: ServiceDesign,
  cases: [
    { id: 'list', label: 'Owner: the open cases, the tiles, the notices and the list', model: list(), note: 'A tile is a saved row; its chip lands in the filter row. The keys sit in the footer icon. Select rows: Copy N numbers and Export N.' },
    { id: 'tile-new', label: 'Tile pressed: New (its chip in the filter row)', model: list({ address: at({ view: 'new' }), rows: rowsOf('new') }) },
    { id: 'tile-waiting-customer', label: 'Tile pressed: Waiting for the customer', model: list({ address: at({ view: 'waitingCustomer' }), rows: rowsOf('waitingCustomer') }) },
    { id: 'tile-waiting-part', label: 'Tile pressed: Waiting for a part', model: list({ address: at({ view: 'waitingPart' }), rows: rowsOf('waitingPart') }) },
    { id: 'rows-mine', label: 'Rows: mine', model: list({ address: at({ view: 'mine' }), rows: rowsOf('mine') }) },
    { id: 'rows-closed', label: 'Rows: closed', model: list({ address: at({ view: 'closed' }), rows: rowsOf('closed') }) },
    { id: 'rows-all', label: 'Rows: all', model: list({ address: at({ view: 'all' }), rows: rowsOf('all') }) },
    { id: 'filtered', label: 'Filters as chips: warranty claims, legal guarantee, a search', model: list({ address: at({ kind: 'WARRANTY', cover: 'LEGAL_GUARANTEE', q: 'zip' }), rows: { items: OPEN_ROWS.filter((one) => one.kind === 'WARRANTY' && one.cover.state === 'LEGAL_GUARANTEE'), more: false, problem: null } }) },
    { id: 'notices-all', label: 'Notices: every notice listed (no delivery day, cover to decide, no customer)', model: list({ noticesOpen: true }) },
    { id: 'notices-dismissed', label: 'Notices: the first one dismissed (by its value)', model: list({ dismissed: ['unknown:1'] }) },
    { id: 'selection', label: 'Selection: Copy 2 numbers and Export 2', model: list({ selected: [OPEN_ROWS[0]!.id, OPEN_ROWS[1]!.id] }) },
    { id: 'live-updates', label: 'Live: 3 updates waiting behind Show', model: list({ updates: 3 }), note: 'Rows never move under the cursor.' },
    { id: 'more', label: 'More rows to show (the next page); the notices say they count the first page', model: list({ rows: { items: OPEN_ROWS, more: true, problem: null } }) },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows, x selects, c opens New case; the keys in the footer icon', model: list({ focusRow: 1, selected: [OPEN_ROWS[1]!.id] }) },
    { id: 'shortcuts', label: 'The keys panel (footer icon)', model: list({ keysOpen: true }) },
    { id: 'new', label: 'New case: Create held until the problem is said', model: list({ newCase: newCase() }) },
    { id: 'new-filled', label: 'New case: a serial of ours read — style, size, the shipment, the warranty check, an open case of the same garment', model: list({ newCase: filled }) },
    { id: 'new-rider', label: 'New case for a rider: a serial not ours, no customer, the check cannot tell yet', model: list({ newCase: newCase({ draft: { ...emptyNewDraft(ME), serial: 'XX-8841', problem: 'Is my 2023 jacket still covered?', kind: 'QUESTION', channel: 'MAIL' }, preview: { reading: false, value: RIDER_PREVIEW, problem: null } }) }) },
    { id: 'new-left-for', label: 'New case: the garment left for a customer — offered, never set by itself', model: list({ newCase: newCase({ draft: { ...emptyNewDraft(ME), serial: 'DEMO-SN-0001' }, preview: { reading: false, value: PREVIEW, problem: null } }) }) },
    { id: 'new-reading', label: 'New case: reading what the serial gives', model: list({ newCase: newCase({ draft: { ...emptyNewDraft(ME), serial: 'DEMO-SN-0001' }, preview: { reading: true, value: null, problem: null } }) }) },
    { id: 'new-refused', label: 'New case refused by the factory (our words for the fields named)', model: list({ newCase: { ...filled, notice: { key: 'problem.fields', tone: 'danger', lines: [{ key: 'field.ownerId' }] } } }) },
    { id: 'new-scan', label: 'New case: Scan the label (no camera here: it says so)', model: list({ newCase: newCase({ scanning: true }) }) },
    { id: 'new-offline', label: 'New case offline: Create held with why', model: list({ newCase: { ...filled, offline: true }, live: 'offline' }) },
    { id: 'sales', label: 'Sales: everything, the cover decision included', model: list({}, 'sales') },
    { id: 'inspector', label: 'Quality inspector: follows cases up (no cover decision)', model: list({}, 'inspector') },
    { id: 'production', label: 'Production manager: reads; New case held with why', model: list({}, 'production') },
    { id: 'reader', label: 'Read only: reads; New case and the row verbs held', model: list({}, 'reader') },
    { id: 'no-permission', label: 'Warehouse: no permission (which permission, who gives it)', model: list({}, 'warehouse') },
    { id: 'offline', label: 'Offline: the last copy with its time, New case held', model: list({ live: 'offline' }) },
    { id: 'loading', label: 'Loading (tiles say —)', model: list({ rows: { items: null, more: false, problem: null }, counts: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The API didn't answer (never an empty list; tiles say — and Couldn't count)", model: list({ rows: { items: null, more: false, problem: 'problem.unavailable' }, counts: null, countsFailed: true, asOf: null, live: 'offline' }) },
    { id: 'empty', label: 'First day: no case yet', model: list({ rows: { items: [], more: false, problem: null }, counts: { ...COUNTS, tiles: { new: 0, waitingCustomer: 0, waitingPart: 0 } } }) },
    { id: 'filtered-empty', label: 'A filter with nothing in it (Clear filters)', model: list({ address: at({ view: 'waitingPart', q: 'helmet' }), rows: { items: [], more: false, problem: null } }) },
  ],
})
