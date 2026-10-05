/**
 * Ads wave 4a — what Settings → Advertising says about each Amazon Ads account, and which reading control it offers.
 *
 * Three fields of the account decide it (the why is in apps/api/src/services/advertising/ads-read-switch.service.ts,
 * whose `adsAccountStateOf` is the same rule with the same words for Settings → Channels → Accounts):
 *   isActive         Nexus reads the account's real data from Amazon.
 *   mode             'production' is the first permission to spend; 'sandbox' makes every write refused.
 *   writesEnabledAt  the second permission to spend.
 * "Read this market's data" sets `isActive` only, so reading never turns into spending.
 */
import type { ActionImpact } from '@/design-system/grid'
import type { Tone } from '@/design-system/primitives'

export interface AdsAccountFields {
  marketplace: string
  isActive: boolean
  mode: string
  writesEnabledAt: string | null
}

export type AdsAccountState = 'live_writes_on' | 'reading_only' | 'not_read'

export const ADS_ACCOUNT_STATE_LABEL: Readonly<Record<AdsAccountState, string>> = Object.freeze({
  live_writes_on: 'Live · writes on',
  reading_only: 'Reading only',
  not_read: 'Not read',
})

const TONE: Readonly<Record<AdsAccountState, Tone>> = Object.freeze({
  live_writes_on: 'success',
  reading_only: 'info',
  not_read: 'neutral',
})

export function adsAccountStateOf(c: Pick<AdsAccountFields, 'isActive' | 'mode' | 'writesEnabledAt'>): AdsAccountState {
  if (!c.isActive) return 'not_read'
  return c.mode === 'production' && c.writesEnabledAt ? 'live_writes_on' : 'reading_only'
}

export function adsAccountStateTone(state: AdsAccountState): Tone {
  return TONE[state]
}

/**
 * The reading control a card offers: start reading, stop reading, or none. Stopping is not offered while writes are on
 * (the API refuses it too): the engines would keep writing to an account Nexus no longer reads.
 */
export function readActionFor(c: Pick<AdsAccountFields, 'isActive' | 'writesEnabledAt'>): 'read' | 'stop' | null {
  if (!c.isActive) return 'read'
  return c.writesEnabledAt ? null : 'stop'
}

/** Promote to production is offered once Nexus reads the account: first read, then (only to spend) promote. */
export function canOfferPromote(c: Pick<AdsAccountFields, 'isActive' | 'mode'>): boolean {
  return c.isActive && c.mode !== 'production'
}

/** The one line under the account: what is true now, and the next step. */
export function nextStepText(c: AdsAccountFields): string {
  const state = adsAccountStateOf(c)
  if (state === 'not_read') return 'Nexus does not read this account. Next: Read this market’s data.'
  if (state === 'live_writes_on') return 'Live · then allowlist this market’s campaigns so the engine can change their bids'
  if (c.mode !== 'production') return 'Nexus reads this account; writes stay off. Only to spend here: Promote to production, then Enable writes.'
  return 'Nexus reads this account; writes are off. Only to spend here: Enable writes.'
}

/** The confirmation for one press. Plain words; it says that writes stay off. */
export function readConfirmImpact(c: AdsAccountFields, action: 'read' | 'stop'): ActionImpact {
  const market = c.marketplace || 'this market'
  if (action === 'read') {
    return {
      level: 'confirm',
      title: `Read ${market}’s Amazon Ads data?`,
      consequences: [
        `Nexus starts reading this account’s real data from Amazon (campaigns, reports, budgets) from the next sync runs.`,
        `Writes stay off: Nexus cannot change bids, budgets or campaigns in ${market}. That would need Promote to production, Enable writes and the campaign allowlist, each its own click.`,
        'Reading this account uses more of the Amazon Ads request quota.',
        'You can stop at any time with “Stop reading”.',
      ],
    }
  }
  return {
    level: 'confirm',
    title: `Stop reading ${market}’s Amazon Ads data?`,
    consequences: [
      'Nexus stops reading this account from the next sync runs. The data already read stays.',
      'Writes are off for this account and stay off.',
      'You can switch reading back on at any time.',
    ],
  }
}
