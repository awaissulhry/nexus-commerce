import type { CardFieldRole } from '@nexus/ui/grid/card-list/index'
import { BATCH_MAX } from '../../../../record-panels/tasks/model'
import type { PartyRow } from '../../../parties/_shared/api'
import { BULK_MAX, partyName } from '../../../parties/_shared/model'

/**
 * Sales › Customers, the list's own rules (customers list plan §1, 10-design §3, 13-backend §8; F-CL-102…104), pure: what the
 * Customer cell says the office still owes, which columns start hidden, where each column sits on the phone card and what each
 * reader may do on the list. The words are `customers-list` keys (its root groups never a `parties` prefix: 13-backend §8.8).
 */

/** The list's own words (`messages/<locale>/customers-list.json`). */
export const CUSTOMERS_LIST_NS = 'customers-list'

// ---- F-CL-102: the Customer cell ------------------------------------------------------------------------------------------

/** What the office still owes on a customer, as the cell's one chip "Needs office data" says it (its hint lists them). */
export type OfficeData = 'VIES' | 'SDI' | 'TAX'

/**
 * The row's own warnings read as office data (a `parties` warning code each): the VIES check not valid (VIES_NOT_PROVEN), the SDI
 * code or PEC missing (FISCAL_DRAWER), the tax data missing (NO_TAX_IDENTITY, or any warning that stops an invoice). Empty: no chip.
 */
export function officeDataOf(row: Pick<PartyRow, 'attention' | 'invoiceBlocked'>): OfficeData[] {
  const out: OfficeData[] = []
  if (row.attention.includes('VIES_NOT_PROVEN')) out.push('VIES')
  if (row.attention.includes('FISCAL_DRAWER')) out.push('SDI')
  if (row.attention.includes('NO_TAX_IDENTITY') || row.invoiceBlocked) out.push('TAX')
  return out
}

/**
 * The identity columns start hidden (settle T15, T28): still in Customise and in the full file for re-import. Status moves into
 * the Customer cell (shown only when not Active).
 */
export const CUSTOMER_HIDDEN_COLUMNS: readonly string[] = Object.freeze(['roles', 'status', 'country', 'taxMode', 'vies', 'sdi', 'language'])

/**
 * The phone card (10-design §4): the Customer cell is the card's title (name, code, status, office chip), the thread door sits
 * beside it with the row's ⋯ as the card's actions (the shared list pins it right), Overdue is a line; the rest stays off the card.
 */
export const CARD_ROLES: Readonly<Record<string, CardFieldRole>> = Object.freeze({ name: 'title', messages: 'aside', overdue: 'field' })

// ---- F-CL-102 / F-CL-104: what the reader may do on the list (each act reads its OWN right) ----------------------------------

export interface CustomerRights {
  /** threads.read: the New messages column and the thread doors. */
  readonly threads: boolean
  /** orders.view: the Work tab door. */
  readonly orders: boolean
  /** tasks.manage + threads.post: Add task (a task on a record is written in its thread). */
  readonly tasks: boolean
  /** production.brand.manage + partners.view: Set production supervisor (the customer card's own gate). */
  readonly supervisor: boolean
}

export function customerRightsOf(permissions: Iterable<string>): CustomerRights {
  const held = new Set(permissions)
  return {
    threads: held.has('threads.read'),
    orders: held.has('orders.view'),
    tasks: held.has('tasks.manage') && held.has('threads.post'),
    supervisor: held.has('production.brand.manage') && held.has('partners.view'),
  }
}

// ---- F-CL-104: the customers' own acts on a selection (the bar, 13-backend §8.2) -----------------------------------------------

/** Their places in the bar: Add task first, Set production supervisor second (then the shared VIES 40 · Block 50 · Archive 60). */
export const CUSTOMER_ACT_ORDER = Object.freeze({ task: 10, supervisor: 20 })
/** Set production supervisor runs one customer at a time: at most this many at once (the shared cap). */
export const SUPERVISOR_MAX = BULK_MAX

/** The customers' acts a reader may use on N ticked customers (left out without the right; held only by the cap, with its numbers). */
export function customerActsOf(rights: Pick<CustomerRights, 'tasks' | 'supervisor'>, count: number): Array<{ readonly id: 'task' | 'supervisor'; readonly order: number; readonly held: { readonly max: number } | null }> {
  return [
    ...(rights.tasks ? [{ id: 'task' as const, order: CUSTOMER_ACT_ORDER.task, held: count > BATCH_MAX ? { max: BATCH_MAX } : null }] : []),
    ...(rights.supervisor ? [{ id: 'supervisor' as const, order: CUSTOMER_ACT_ORDER.supervisor, held: count > SUPERVISOR_MAX ? { max: SUPERVISOR_MAX } : null }] : []),
  ]
}

/** The words a name may hide behind (R-47): shorter than 3 letters, a name names nothing. */
const MIN_NAME = 3
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * R-47 for "Add task to N customers…": the ticked customers the text names — its code, its trade name or its legal name, as a whole
 * word, any case (a code inside a longer word is no match; fewer than 3 letters count as no name). With two customers or more, any
 * name is another customer's for every other thread the task lands in. The server has no such check on a batch yet (LATER).
 */
export function namesOtherCustomer(text: string, ticked: ReadonlyArray<Pick<PartyRow, 'code' | 'tradeName' | 'legalName'>>): string[] {
  const named: string[] = []
  for (const customer of ticked) {
    const terms = [customer.code, customer.tradeName, customer.legalName].filter((term): term is string => !!term && term.trim().length >= MIN_NAME)
    const hit = terms.some((term) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(term.trim())}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text))
    if (hit && !named.includes(partyName(customer))) named.push(partyName(customer))
  }
  return named
}
