/**
 * Shared stock step 7b — reordering shows what a business's shared pool gave to another business's orders as its
 * own row: the API sends it as channel SHARED_POOL with the borrowing business's name as the marketplace.
 */
export const POOL_DEMAND_CHANNEL = 'SHARED_POOL'

/** "AMAZON · IT", or "Shared stock · Borrower B" for pool demand. */
export function channelLabel(channel: string, marketplace: string): string {
  return channel === POOL_DEMAND_CHANNEL ? `Shared stock · ${marketplace}` : `${channel} · ${marketplace}`
}

/** A "CHANNEL:MARKETPLACE" key as the rows show it: "AMAZON·IT", or "Shared stock · Borrower B". */
export function channelKeyLabel(key: string): string {
  const at = key.indexOf(':')
  if (at >= 0 && key.slice(0, at) === POOL_DEMAND_CHANNEL) return channelLabel(POOL_DEMAND_CHANNEL, key.slice(at + 1))
  return key.replace(':', '·')
}
