import { INCOTERMS, PLACE_MAX } from '@nexus/factory-domain/sales/quote-terms/rules'
import type { QuoteTerms } from '../lines-depth/api'
import type { Words } from '../lines-depth/model'

/**
 * Terms & delivery in depth (B-W2b-316 on B-W2b-294's GET/PUT …/terms), pure: the delivery terms as the card edits them,
 * what stops a save (the API says the same first: deliveryTermsProblems), the change PUT …/terms takes, and the
 * acceptance mode a quote may take (sign and pay needs a deposit). Incoterm words are this catalogue's (`incoterm.<CODE>`),
 * never the answer's `incotermWords`.
 */

export { INCOTERMS, PLACE_MAX }

export interface DeliveryDraft {
  /** '' = none. */
  incoterm: string
  place: string
  shipComplete: boolean
}

export const deliveryDraftOf = (terms: Pick<QuoteTerms, 'incoterm' | 'incotermPlace' | 'shipComplete'>): DeliveryDraft => ({ incoterm: terms.incoterm ?? '', place: terms.incotermPlace ?? '', shipComplete: terms.shipComplete })

/** What stops the delivery terms from being saved, in words. */
export function deliveryProblems(draft: DeliveryDraft): Words[] {
  const problems: Words[] = []
  const place = draft.place.trim()
  if (draft.incoterm !== '' && !(INCOTERMS as readonly string[]).includes(draft.incoterm)) problems.push({ key: 'terms.problem.incoterm' })
  if (draft.incoterm !== '' && place === '') problems.push({ key: 'terms.problem.place' })
  if (draft.incoterm === '' && place !== '') problems.push({ key: 'terms.problem.placeAlone' })
  if (place.length > PLACE_MAX || /[\r\n]/.test(place)) problems.push({ key: 'terms.problem.placeLong', params: { max: PLACE_MAX } })
  return problems
}

/** The fields that changed, as PUT …/terms takes them (clearing the Incoterm clears its place). */
export function deliveryPatch(before: DeliveryDraft, after: DeliveryDraft): { incoterm?: string | null; incotermPlace?: string | null; shipComplete?: boolean } {
  const patch: { incoterm?: string | null; incotermPlace?: string | null; shipComplete?: boolean } = {}
  if (after.incoterm !== before.incoterm) patch.incoterm = after.incoterm === '' ? null : after.incoterm
  if (after.place.trim() !== before.place.trim() || (after.incoterm === '' && before.incoterm !== '')) patch.incotermPlace = after.incoterm === '' || after.place.trim() === '' ? null : after.place.trim()
  if (after.shipComplete !== before.shipComplete) patch.shipComplete = after.shipComplete
  return patch
}

/** Why "sign and pay the deposit" cannot be chosen, or null. */
export function payModeHeld(depositPct: string | null): Words | null {
  return depositPct === null || Number(depositPct) <= 0 ? { key: 'terms.acceptance.needsDeposit' } : null
}

/** The validity in words: its state, the days left, when the reminder goes or went (dates formatted by the view). */
export function validityWords(validity: QuoteTerms['validity']): Words {
  switch (validity.state) {
    case 'OPEN':
    case 'ENDS_SOON':
      return { key: `terms.validity.${validity.state}`, params: { count: validity.daysLeft ?? 0 } }
    default:
      return { key: `terms.validity.${validity.state}` }
  }
}
