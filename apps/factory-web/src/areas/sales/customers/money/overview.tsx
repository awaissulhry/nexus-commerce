import type { AgeingRow } from '../../../finance/receivables/api'
import type { Loaded } from '../../../parties/_shared/model'
import type { CustomerComplaint, CustomerReturn, OpenOrderMoney } from './api'
import type { OpenItemsRead } from '../record/money/model' // F-CM-103
import type { CustomerMoneyCan } from './model'

/**
 * What the customer record reads beside the party (B-W2a-81): the Overview's rules and the Money tab read it. F-CM-304 (cm-w3 W3.4;
 * 13-backend §5.11): the old Overview hook (its key-number tiles and the open returns card) went — the type stays here, its home.
 */
export interface CustomerMoneyModel {
  readonly can: CustomerMoneyCan
  readonly prefix: string
  readonly partyId: string
  /** The Europe/Rome year "this year" means. */
  readonly year: string
  readonly ageing: Loaded<AgeingRow>
  readonly returns: Loaded<CustomerReturn>
  readonly complaints: Loaded<CustomerComplaint>
  /** F-SA-273: the open orders' deposits and balances (orders.view; absent in a design case that draws none). */
  readonly orders?: Loaded<OpenOrderMoney>
  /** The returns list with this customer, once Sales › Returns is built (else the tile is not a link). */
  readonly returnsHref: string | null
  // ── F-CM-103 (customer MONEY tab, cm-w1 W1.2; 13-backend §1.3, §5.2): the page reads the ageing WITHOUT the company term and splits it
  // by company (`ageing` keeps its shape: this company's rows), the open items become a page read (the tab's count), and the money
  // reads read again by themselves when this customer's money moves. Every field optional: a design case may hand none. ──
  /** This customer's ageing in the OTHER companies the reader reaches (receivables.view): "Also owes Seed Company B ›". */
  readonly ageingElsewhere?: Loaded<AgeingRow>
  /** Open deposit requests and invoices and the money on account (payments.view; null without it or without a company). */
  readonly openItems?: { readonly value: OpenItemsRead | null; readonly problem: string | null } | null
  /** When the server counted the ageing ("Counts as of 10:44"). */
  readonly readAt?: string | null
  /** Read the page's money again (a section's Try again). */
  readonly reload?: () => void
  // ── end F-CM-103 ──
}
