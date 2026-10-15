/**
 * P1.1 step 2 — the account's state, read fresh for every call. Its own module so a unit test of a
 * channel client can stand it in with one line (test-support/gateway-stubs.ts).
 */
import prisma from '../../db.js'
import { MERCHANT_DATA_SOURCES_TOOL } from './google-merchant-calls.js'

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

/**
 * Merchant Center (G12, 2026-10-16): is this Merchant Center account the one a person chose for the business, through this
 * Google connection (its GoogleAccountLink, product MERCHANT)? Read in the business the call runs in (row-level security),
 * so an account another business chose is never one: a Merchant Center id never crosses businesses.
 */
export async function googleMerchantAccountLinked(connectionId: string, merchantId: string): Promise<boolean> {
  const link = await prisma.googleAccountLink.findFirst({ where: { connectionId, product: 'MERCHANT', externalId: merchantId }, select: { id: true } })
  return link !== null
}

/**
 * Merchant Center (G12): did Nexus make this data source, in this Merchant Center account, for the business the call runs
 * in? Its create is in Nexus's own change records (AgentChange of set-google-merchant-data-sources with after.created,
 * row-level security: only this business's rows). Every Merchant change but a create must name one (gateway.ts).
 */
export async function googleMerchantDataSourceNexusMade(merchantId: string, dataSourceId: string): Promise<boolean> {
  const row = await prisma.agentChange.findFirst({
    where: {
      toolName: MERCHANT_DATA_SOURCES_TOOL,
      AND: [
        { after: { path: ['created'], equals: true } },
        { after: { path: ['merchantCenterId'], equals: merchantId } },
        { after: { path: ['dataSourceId'], equals: dataSourceId } },
      ],
    },
    select: { id: true },
  })
  return row !== null
}
