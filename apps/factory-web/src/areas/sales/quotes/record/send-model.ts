import type { Translate } from '../../../../lib/i18n/messages'
import type { SendCheckItem } from '../../../_shared/document-send/model'
import type { SendCheck } from '../api'
import type { QuoteTab } from '../model'

/**
 * The quote's send checks as the shared send dialog shows them (SCR-037; design `quotes.send` "Checks"): what fails,
 * in this app's words, with the tab that fixes it; then what passes, so the person sees the whole list (approval,
 * validity, addresses, SDI identity, prices, certificates, the contact's address, the letterhead).
 */

/** Where a check is fixed. */
const FIX_TAB: Readonly<Record<string, QuoteTab>> = {
  APPROVAL_NEEDED: 'approval',
  NO_VALIDITY: 'terms',
  VALIDITY_PAST: 'terms',
  NO_BILL_TO: 'terms',
  NO_SHIP_TO: 'terms',
  BILL_TO_INCOMPLETE: 'terms',
  SHIP_TO_INCOMPLETE: 'terms',
  NO_CONTACT_EMAIL: 'terms',
  NO_PROMISE_DATE: 'terms',
  TERMS_VERSION: 'terms',
  FIRM_OFFER_STANDS: 'versions',
  NOT_PRICED: 'lines',
  NO_LINES: 'lines',
  COST_INCOMPLETE: 'price',
  NO_COST_REVISION: 'price',
  CERTIFICATE: 'lines',
  VAT_CHANGED: 'lines',
}

/** The checks that pass when none of their codes is in the answer (one line each). */
export const PASSING_CHECKS: ReadonlyArray<{ id: string; codes: readonly string[] }> = [
  { id: 'approval', codes: ['APPROVAL_NEEDED'] },
  { id: 'validity', codes: ['NO_VALIDITY', 'VALIDITY_PAST'] },
  { id: 'billTo', codes: ['NO_BILL_TO', 'BILL_TO_INCOMPLETE'] },
  { id: 'shipTo', codes: ['NO_SHIP_TO', 'SHIP_TO_INCOMPLETE'] },
  { id: 'sdi', codes: ['SDI_IDENTITY'] },
  { id: 'priced', codes: ['NOT_PRICED', 'NO_LINES'] },
  { id: 'certificates', codes: ['CERTIFICATE'] },
  { id: 'email', codes: ['NO_CONTACT_EMAIL'] },
  { id: 'letterhead', codes: ['COMPANY_LEGAL'] },
]

export function sendItems(check: Pick<SendCheck, 'checks'>, t: Translate, tabHref: (tab: QuoteTab) => string): SendCheckItem[] {
  const failing: SendCheckItem[] = check.checks.map((item, index) => {
    const tab = FIX_TAB[item.code]
    return {
      id: `${item.code}-${index}`,
      state: item.severity === 'BLOCKS' ? 'blocks' : 'warning',
      label: t(`check.${item.code}`, { size: item.size ?? '' }),
      fix: tab ? { label: t('check.fix'), href: tabHref(tab) } : null,
    }
  })
  const codes = new Set(check.checks.map((item) => item.code))
  const passing: SendCheckItem[] = PASSING_CHECKS.filter((entry) => !entry.codes.some((code) => codes.has(code))).map((entry) => ({ id: `pass-${entry.id}`, state: 'passes', label: t(`check.pass.${entry.id}`) }))
  return [...failing, ...passing]
}
