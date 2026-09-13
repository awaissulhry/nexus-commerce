export interface PushLockListing {
  syncPaused?: boolean | null
  offerClosedAt?: Date | string | null
  /** Optional until the Presence Wave 2 migration has been applied. */
  presenceIntent?: string | null
}

export type PushRefusal = {
  code: 'PUSH_SYNC_PAUSED' | 'PUSH_OFFER_CLOSED' | 'PUSH_INTENT_HELD' | 'PUSH_INTENT_WITHDRAWN'
    | 'PUSH_INTENT_ENDED' | 'PUSH_INTENT_DISCONTINUED' | 'PUSH_INTENT_RELEASED'
  sentence: string
}

/** The same lock at enqueue, dispatch and direct push; a refusal is recordable, never thrown. */
export function assertPushAllowed(listing: PushLockListing | null | undefined): PushRefusal | null {
  if (listing?.syncPaused) return { code: 'PUSH_SYNC_PAUSED', sentence: 'Listing sync is paused. Resume sync before sending changes.' }
  if (listing?.offerClosedAt) return { code: 'PUSH_OFFER_CLOSED', sentence: 'This market offer is closed. Restore the offer before sending changes.' }
  switch (listing?.presenceIntent) {
    case 'HELD': return { code: 'PUSH_INTENT_HELD', sentence: 'This listing is deliberately held. Resume sync before sending changes.' }
    case 'WITHDRAWN': return { code: 'PUSH_INTENT_WITHDRAWN', sentence: 'This offer is deliberately withdrawn. Restore the offer before sending changes.' }
    case 'ENDED': return { code: 'PUSH_INTENT_ENDED', sentence: 'This listing was deliberately ended. Relist it before sending changes.' }
    case 'DISCONTINUED': return { code: 'PUSH_INTENT_DISCONTINUED', sentence: 'This listing is discontinued. Sending changes is refused.' }
    case 'RELEASED': return { code: 'PUSH_INTENT_RELEASED', sentence: 'This listing identity was deliberately released. Sending changes is refused.' }
    default: return null
  }
}
