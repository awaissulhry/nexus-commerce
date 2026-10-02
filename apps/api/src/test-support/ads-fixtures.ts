/**
 * MCP full control A4–A10 — one small Amazon ads account for the ad change tool tests (PGlite or a real PostgreSQL),
 * written through the caller's client inside the caller's business. Fake ids only.
 *
 *   c-it   SP · IT · EUR · on the live-write allowlist · targets t-it (45¢), t-sup (2¢, suppressed from 50¢), t-low (3¢)
 *   c-uk   SP · UK · GBP · allowlisted · target t-uk (60¢)
 *   c-off  SP · IT · EUR · NOT allowlisted · target t-off (30¢)
 *   c-sb   SB · IT · allowlisted · target t-sb (40¢)
 *   c-pin  SP · IT · allowlisted · bids pinned by hand · target t-pin (40¢)
 *   a negative "free" in c-it's ad group; production Amazon Ads connections with writes enabled for IT and UK
 */
type Db = Record<string, any>

/** The UK campaign's own budget currency, as Amazon stores it on the campaign. */
const UK_CAMPAIGN_CURRENCY = 'GBP'

export const ADS_FIXTURE = {
  campaigns: ['c-it', 'c-uk', 'c-off', 'c-sb', 'c-pin'],
  profiles: { IT: 'P-IT-TEST', UK: 'P-UK-TEST' },
} as const

export async function seedAdsFixture(db: Db, opts: { prefix?: string } = {}) {
  const p = opts.prefix ?? ''
  const id = (s: string) => `${p}${s}`
  const campaign = (key: string, name: string, marketplace: string, extra: Record<string, unknown> = {}) =>
    db.campaign.create({
      data: {
        id: id(key), name: `${p}${name}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace, externalCampaignId: `EXT-${id(key)}`,
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra,
      },
    })
  await campaign('c-it', 'Italy exact', 'IT')
  await campaign('c-uk', 'UK exact', 'UK', { dailyBudgetCurrency: UK_CAMPAIGN_CURRENCY, dailyBudget: '15.00' })
  await campaign('c-off', 'Italy not allowlisted', 'IT', { liveBidWritesEnabled: false })
  await campaign('c-sb', 'Italy brands', 'IT', { type: 'SB', adProduct: 'SPONSORED_BRANDS' })
  await campaign('c-pin', 'Italy pinned', 'IT', { pinBids: true, pinNote: 'held by hand for a test' })
  const group = (campaignKey: string) =>
    db.adGroup.create({ data: { id: id(`g-${campaignKey}`), campaignId: id(campaignKey), name: `${p}group ${campaignKey}`, externalAdGroupId: `EXT-${id(`g-${campaignKey}`)}` } })
  for (const key of ADS_FIXTURE.campaigns) await group(key)
  const target = (key: string, campaignKey: string, text: string, bidCents: number, extra: Record<string, unknown> = {}) =>
    db.adTarget.create({
      data: {
        id: id(key), adGroupId: id(`g-${campaignKey}`), kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents,
        externalTargetId: `EXT-${id(key)}`, ...extra,
      },
    })
  await target('t-it', 'c-it', 'race jacket', 45)
  await target('t-sup', 'c-it', 'leather gloves', 2, { suppressedFromBidCents: 50 })
  await target('t-low', 'c-it', 'cheap boots', 3)
  await target('t-uk', 'c-uk', 'motorbike boots', 60)
  await target('t-off', 'c-off', 'winter jacket', 30)
  await target('t-sb', 'c-sb', 'brand jacket', 40)
  await target('t-pin', 'c-pin', 'pinned jacket', 40)
  await target('t-neg', 'c-it', 'free', 0, { isNegative: true, negativeLevel: 'AD_GROUP', expressionType: 'NEGATIVE_EXACT' })
  for (const [marketplace, profileId] of Object.entries(ADS_FIXTURE.profiles)) {
    await db.amazonAdsConnection.create({
      data: { profileId: `${p}${profileId}`, marketplace, region: 'EU', mode: 'production', writesEnabledAt: new Date(), isActive: true },
    })
  }
  return { id }
}
