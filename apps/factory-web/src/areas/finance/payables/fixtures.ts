import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { asSeenBy, canAs, CONCERIA, COUNTS, inShell, INV_0350, INV_0398, INV_0412, INV_DE77, INV_LAB14, NOW, PREFIX, ROWS, SDI, TODAY, type Role } from './demo/fixtures'
import { addressOf, EMPTY_FOREIGN } from './model'
import { PayablesListView, type PayablesListModel } from './view/PayablesListView'

/**
 * SCR-153 — Finance › Payables & bank › Supplier invoices (design finance.payables) with made-up data only: the band (read
 * at, live, last SDI pickup, Pick up now, Add foreign invoice, Payment proposal and Self-invoices held — W2b), the "To
 * handle" tiles (one pressed: the list filtered), the invoices on the list frame (every column for Finance; no amount
 * column for a role without the cost grain), two rows chosen → Approve 2, the bulk answer with a refusal in words, the
 * pickup's answer, the Add foreign invoice dialog (empty, filled, an Italian supplier refused, a refusal from the API),
 * the keys in the footer icon, and the states (loading with "Still loading…", error, empty, nothing matching, offline,
 * no permission) and roles: Finance, Owner, Buyer (approve held), Read-only (no cost grain), Warehouse (no access).
 */

interface Case {
  role: Role
  page: PayablesListModel
}

const ADDRESS = addressOf(null)

const base = (role: Role, over: Partial<PayablesListModel> = {}): Case => {
  const can = canAs(role)
  const rows = asSeenBy(ROWS, can)
  return {
    role,
    page: {
      prefix: PREFIX,
      can,
      today: TODAY,
      address: ADDRESS,
      counts: { value: COUNTS, problem: null },
      sdi: { value: SDI, problem: null },
      list: { problem: null, slow: false },
      rows,
      count: rows.length,
      more: false,
      readAt: NOW - 60_000,
      live: 'live',
      updates: 0,
      busy: false,
      notice: null,
      bulk: null,
      pickup: null,
      foreign: null,
      ...over,
    },
  }
}

function PayablesDesign({ model }: { model: Case }) {
  return inShell('/finance/payables', createElement(PayablesListView, { model: model.page }), model.role)
}

const LEDER_OPTION = { id: '0190f0e2-4141-7000-8000-000000000002', code: 'SUP-LEDER', legalName: 'Lederwerk Demo GmbH', country: 'DE', currency: 'EUR' }
const CONCERIA_OPTION = { id: CONCERIA.id, code: CONCERIA.code, legalName: CONCERIA.name, country: 'IT', currency: 'EUR' }
const FILLED = {
  ...EMPTY_FOREIGN,
  partyId: LEDER_OPTION.id,
  country: 'DE',
  number: 'DE-2026-81',
  issueDate: '2026-10-28',
  dueDate: '2026-11-27',
  description: 'Rifinitura campioni (demo)',
  net: '1200,00',
  vatRate: '0',
  vatNature: 'N2.1',
  vat: '0',
  fileName: 'DE-2026-81.pdf',
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-153',
  title: 'Supplier invoices: from SDI or typed, matched to PO and receipt, approved, paid',
  view: PayablesDesign,
  cases: [
    {
      id: 'finance',
      label: 'Finance · every invoice with its match, approval, due and paid',
      model: base('finance'),
      note: '2026/0412: 105 FT2 × 4.30 = 451.50 + freight 15.00 = 466.50 net + VAT 102.63 = 569.13; the order says 4.20 → +10.50 to check.',
    },
    { id: 'owner', label: 'Owner · the same page', model: base('owner') },
    {
      id: 'tile',
      label: 'A tile pressed: Differences to check',
      model: base('finance', { address: { ...ADDRESS, tile: 'DIFFERENCES' }, rows: ROWS.filter((row) => row.differencesToCheck > 0 && row.status === 'RECEIVED'), count: 1 }),
    },
    { id: 'selected', label: 'Two invoices chosen · Approve 2 (an approved one is not selectable, its reason on the box)', model: base('finance', { selected: [INV_0398, INV_DE77] }) },
    {
      id: 'bulk-answer',
      label: 'The bulk answer: 1 approved; DE-2026-77 not — you entered it (separation of duties per row)',
      model: base('finance', { bulk: { approved: 1, refused: [{ id: INV_DE77, number: 'DE-2026-77', phrases: [{ key: 'refusal.OWN_INVOICE' }] }] } }),
    },
    {
      id: 'pickup',
      label: 'Pick up now answered: 4 listed, 1 new recorded',
      model: base('finance', {
        pickup: {
          companyId: '0190f0e2-1111-7000-8000-000000000001',
          accountId: '0190f0e2-4646-7000-8000-000000000001',
          listed: 4,
          known: 3,
          recorded: [{ invoiceId: INV_0412, number: '2026/0412', sdiIdentifier: '9000000412', matchStatus: 'DIFFERENCES' }],
          waiting: [],
          at: '2026-10-30T08:41:00.000Z',
        },
      }),
    },
    {
      id: 'pickup-waiting',
      label: 'A pickup with a delivery that waits at the intermediary (unknown supplier)',
      model: base('finance', {
        pickup: {
          companyId: '0190f0e2-1111-7000-8000-000000000001',
          accountId: '0190f0e2-4646-7000-8000-000000000001',
          listed: 2,
          known: 1,
          recorded: [],
          waiting: [{ sdiIdentifier: '9000000777', fileName: 'IT00000009099_00777.xml', receivedAt: '2026-10-30T07:00:00.000Z', problem: 'Unknown supplier VAT number.' }],
          at: '2026-10-30T08:41:00.000Z',
        },
      }),
    },
    {
      id: 'foreign',
      label: 'Add foreign invoice — the dialog, empty (the suppliers listed)',
      model: base('finance', { address: { ...ADDRESS, adding: true }, foreign: { draft: EMPTY_FOREIGN, suppliers: [CONCERIA_OPTION, LEDER_OPTION], problems: null, busy: false } }),
    },
    {
      id: 'foreign-filled',
      label: 'Add foreign invoice — filled: a German supplier, VAT 0 N2.1, its PDF chosen',
      model: base('finance', { address: { ...ADDRESS, adding: true }, foreign: { draft: FILLED, suppliers: [CONCERIA_OPTION, LEDER_OPTION], problems: null, busy: false } }),
    },
    {
      id: 'foreign-italian',
      label: 'Add foreign invoice — an Italian supplier: held, it comes through SDI',
      model: base('finance', {
        address: { ...ADDRESS, adding: true },
        foreign: { draft: { ...FILLED, partyId: CONCERIA_OPTION.id, country: 'IT' }, suppliers: [CONCERIA_OPTION, LEDER_OPTION], problems: null, busy: false },
      }),
    },
    {
      id: 'foreign-refused',
      label: 'Add foreign invoice — refused by the API: already registered',
      model: base('finance', { address: { ...ADDRESS, adding: true }, foreign: { draft: FILLED, suppliers: [CONCERIA_OPTION, LEDER_OPTION], problems: [{ key: 'refusal.DUPLICATE' }], busy: false } }),
    },
    { id: 'updates', label: 'Live · 2 supplier-invoice events since the read', model: base('finance', { updates: 2 }) },
    { id: 'keys', label: 'Keys in the footer info icon', model: base('finance', { keysOpen: true, focusRow: 0 }) },
    { id: 'buyer', label: 'Buyer · sees costs, maps and accepts; Approve is held (never approves or pays)', model: base('buyer', { selected: [INV_0398] }) },
    { id: 'readonly', label: 'Read-only · no cost grain: the amount column is not drawn', model: base('readonly') },
    {
      id: 'notice',
      label: 'A refused write in words (the SDI intermediary did not answer)',
      model: base('finance', { notice: { tone: 'danger', phrases: [{ key: 'refusal.INTERMEDIARY_UNAVAILABLE' }] } }),
    },
    {
      id: 'empty',
      label: 'No supplier invoices yet',
      model: base('finance', { rows: [], count: 0, counts: { value: { ...COUNTS, newFromSdi: 0, differences: 0, toApprove: 0, dueThisWeek: 0 }, problem: null } }),
    },
    { id: 'no-match', label: 'Nothing matches the search', model: base('finance', { address: { ...ADDRESS, q: 'ZZZ' }, rows: [], count: 0 }) },
    {
      id: 'loading',
      label: 'Loading · "Still loading…" after a second; tiles show —',
      model: base('finance', { counts: { value: null, problem: null }, sdi: { value: null, problem: null }, list: { problem: null, slow: true }, rows: null, count: null, readAt: null }),
    },
    {
      id: 'error',
      label: "Error · couldn't load, Try again (never drawn as empty)",
      model: base('finance', { counts: { value: null, problem: 'problem.read.unavailable' }, list: { problem: 'problem.read.unavailable', slow: false }, rows: null, count: null, readAt: null }),
    },
    { id: 'offline', label: 'Offline · reading again when back', model: base('finance', { live: 'offline' }) },
    { id: 'no-permission', label: 'Warehouse · no payables.view', model: base('warehouse', { rows: null, count: null, counts: { value: null, problem: null }, sdi: { value: null, problem: null } }) },
    {
      id: 'paid-approved',
      label: 'Paid and approved rows (2026/0350, LAB-2026-14) beside the rest',
      model: base('finance', { rows: ROWS.filter((row) => row.id === INV_0350 || row.id === INV_LAB14), count: 2 }),
    },
  ],
})
