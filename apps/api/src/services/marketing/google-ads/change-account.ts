/**
 * Google Ads changes (2026-10-15) — the ONE Google Ads account a change or a live read of THIS business goes to: the
 * business's chosen Google Ads account (its ADS GoogleAccountLink, through its own Google connection). Never an account
 * another business chose; never a customer id a caller names.
 */
import prisma from '../../../db.js'
import { listReadTargets } from './targets.js'
import { liveRows } from './write-client.js'
import type { GoogleAdsTarget } from './types.js'

export interface GoogleChangeAccount {
  target: GoogleAdsTarget
  /** The Google connection (channel-connections) the calls go through. */
  accountId: string
  customerId: string
  name: string | null
  /** ISO 4217: every amount of a change is in it, never converted. */
  currency: string
  timeZone: string | null
}

/**
 * The business's Google Ads account, or why there is none. `accountId` (a connectionId) picks one when the business has
 * more than one; none named and more than one = a refusal that lists them.
 */
export async function googleChangeAccount(accountId?: string | null): Promise<GoogleChangeAccount | { refusal: string }> {
  const targets = await listReadTargets()
  if (targets.length === 0) {
    return { refusal: 'This business has no Google Ads account chosen in Nexus. A person chooses one in Settings › Channels › Google › Choose accounts.' }
  }
  const wanted = accountId?.trim()
  const matches = wanted ? targets.filter((t) => t.connectionId === wanted) : targets
  if (matches.length === 0) return { refusal: `The Google account ${wanted} is not this business's Google Ads account (channel-connections lists it).` }
  if (matches.length > 1) return { refusal: `This business has ${matches.length} Google Ads accounts: name one with accountId (${matches.map((t) => t.connectionId).join(', ')}).` }
  const target = matches[0]
  const stored = await prisma.googleAdsCustomer.findFirst({
    where: { customerId: target.customerId },
    select: { descriptiveName: true, currencyCode: true, timeZone: true },
  })
  if (stored?.currencyCode) {
    return { target, accountId: target.connectionId, customerId: target.customerId, name: stored.descriptiveName ?? null, currency: stored.currencyCode, timeZone: stored.timeZone ?? null }
  }
  // Not read yet: ask Google (one operation).
  const rows = await liveRows<{ customer?: { descriptiveName?: string; currencyCode?: string; timeZone?: string } }>(
    target, 'SELECT customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer', 'ads.search.live.customer',
  )
  const customer = rows[0]?.customer
  if (!customer?.currencyCode) return { refusal: 'Google Ads did not say this account\'s currency, so Nexus cannot show the amounts of a change. Try again later.' }
  return { target, accountId: target.connectionId, customerId: target.customerId, name: customer.descriptiveName ?? null, currency: customer.currencyCode, timeZone: customer.timeZone ?? null }
}
