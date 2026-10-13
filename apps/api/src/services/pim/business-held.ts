/**
 * Amazon Business — can this listing's business offer be sent to Amazon now? ONE answer for the business price door
 * (a change kept in Nexus until it can be sent) and the Matrix read (the business cell's held line).
 */
import { assertPushAllowed } from '@nexus/shared/push-lock'
import { holdsCascadedPrice } from './follower-price.js'

export interface BusinessHoldFacts {
  syncPaused: boolean
  listingStatus: string | null
  isPublished: boolean
  externalListingId: string | null
  offerClosedAt: Date | null
}

/** `null` = it can be sent now; otherwise the sentence for a change kept in Nexus until it can. */
export function businessHeld(l: BusinessHoldFacts): string | null {
  if (l.syncPaused) return 'The business price is saved in Nexus. Nothing was sent yet: this listing\'s sync is paused. It is sent when the listing resumes.'
  if (holdsCascadedPrice(l)) return 'The business price is saved in Nexus. Nothing was sent yet: this listing is a draft that has not been published. It is sent when the listing is published.'
  if (l.offerClosedAt) return 'The business price is saved in Nexus. Nothing was sent yet: this listing is Inactive here. It is sent when the listing is set Active again.'
  const lock = assertPushAllowed(l)
  return lock ? `The business price is saved in Nexus. Nothing was sent: ${lock.sentence}` : null
}
