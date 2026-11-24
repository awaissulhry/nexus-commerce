import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { recordHref, SIDES, type CustomerTab } from '../../../../parties/_shared/model'
import { workDoor, type WorkDoorTerm } from '../../list/doors'
import { receivablesOfCustomer } from '../../money/model'
import { quotesGroupDoor } from '../before-order'
import type { GroupDoor } from '../work-band'

/**
 * F-CO-101 (customer page › Overview; 13-backend §3.7; lead settles S21, S28) — the Overview's doors, composed: never a new rule.
 * A count on the Overview and the rows its door opens are one where on the server, so every door here is one the page already has —
 * the Customers list's `workDoor` (../../list/doors.ts: the Work tab on exactly those orders, its review window, its thread), the
 * Quotes & incoming tab at a group (../before-order.ts `quotesGroupDoor`), the record's own tabs and the parts of Terms &
 * requirements (their element ids are the customer page's), and each kind's own list or record page.
 */

const enc = encodeURIComponent

/** The customer's own page (`/w/<company>/sales/customers/<id>`). */
export const customerHref = (prefix: string, partyId: string): string => recordHref(prefix, SIDES.customers, partyId)

/** A tab of the customer's page. */
export const tabDoor = (prefix: string, partyId: string, tab: CustomerTab): string => `${customerHref(prefix, partyId)}?tab=${tab}`

/**
 * S21 (agreed with the Money-tab lane): the Money tab's section ids — ONE constant. Overdue and a deposit due open Money at what is
 * to collect, the credit limit and the Credit fact at the credit. Until the Money tab lands on them the hash does no harm (the door
 * opens Money).
 */
export const MONEY_ANCHORS = Object.freeze({ collect: 'collect', credit: 'credit' } as const)
export type MoneyAnchor = keyof typeof MONEY_ANCHORS
export const moneyDoor = (prefix: string, partyId: string, anchor: MoneyAnchor): string => `${tabDoor(prefix, partyId, 'money')}#${MONEY_ANCHORS[anchor]}`

/** The parts of Terms & requirements (the element ids the customer page draws: `party-hold`, `party-requirements`, `party-identity`). */
export const TERMS_ANCHORS = Object.freeze({ hold: 'party-hold', requirements: 'party-requirements', identity: 'party-identity' } as const)
export type TermsAnchor = keyof typeof TERMS_ANCHORS
export const termsDoor = (prefix: string, partyId: string, anchor: TermsAnchor): string => `${tabDoor(prefix, partyId, 'terms')}#${TERMS_ANCHORS[anchor]}`

/** The Work tab on exactly the orders a count counts (the Customers list's own doors; `open`: the open orders). */
export const ordersDoor = (prefix: string, partyId: string, term: WorkDoorTerm): string => workDoor(prefix, partyId, term)

/**
 * A group of the band (S6): the Work tab on exactly its orders — its phase; for an older answer without phases its one state;
 * null: a count with no door (never a held door, never a guess).
 */
export function groupDoor(prefix: string, partyId: string, door: GroupDoor): string | null {
  if (door === null) return null
  return door.kind === 'phase' ? ordersDoor(prefix, partyId, { kind: 'phase', phase: door.phase }) : `${tabDoor(prefix, partyId, 'work')}&status=${door.status}`
}

/** The open orders by promise date, the nearest first: the row "Next promise" opens the list it is the first of. */
export const promiseDoor = (prefix: string, partyId: string): string => `${ordersDoor(prefix, partyId, { kind: 'open' })}&sort=promise`

/** Quotes & incoming at one of its groups. */
export const quotesDoor = (prefix: string, partyId: string, group: 'WRITING' | 'TO_ANSWER' | 'OPEN_QUOTES' | 'ORDER_WAITS'): string => quotesGroupDoor(customerHref(prefix, partyId), group)

/** A deposit that is due: Money at what is to collect — for a reader without the Money tab, the Work tab's orders waiting for a deposit. */
export const depositDoor = (prefix: string, partyId: string, moneyTab: boolean): string => (moneyTab ? moneyDoor(prefix, partyId, 'collect') : ordersDoor(prefix, partyId, { kind: 'deposit' }))

/** A record's own page (the sample round, the named complaint — S28: no list of complaints by customer is assumed). */
const recordDoor = (prefix: string, type: string, id: string): string => `${prefix}${recordAddress({ type, id }, OFFICE_PAGES)}`
export const sampleDoor = (prefix: string, id: string): string => recordDoor(prefix, 'SampleRound', id)
export const complaintDoor = (prefix: string, id: string): string => recordDoor(prefix, 'Complaint', id)

/** The customer's sample rounds, the earliest due first (Products › Samples with this customer). */
export const samplesDoor = (prefix: string, partyId: string): string => `${prefix}/products/samples?party=${enc(partyId)}`
/** The customer's repairs in progress (Sales › Returns, its open repairs, searched by the customer's code). */
export const repairsDoor = (prefix: string, partyCode: string): string => `${prefix}/sales/returns?view=openRepairs&q=${enc(partyCode)}`
/** The party's projects, open and closed. */
export const projectsDoor = (prefix: string, partyId: string): string => `${prefix}/products/projects?party=${enc(partyId)}&view=all`
/** Production › Work orders of this customer. */
export const workOrdersDoor = (prefix: string, partyId: string): string => `${prefix}/production/work-orders?party=${enc(partyId)}`
/** Finance › Receivables & credit of this customer (the Money lane's own address). */
export const receivablesDoor = (prefix: string, partyId: string): string => receivablesOfCustomer(prefix, partyId)
