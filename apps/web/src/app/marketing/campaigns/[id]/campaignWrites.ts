/**
 * Google Ads step 1a, W3 (defect D1) — what the legacy campaign page (/marketing/campaigns/[id]) may offer.
 *
 * Nexus does not change campaigns in Google, Meta or TikTok: the API refuses those writes (409 `channel_read_only`),
 * and before that it marked a pause or a budget as done although the channel was never called. So for those channels
 * the page offers no Pause / Resume, no budget edit and no Launch, and says where the change is made instead. And a
 * campaign of theirs that Nexus never read shows "—", not €0.00: an amount nobody measured is not a zero.
 */

/** The channels Nexus reads at most and never changes (step 1a). */
export const READ_ONLY_CHANNELS = ['GOOGLE', 'META', 'TIKTOK'] as const

const WHERE: Record<(typeof READ_ONLY_CHANNELS)[number], string> = {
  GOOGLE: 'Google Ads',
  META: 'Meta Ads Manager',
  TIKTOK: 'TikTok Ads Manager',
}

export function isReadOnlyChannel(channel: string): channel is (typeof READ_ONLY_CHANNELS)[number] {
  return (READ_ONLY_CHANNELS as readonly string[]).includes(channel)
}

export interface CampaignWrites {
  canPauseResume: boolean
  canEditBudget: boolean
  canLaunch: boolean
  /** Shown instead of the controls on a read-only channel. */
  readOnlyNote: string | null
}

export function campaignWrites(c: { channel: string; status: string }): CampaignWrites {
  if (isReadOnlyChannel(c.channel)) {
    return {
      canPauseResume: false,
      canEditBudget: false,
      canLaunch: false,
      readOnlyNote: `Changes are made in ${WHERE[c.channel]}. Nexus does not change this campaign.`,
    }
  }
  return {
    canPauseResume: c.status === 'ACTIVE' || c.status === 'PAUSED',
    canEditBudget: true,
    canLaunch: c.channel === 'INTERNAL',
    readOnlyNote: null,
  }
}

/**
 * The money tiles' amounts: `null` (printed "—") for a read-only channel's campaign that has no metric row at all —
 * Nexus never read it, so its spend and sales are unknown, not 0.
 */
export function campaignMoney(
  c: { channel: string; spendCents: number; salesCents: number; acos: string | null; roas: string | null },
  metricRows: number,
): { spendCents: number | null; salesCents: number | null; acos: string | null; roas: string | null } {
  if (isReadOnlyChannel(c.channel) && metricRows === 0) return { spendCents: null, salesCents: null, acos: null, roas: null }
  return { spendCents: c.spendCents, salesCents: c.salesCents, acos: c.acos, roas: c.roas }
}
