import type { FinalState } from '../../../_shared/api'
import type { Phrase } from '../../../_shared/model'
import { reportAddress } from '../../../../quality/inspections/depth/model'
import type { CustomerFact } from '../overview/model'

/**
 * F-PR-06 — the work order's Quality tab without a screen (06-tree A.4 Tab 5, O-WO-qa, O-WO-qa-scrap): the one scrap home of the
 * work order (the scrap & rework card lives here only; Labour & cost keeps one scrap value line), and "Share with the customer"
 * on a final inspection's report, held unless the work order is of one customer (WALL-G02, WALL-G07, TH-16: a mixed work order
 * made before the one-customer rule shares nothing with any customer). The share itself is the report window's (B-W2b-123:
 * a version kept, the shipment picked; the API refuses a shared production run again, B-TH-232).
 */

type Inspection = FinalState['inspections'][number]

/** Why "Share with the customer…" is held for an inspection's report, or null: the wall first, then the result, then the right. */
export function shareHeld(fact: CustomerFact, inspection: Pick<Inspection, 'status'>, can: boolean): Phrase | null {
  if (fact.kind === 'mixed') return { key: 'quality.share.mixed' }
  if (fact.kind === 'none') return { key: 'quality.share.noCustomer' }
  if (inspection.status === 'OPEN' || inspection.status === 'CANCELLED') return { key: 'quality.share.noResult' }
  if (!can) return { key: 'quality.share.noRight' }
  return null
}

/** The report window of the inspection, opened on its share part (a new tab). */
export const shareAddress = (prefix: string, inspectionId: string): string => reportAddress(prefix, inspectionId, { share: true })

/** Scrap & rework of this work order on its own page (Replace scrapped quantity is there), found by the work order's number. */
export const scrapPageHref = (prefix: string, number: string): string => `${prefix}/production/scrap?q=${encodeURIComponent(number)}`
