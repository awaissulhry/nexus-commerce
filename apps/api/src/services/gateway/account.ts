/**
 * P1.1 step 2 — the account's state, read fresh for every call. Its own module so a unit test of a
 * channel client can stand it in with one line (test-support/gateway-stubs.ts).
 */
import prisma from '../../db.js'

export interface GatewayAccountState { authStatus: string; isActive: boolean; displayName: string | null }

export async function accountStatusOf(connectionId: string): Promise<GatewayAccountState | null> {
  return prisma.channelConnection.findUnique({ where: { id: connectionId }, select: { authStatus: true, isActive: true, displayName: true } })
}

/**
 * Google Ads changes (2026-10-15): is this Google Ads customer the Ads account a person chose for the business, through
 * this Google connection? Read in the business the call runs in (row-level security), so a customer another business
 * chose is never one.
 */
export async function googleAdsCustomerLinked(connectionId: string, customerId: string): Promise<boolean> {
  const link = await prisma.googleAccountLink.findFirst({ where: { connectionId, product: 'ADS', externalId: customerId }, select: { id: true } })
  return link !== null
}
