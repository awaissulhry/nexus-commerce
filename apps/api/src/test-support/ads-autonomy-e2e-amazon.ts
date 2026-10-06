/**
 * ADS AUTONOMY final test — the only two stand-ins of the end-to-end suites (ads-playbook/e2e-autonomy-*.vitest.test.ts):
 * Amazon's Ads API client (ads-api-client.ts) and the e-mail transport. Everything else in those suites is the real
 * Nexus code. This module imports nothing of the app at load, so a vi.mock factory may load it without a cycle.
 *
 *   amazon     a small Amazon that keeps what it was sent: every create answers a fresh id and is stored, every update
 *              and archive changes what is stored, every list (the launch's read-back, the placement read before a
 *              write) answers from the store, an Auto ad group holds Amazon's four Auto groups. A negative create still
 *              passes the client's own negation policy (ads-negation-policy.ts), as the wire does. Every call is kept
 *              in order (name, what it was asked). A call this Amazon does not know is kept in `unexpected` and
 *              answered with nothing, so a suite can name the Amazon call it did not expect.
 *   mailbox    every e-mail Nexus sends, kept instead of sent.
 *
 * Values are made up (public repo).
 */
type Json = Record<string, any>

export interface AmazonCall { name: string; args: unknown[] }

const stores = () => ({
  campaigns: new Map<string, Json>(),
  adGroups: new Map<string, Json>(),
  keywords: new Map<string, Json>(),
  targets: new Map<string, Json>(),
  productAds: new Map<string, Json>(),
  negativeKeywords: new Map<string, Json>(),
  negativeTargets: new Map<string, Json>(),
  portfolios: new Map<string, Json>(),
})

export const amazon = {
  calls: [] as AmazonCall[],
  unexpected: [] as AmazonCall[],
  /** Every Amazon Ads profile any call carried, never reset: which accounts were reached at all. */
  profiles: new Set<string>(),
  n: 0,
  store: stores(),
  /** Forget the calls (what Amazon holds stays). */
  reset() {
    this.calls = []
    this.unexpected = []
  },
  /** The calls of one name (or several), in order. */
  named(...names: string[]) {
    return this.calls.filter((c) => names.includes(c.name))
  },
  /** Every bid Amazon was sent (creates and updates), in major units. */
  bids() {
    return this.calls.flatMap((c) => {
      const a = (c.args[1] ?? {}) as Json
      if (c.name === 'createAdGroup') return [a.defaultBid]
      if (c.name === 'createKeyword' || c.name === 'createTarget') return [a.bid]
      if (c.name === 'updateTarget' || c.name === 'updateAdGroup') { const p = (c.args[2] ?? {}) as Json; return [p.bid ?? p.defaultBid].filter((x) => x != null) }
      return []
    })
  },
}

const AUTO_CLAUSES = ['QUERY_HIGH_REL_MATCHES', 'QUERY_BROAD_REL_MATCHES', 'ASIN_SUBSTITUTE_RELATED', 'ASIN_ACCESSORY_RELATED']
const STRATEGY: Record<string, string> = { legacyForSales: 'LEGACY_FOR_SALES', autoForSales: 'AUTO_FOR_SALES', manual: 'MANUAL' }
const upper = (s: unknown, fallback = 'ENABLED') => (typeof s === 'string' && s ? s.toUpperCase() : fallback)
const nextId = (prefix: string) => `${prefix}-${++amazon.n}`

/** A list call's filters, as the v3 list bodies apply them. */
function listed(store: Map<string, Json>, opts: { campaignIds?: string[]; adGroupIds?: string[]; states?: readonly string[] } = {}) {
  return [...store.values()].filter((e) =>
    (!opts.campaignIds?.length || opts.campaignIds.includes(String(e.campaignId)))
    && (!opts.adGroupIds?.length || opts.adGroupIds.includes(String(e.adGroupId)))
    && (!opts.states?.length || opts.states.map((s) => s.toUpperCase()).includes(String(e.state).toUpperCase())))
    .map((e) => structuredClone(e))
}

/** The mocked module: the real one, every function that would reach Amazon replaced by the small Amazon above. */
export function amazonAdsClient(real: Json): Json {
  const s = () => amazon.store
  const record = (name: string, args: unknown[]) => {
    amazon.calls.push({ name, args })
    const profileId = (args[0] as Json | undefined)?.profileId
    if (profileId) amazon.profiles.add(String(profileId))
  }
  const policy = async () => (await import('../services/advertising/ads-negation-policy.js')).assertNegativeWriteAllowed
  const created = (resource: string, idField: string, id: string) => {
    const raw = { [resource]: { success: [{ index: 0, [idField]: id }], error: [] } }
    return { ok: true, mode: 'live', externalId: real.v3CreateResult(raw, resource, idField).externalId, rawResponse: raw, error: null }
  }
  const updated = (resource: string, idField: string, id: string) => ({ ok: true, mode: 'live', rawResponse: { [resource]: { success: [{ index: 0, [idField]: id }], error: [] } }, error: null })

  const known: Json = {
    async createCampaign(...args: unknown[]) {
      const input = args[1] as Json
      if (input?.dryRun) return real.createCampaign(...args)
      record('createCampaign', args)
      const campaignId = nextId('AMZ-C')
      s().campaigns.set(campaignId, {
        campaignId, name: input.name, targetingType: input.targetingType, state: upper(input.state), budget: { budget: input.dailyBudget, budgetType: 'DAILY' },
        dynamicBidding: { strategy: STRATEGY[input.biddingStrategy ?? 'legacyForSales'], placementBidding: [] }, portfolioId: input.portfolioId ?? null, startDate: input.startDate,
      })
      return created('campaigns', 'campaignId', campaignId)
    },
    async createAdGroup(...args: unknown[]) {
      record('createAdGroup', args)
      const input = args[1] as Json
      const adGroupId = nextId('AMZ-G')
      s().adGroups.set(adGroupId, { adGroupId, campaignId: input.externalCampaignId, name: input.name, defaultBid: input.defaultBid, state: upper(input.state), extendedData: { servingStatus: 'AD_GROUP_STATUS_ENABLED' } })
      // Amazon makes an Auto campaign's four Auto groups itself.
      if (String(s().campaigns.get(input.externalCampaignId)?.targetingType).toUpperCase() === 'AUTO') {
        for (const type of AUTO_CLAUSES) {
          const targetId = `AUTO-${adGroupId}-${type}`
          s().targets.set(targetId, { targetId, campaignId: input.externalCampaignId, adGroupId, expressionType: 'AUTO', expression: [{ type }], bid: input.defaultBid, state: 'ENABLED' })
        }
      }
      return created('adGroups', 'adGroupId', adGroupId)
    },
    async createKeyword(...args: unknown[]) {
      record('createKeyword', args)
      const input = args[1] as Json
      const keywordId = nextId('AMZ-K')
      s().keywords.set(keywordId, { keywordId, campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, keywordText: input.keywordText, matchType: input.matchType, bid: input.bid, state: upper(input.state) })
      return created('keywords', 'keywordId', keywordId)
    },
    async createTarget(...args: unknown[]) {
      record('createTarget', args)
      const input = args[1] as Json
      const targetId = nextId('AMZ-T')
      s().targets.set(targetId, { targetId, campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, expressionType: input.expressionType, expression: input.expression, bid: input.bid, state: upper(input.state) })
      return created('targetingClauses', 'targetId', targetId)
    },
    async createProductAd(...args: unknown[]) {
      record('createProductAd', args)
      const input = args[1] as Json
      const adId = nextId('AMZ-A')
      s().productAds.set(adId, { adId, campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, sku: input.sku, asin: input.asin, state: upper(input.state) })
      return created('productAds', 'adId', adId)
    },
    async createNegativeKeyword(...args: unknown[]) {
      const input = args[1] as Json
      const v3 = { campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, keywordText: input.keywordText, matchType: `NEGATIVE_${input.matchType}`, state: upper(input.state) }
      // The wire refuses what the negation policy refuses (liveCall does it in production).
      await (await policy())({ method: 'POST', path: '/sp/negativeKeywords', body: { negativeKeywords: [v3] } })
      record('createNegativeKeyword', args)
      const negativeKeywordId = nextId('AMZ-NK')
      s().negativeKeywords.set(negativeKeywordId, { negativeKeywordId, keywordId: negativeKeywordId, ...v3 })
      return { ok: true, mode: 'live', externalId: negativeKeywordId, rawResponse: { negativeKeywords: { success: [{ index: 0, negativeKeywordId }], error: [] } } }
    },
    async createNegativeProductTarget(...args: unknown[]) {
      const input = args[1] as Json
      const v3 = { campaignId: input.externalCampaignId, adGroupId: input.externalAdGroupId, expression: [{ type: 'ASIN_SAME_AS', value: input.asin }], state: upper(input.state) }
      await (await policy())({ method: 'POST', path: '/sp/negativeTargets', body: { negativeTargetingClauses: [v3] }, personConfirmed: input.personConfirmed === true })
      record('createNegativeProductTarget', args)
      const targetId = nextId('AMZ-NT')
      s().negativeTargets.set(targetId, { targetId, ...v3 })
      return { ok: true, mode: 'live', externalId: targetId, rawResponse: { negativeTargetingClauses: { success: [{ index: 0, targetId }], error: [] } } }
    },
    async createPortfolio(...args: unknown[]) {
      record('createPortfolio', args)
      const input = args[1] as Json
      const portfolioId = nextId('AMZ-PF')
      s().portfolios.set(portfolioId, { portfolioId, name: input.name, state: input.state ?? 'enabled', inBudget: true })
      return { ok: true, mode: 'live', externalId: portfolioId }
    },
    async updatePortfolio(...args: unknown[]) {
      record('updatePortfolio', args)
      const input = args[1] as Json
      const p = s().portfolios.get(input.portfolioId)
      if (p) Object.assign(p, { ...(input.name ? { name: input.name } : {}), ...(input.state ? { state: input.state } : {}) })
      return { ok: true, mode: 'live', rawResponse: {}, error: null }
    },
    async listPortfolios(...args: unknown[]) { record('listPortfolios', args); return [...s().portfolios.values()].map((p) => structuredClone(p)) },
    async listCampaignsV3(...args: unknown[]) { record('listCampaignsV3', args); return listed(s().campaigns, args[1] as Json) },
    async listCampaignsServing(...args: unknown[]) {
      record('listCampaignsServing', args)
      return listed(s().campaigns, args[1] as Json).map((c) => ({ campaignId: c.campaignId, name: c.name, state: c.state, portfolioId: c.portfolioId, extendedData: { servingStatus: c.state === 'ENABLED' ? 'CAMPAIGN_STATUS_ENABLED' : `CAMPAIGN_${c.state}` } }))
    },
    async updateCampaign(...args: unknown[]) {
      record('updateCampaign', args)
      const [, id, patch] = args as [unknown, string, Json]
      const c = s().campaigns.get(id)
      if (c && patch) {
        if (patch.name) c.name = patch.name
        if (patch.portfolioId !== undefined) c.portfolioId = patch.portfolioId
        if (patch.state) c.state = upper(patch.state)
        if (patch.dailyBudget != null) c.budget = { budget: patch.dailyBudget, budgetType: 'DAILY' }
        if (patch.biddingStrategy) c.dynamicBidding.strategy = STRATEGY[patch.biddingStrategy]
        if (patch.placementBidding) c.dynamicBidding.placementBidding = patch.placementBidding.map((p: Json) => ({ placement: p.placement, percentage: p.percentage }))
      }
      return updated('campaigns', 'campaignId', id)
    },
    async listAdGroupsV3(...args: unknown[]) { record('listAdGroupsV3', args); return listed(s().adGroups, args[1] as Json) },
    async updateAdGroup(...args: unknown[]) {
      record('updateAdGroup', args)
      const [, id, patch] = args as [unknown, string, Json]
      const g = s().adGroups.get(id)
      if (g && patch) Object.assign(g, { ...(patch.defaultBid != null ? { defaultBid: patch.defaultBid } : {}), ...(patch.state ? { state: upper(patch.state) } : {}), ...(patch.name ? { name: patch.name } : {}) })
      return updated('adGroups', 'adGroupId', id)
    },
    async listKeywords(...args: unknown[]) { record('listKeywords', args); return listed(s().keywords, args[1] as Json) },
    async listTargets(...args: unknown[]) { record('listTargets', args); return listed(s().targets, args[1] as Json) },
    async updateTarget(...args: unknown[]) {
      record('updateTarget', args)
      const [, id, patch] = args as [unknown, string, Json]
      const t = s().keywords.get(id) ?? s().targets.get(id) ?? s().negativeKeywords.get(id) ?? s().negativeTargets.get(id)
      if (t && patch) Object.assign(t, { ...(patch.bid != null ? { bid: Number(patch.bid) } : {}), ...(patch.state ? { state: upper(patch.state) } : {}) })
      return { ok: true, mode: 'live', rawResponse: {}, error: null }
    },
    async listProductAds(...args: unknown[]) { record('listProductAds', args); return listed(s().productAds, args[1] as Json) },
    async updateProductAd(...args: unknown[]) {
      record('updateProductAd', args)
      const [, id, patch] = args as [unknown, string, Json]
      const a = s().productAds.get(id)
      if (a && patch?.state) a.state = upper(patch.state)
      return updated('productAds', 'adId', id)
    },
    async listNegativeKeywords(...args: unknown[]) { record('listNegativeKeywords', args); return listed(s().negativeKeywords, args[1] as Json) },
    async listNegativeTargets(...args: unknown[]) { record('listNegativeTargets', args); return listed(s().negativeTargets, args[1] as Json) },
    async archiveSpEntity(...args: unknown[]) {
      record('archiveSpEntity', args)
      const [, entity, id] = args as [unknown, string, string]
      const store = ({ campaign: s().campaigns, adGroup: s().adGroups, keyword: s().keywords, target: s().targets, productAd: s().productAds } as Record<string, Map<string, Json>>)[entity]
      const e = store?.get(id)
      if (e) e.state = 'ARCHIVED'
      return { ok: true, mode: 'live', rawResponse: {}, error: null }
    },
    async listProductEligibility(...args: unknown[]) {
      record('listProductEligibility', args)
      const input = (args[1] ?? {}) as { products?: Array<{ asin?: string; sku?: string }> }
      return (input.products ?? []).map((p) => ({ asin: p.asin ?? null, sku: p.sku ?? null, overallStatus: 'ELIGIBLE', eligibilityStatusList: [] }))
    },
    async liveCall(...args: unknown[]) { amazon.unexpected.push({ name: 'liveCall', args }); throw new Error('E2E: a direct Amazon call (liveCall) this test Amazon does not answer') },
    async liveCreate(...args: unknown[]) { amazon.unexpected.push({ name: 'liveCreate', args }); throw new Error('E2E: a direct Amazon create (liveCreate) this test Amazon does not answer') },
  }
  const out: Json = { ...real, ...known }
  // Every other call that would reach Amazon: kept as unexpected, answered with nothing.
  for (const [name, value] of Object.entries(real)) {
    if (name in known || typeof value !== 'function') continue
    if (!/^(create|update|archive|list|get|fetch|test)[A-Z]/.test(name)) continue
    out[name] = async (...args: unknown[]) => {
      amazon.unexpected.push({ name, args })
      return name.startsWith('list') || name.startsWith('get') ? [] : { ok: false, mode: 'live', externalId: null, rawResponse: null, error: `E2E: ${name} is not answered by this test Amazon` }
    }
  }
  return out
}

export const mailbox = {
  sent: [] as Array<{ to: string | string[]; subject: string; text?: string; html?: string; tag?: string }>,
  reset() { this.sent = [] },
}

/** The mocked e-mail transport: the real module, sendEmail kept in the mailbox. */
export function emailTransport(real: Json): Json {
  return {
    ...real,
    sendEmail: async (message: { to: string | string[]; subject: string; text?: string; html?: string; tag?: string }) => {
      mailbox.sent.push(message)
      return { ok: true, provider: 'resend', dryRun: false, messageId: `e2e-${mailbox.sent.length}` }
    },
  }
}
