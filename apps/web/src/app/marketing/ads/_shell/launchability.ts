/**
 * CC-19 — "launchable" means a campaign created there can really reach Amazon.
 *
 * The console used to call a market launchable when its connection was active and in production. The write gate asks
 * two more things before anything is sent (`checkAdsWriteGate`): writes enabled on that profile (`writesEnabledAt`),
 * and a checked list of Amazon's currency, bid and budget limits for that market (`@nexus/shared/ads-market-limits`).
 * A launch into a production market that failed either check was created in Nexus only, and nothing said so.
 *
 * Every builder now offers only markets that pass all four, and every other connected market stays visible with the
 * reason it is not offered. Pure, so it is tested without a browser.
 */
import { marketLimitsOf } from '@nexus/shared/ads-market-limits'

export interface ConnectionFacts {
  code: string
  isActive: boolean
  mode: string
  writesEnabled: boolean
}

export interface Launchability {
  /** A campaign launched here can reach Amazon. */
  launchable: boolean
  /** Why not, in a sentence. `null` when launchable. */
  whyNot: string | null
  /** The same reason in two or three words, for a menu row. */
  short: string | null
}

export function launchability(c: ConnectionFacts): Launchability {
  if (!c.isActive) {
    return { launchable: false, short: 'not active', whyNot: `The ${c.code} Amazon Ads connection is not active, so campaigns cannot be launched there.` }
  }
  if (c.mode !== 'production') {
    return { launchable: false, short: c.mode || 'sandbox', whyNot: `${c.code} is a ${c.mode || 'sandbox'} connection: a campaign launched there would never serve to shoppers.` }
  }
  if (!c.writesEnabled) {
    return { launchable: false, short: 'writes off', whyNot: `Writes are not enabled for the ${c.code} Amazon Ads profile, so a campaign would be saved in Nexus only. Enable writes in Settings → Advertising first.` }
  }
  if (!marketLimitsOf(c.code)) {
    return { launchable: false, short: 'limits not known', whyNot: `Amazon's bid and budget limits for ${c.code} are not known yet, so Nexus sends nothing to Amazon there.` }
  }
  return { launchable: true, whyNot: null, short: null }
}
