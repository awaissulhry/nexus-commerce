/** Additive listing projection fields. Undefined means the producer has not reported the field. */
export interface ListingPresenceFields {
  offerClosedAt?: string | null
  offerClosedBy?: string | null
  offerCloseReason?: string | null
  syncPaused?: boolean | null
  channelFactDetail?: { shopifyStatus?: string; [key: string]: unknown } | null
  offerActiveHonoured?: boolean
}
