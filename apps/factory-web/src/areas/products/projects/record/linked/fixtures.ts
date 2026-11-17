import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { LinkedRecord } from '../../api'
import { groupsOf, type LinkCandidate, type LinkDialogModel, type LinkedBlockModel } from './model'
import { LinkedBlock } from './view/LinkedBlock'

/**
 * SCR-701-linked — a project's Linked records (B-TH-251; design PROJ.linked; picture 35 never drawn, built to the design kit), made-up
 * data only (Brand Alpha's project; no other customer anywhere): grouped by kind, an office-only project, none, many (folded), a
 * record the reader may not open, the Link dialog with results, a refusal in words that names neither company, a record linked
 * already, read-only (no projects.manage), a closed project, Unlink…? and its receipt. `LINKED_DEMO` is what the project page's own
 * design cases (SCR-701) draw in their side column.
 */

const PREFIX = '/w/DEMO'
const LINKED_AT = '2026-11-10T09:30:00.000Z'
const MARCO = { id: 'u-marco', name: 'Marco Demo' }

let seq = 0
const rec = (recordType: string, group: string, label: string | null, status: string | null, over: Partial<LinkedRecord> = {}): LinkedRecord => {
  seq += 1
  const n = String(seq).padStart(4, '0')
  return {
    linkId: `00000000-0000-4000-8000-0000000a${n}`,
    recordType,
    recordId: `00000000-0000-4000-8000-0000000b${n}`,
    group,
    label,
    status,
    mayOpen: label !== null,
    note: null,
    linkedAt: LINKED_AT,
    linkedBy: MARCO,
    ...over,
  }
}

/** Brand Alpha's project: its styles, a fit round, a quote, an order, a purchase order of no customer, a certificate, a profile the reader may not open. */
const CUSTOMER_RECORDS: LinkedRecord[] = [
  rec('Style', 'STYLES', 'AX-100', 'RELEASED', { note: 'The base jacket of the line.' }),
  rec('Style', 'STYLES', 'AX-101', 'DRAFT'),
  rec('SampleRound', 'SAMPLES', 'SR-0042', 'SENT', { note: 'Fit round 2 with the airbag vest.' }),
  rec('Quote', 'QUOTES', 'Q-2026-0101', 'SENT'),
  rec('SalesOrder', 'ORDERS', 'SO-2026-0101', 'CONFIRMED'),
  rec('PurchaseOrder', 'PURCHASE_ORDERS', 'PO-2026-0311', 'SENT', { linkedBy: null }),
  rec('Certificate', 'CERTIFICATES', 'CERT-0007', 'ACTIVE'),
  rec('MeasurementProfile', 'MEASUREMENTS', null, null, { mayOpen: false }),
]

/** An office-only project: records of no outside company (an internal style, a supplier's PO, a change request). */
const OFFICE_RECORDS: LinkedRecord[] = [
  rec('Style', 'STYLES', 'LAB-01', 'DRAFT', { note: 'The airbag pocket test piece.' }),
  rec('PurchaseOrder', 'PURCHASE_ORDERS', 'PO-2026-0412', 'CONFIRMED'),
  rec('ChangeRequest', 'CHANGES', 'CR-2026-0019', 'OPEN'),
]

const MANY_RECORDS: LinkedRecord[] = [
  ...Array.from({ length: 24 }, (_, index) => rec('Style', 'STYLES', `AX-${String(200 + index)}`, index % 3 === 0 ? 'RELEASED' : 'DRAFT')),
  ...Array.from({ length: 9 }, (_, index) => rec('SampleRound', 'SAMPLES', `SR-${String(100 + index).padStart(4, '0')}`, 'SENT')),
  rec('SalesOrder', 'ORDERS', 'SO-2026-0101', 'CONFIRMED'),
]

const block = (records: readonly LinkedRecord[], over: Partial<LinkedBlockModel> = {}): LinkedBlockModel => ({
  count: records.length,
  groups: groupsOf(records, PREFIX, OFFICE_PAGES),
  scope: { key: 'block.scopeParty', params: { party: 'Brand Alpha' } },
  held: null,
  manage: true,
  busy: null,
  notice: null,
  link: null,
  unlinking: null,
  ...over,
})

const OFFICE_SCOPE = { key: 'block.scopeOffice' } as const

export const LINKED_DEMO: { customer: LinkedBlockModel; officeOnly: LinkedBlockModel } = {
  customer: block(CUSTOMER_RECORDS),
  officeOnly: block(OFFICE_RECORDS, { scope: OFFICE_SCOPE }),
}

const CANDIDATES: LinkCandidate[] = [
  { recordType: 'Style', recordId: '00000000-0000-4000-8000-0000000c0001', label: 'AX-102', title: 'Airbag jacket, women', statusKey: 'status.DRAFT', linked: false },
  { recordType: 'SampleRound', recordId: '00000000-0000-4000-8000-0000000c0002', label: 'SR-0044', title: 'Proto round 1', statusKey: 'status.SENT', linked: false },
  { recordType: 'Style', recordId: '00000000-0000-4000-8000-0000000b0001', label: 'AX-100', title: 'Airbag jacket, men', statusKey: 'status.RELEASED', linked: true },
]

const dialog = (over: Partial<LinkDialogModel> = {}): LinkDialogModel => ({
  project: 'PRJ-26-012 · FW27 airbag line',
  scope: { key: 'block.scopeParty', params: { party: 'Brand Alpha' } },
  q: 'AX',
  kind: null,
  results: { status: 'ready', items: CANDIDATES },
  picked: null,
  note: '',
  busy: false,
  problem: null,
  offline: false,
  ...over,
})

export const designScreen = defineDesignScreen<LinkedBlockModel>({
  screen: 'SCR-701-linked',
  title: 'Linked records',
  view: LinkedBlock,
  cases: [
    { id: 'grouped', label: 'Grouped by kind', model: LINKED_DEMO.customer, note: 'Styles, Samples, Quotes, Orders, Purchase orders, Certificates, Measurement profiles; status words only, never an amount.' },
    { id: 'office-only', label: 'Office-only project', model: LINKED_DEMO.officeOnly, note: 'Only records of no outside company can join.' },
    { id: 'none', label: 'Nothing linked yet', model: block([]) },
    { id: 'none-read', label: 'Nothing linked, read only', model: block([], { manage: false }) },
    { id: 'many', label: 'Many records (folded)', model: block(MANY_RECORDS), note: 'Each group shows five rows, then "Show all N".' },
    { id: 'many-open', label: 'Many records, Styles opened', model: block(MANY_RECORDS, { opened: ['STYLES'] }) },
    { id: 'cannot-open', label: 'A record you cannot open', model: block([CUSTOMER_RECORDS[7]!, CUSTOMER_RECORDS[0]!]), note: 'A measurement profile without sales.measurements.view: its kind only, no link, no status.' },
    { id: 'read-only', label: 'Read only (no projects.manage)', model: block(CUSTOMER_RECORDS, { manage: false }) },
    { id: 'closed', label: 'Closed project: link and unlink held', model: block(CUSTOMER_RECORDS, { held: { key: 'held.closed' } }) },
    { id: 'link-results', label: 'Link: results', model: block(CUSTOMER_RECORDS, { link: dialog() }), note: 'A record linked already is shown, not offered.' },
    { id: 'link-picked', label: 'Link: a record picked with a note', model: block(CUSTOMER_RECORDS, { link: dialog({ picked: { recordType: 'Style', recordId: CANDIDATES[0]!.recordId, label: 'AX-102' }, note: 'The women’s cut of the same jacket.' }) }) },
    { id: 'link-idle', label: 'Link: nothing typed', model: block(CUSTOMER_RECORDS, { link: dialog({ q: '', results: { status: 'idle' } }) }) },
    { id: 'link-none', label: 'Link: nothing found', model: block(CUSTOMER_RECORDS, { link: dialog({ q: 'ZZ-999', results: { status: 'ready', items: [] } }) }) },
    { id: 'link-loading', label: 'Link: searching', model: block(CUSTOMER_RECORDS, { link: dialog({ results: { status: 'loading' } }) }) },
    { id: 'link-failed', label: 'Link: the search did not answer', model: block(CUSTOMER_RECORDS, { link: dialog({ results: { status: 'error', problem: 'problem.unavailable' } }) }) },
    {
      id: 'link-refused-party',
      label: 'Link: another outside company’s record, refused in words',
      model: block(CUSTOMER_RECORDS, {
        link: dialog({ q: 'SO-2026-0909', results: { status: 'ready', items: [] }, picked: { recordType: 'SalesOrder', recordId: '00000000-0000-4000-8000-0000000c0009', label: 'SO-2026-0909' }, problem: { title: { key: 'refused.party', params: { label: 'SO-2026-0909' } }, body: { key: 'refusal.LINK_PARTY' } } }),
      }),
      note: 'Names neither company: the number typed, and the rule.',
    },
    {
      id: 'link-already',
      label: 'Link: linked already',
      model: block(CUSTOMER_RECORDS, { link: dialog({ picked: { recordType: 'Style', recordId: CANDIDATES[0]!.recordId, label: 'AX-102' }, problem: { title: { key: 'refused.already', params: { label: 'AX-102' } }, body: null } }) }),
    },
    { id: 'unlink-confirm', label: 'Unlink…?', model: block(CUSTOMER_RECORDS, { unlinking: { linkId: CUSTOMER_RECORDS[1]!.linkId, recordType: 'Style', label: 'AX-101' } }) },
    { id: 'unlinked', label: 'Unlinked (receipt)', model: block(CUSTOMER_RECORDS.filter((_, index) => index !== 1), { notice: { key: 'notice.unlinked', params: { label: 'AX-101' }, tone: 'success' } }) },
  ],
})
