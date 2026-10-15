/**
 * Google Ads programme 2, G1 (2026-10-15) — the account-wide live reads: every field of another resource filtered on is
 * selected too (Google refused an unselected campaign.status on 2026-10-15), a label id is checked before anything is
 * sent, a lookup's search word cannot break out of its literal, and how Google's rows read (micros → cents, a default
 * conversion value → cents, goals that differ from the account's, GA4 properties from GA4 conversion actions, a part
 * Google refuses named in notRead).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rows: vi.fn() }))
vi.mock('./write-client.js', () => ({ liveRows: h.rows }))

import {
  ACCOUNT_BUDGETS_QUERY, ACCOUNT_SETTINGS_QUERY, accountLookupQuery, accountLookupRowOf, accountSettingsOf, BILLING_SETUPS_QUERY, CAMPAIGN_GOAL_CONFIG_QUERY,
  CAMPAIGN_GOALS_QUERY, CONVERSION_ACTIONS_QUERY, conversionActionOf, CUSTOMER_GOALS_QUERY, DATA_LINKS_QUERY, EXPERIMENT_ARMS_QUERY, EXPERIMENTS_QUERY,
  labelUsesQueries, LABELS_QUERY, liveBilling, liveConversions, liveExperiments, liveLabels, liveLinks, PRODUCT_LINK_INVITATIONS_QUERY, PRODUCT_LINKS_QUERY,
  USER_ACCESS_QUERY, USER_INVITATIONS_QUERY,
} from './live-account.js'

const target = { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }

describe('the queries', () => {
  const all = {
    ACCOUNT_SETTINGS_QUERY, CONVERSION_ACTIONS_QUERY, CUSTOMER_GOALS_QUERY, CAMPAIGN_GOALS_QUERY, CAMPAIGN_GOAL_CONFIG_QUERY, LABELS_QUERY,
    EXPERIMENTS_QUERY, EXPERIMENT_ARMS_QUERY, USER_ACCESS_QUERY, USER_INVITATIONS_QUERY, BILLING_SETUPS_QUERY, ACCOUNT_BUDGETS_QUERY,
    PRODUCT_LINKS_QUERY, PRODUCT_LINK_INVITATIONS_QUERY, DATA_LINKS_QUERY,
    ...Object.fromEntries(Object.entries(labelUsesQueries('77')).map(([k, q]) => [`label ${k}`, q])),
    userLists: accountLookupQuery('user-lists', 'moto'), customAudiences: accountLookupQuery('custom-audiences'), combined: accountLookupQuery('combined-audiences', 'x'),
    lifeEvents: accountLookupQuery('life-events', 'moving'),
  }

  it('every field filtered on that is not of the FROM resource is selected', () => {
    for (const [name, q] of Object.entries(all)) {
      const from = /FROM (\w+)/.exec(q)![1]
      const select = q.slice(7, q.indexOf(' FROM ')).split(', ')
      const where = /WHERE (.*?)(?: ORDER BY| LIMIT|$)/.exec(q)?.[1] ?? ''
      for (const field of where.replace(/'[^']*'/g, "''").match(/\b[a-z_]+\.[a-z_.]+/g) ?? []) {
        if (!field.startsWith(`${from}.`)) expect(select, `${name}: ${field}`).toContain(field)
      }
    }
  })

  it('a label is a Google id or nothing is sent; a search word stays inside its literal', () => {
    expect(labelUsesQueries('77').keywords).toContain('WHERE label.id = 77 AND ad_group_criterion.status != \'REMOVED\'')
    expect(() => labelUsesQueries('7 OR 1=1')).toThrow(/Nothing was sent/)
    expect(accountLookupQuery('user-lists', "x' OR user_list.id > '0")).toContain("user_list.name LIKE '%x  OR user list.id >  0%'")
    expect(accountLookupQuery('custom-audiences', '100%_off')).toContain("LIKE '%100  off%'")
    expect(accountLookupQuery('combined-audiences')).not.toContain('LIKE')
    expect(accountLookupQuery('user-lists')).toMatch(/LIMIT 200$/)
    expect(accountLookupQuery('life-events')).toBe('SELECT life_event.id, life_event.name, life_event.parent, life_event.launched_to_all, life_event.availabilities FROM life_event ORDER BY life_event.name LIMIT 200')
    expect(accountLookupQuery('life-events', "moving' OR '1")).toContain("FROM life_event WHERE life_event.name LIKE '%moving  OR  1%' ORDER BY")
  })
})

describe('the rows', () => {
  beforeEach(() => { h.rows.mockReset() })

  it('account settings: auto-tagging, tracking, time zone, currency, conversion tracking', () => {
    expect(accountSettingsOf({
      customer: {
        id: '1234567890', descriptiveName: 'Shop', currencyCode: 'EUR', timeZone: 'Europe/Rome', autoTaggingEnabled: true, trackingUrlTemplate: '{lpurl}?src=ads',
        finalUrlSuffix: 'utm_source=google', optimizationScore: 0.873, containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        conversionTrackingSetting: { conversionTrackingId: '555', googleAdsConversionCustomer: 'customers/1234567890', acceptedCustomerDataTerms: true },
      },
    })).toMatchObject({
      autoTagging: true, trackingTemplate: '{lpurl}?src=ads', finalUrlSuffix: 'utm_source=google', timeZone: 'Europe/Rome', currency: 'EUR', optimizationScorePct: 87.3,
      conversionTracking: { id: '555', conversionCustomerId: '1234567890', acceptedCustomerDataTerms: true, enhancedConversionsForLeads: false },
    })
  })

  it('a conversion action: its default value in cents, its GA4 source', () => {
    expect(conversionActionOf({
      conversionAction: {
        id: '41', name: 'Purchase (GA4)', status: 'ENABLED', type: 'GOOGLE_ANALYTICS_4_PURCHASE', category: 'PURCHASE', primaryForGoal: true,
        valueSettings: { defaultValue: 12.5, defaultCurrencyCode: 'EUR' }, googleAnalytics4Settings: { propertyId: '999', propertyName: 'Shop GA4', eventName: 'purchase' },
      },
    })).toMatchObject({ conversionActionId: '41', primary: true, defaultValueCents: 1250, defaultValueCurrency: 'EUR', ga4: { propertyId: '999', eventName: 'purchase' } })
  })

  it('goals: a campaign that bids for other goals than the account\'s is marked', async () => {
    h.rows.mockImplementation(async (_t: unknown, q: string) => {
      if (q.includes('FROM conversion_action')) return []
      if (q.includes('FROM customer_conversion_goal')) return [{ customerConversionGoal: { category: 'PURCHASE', origin: 'WEBSITE', biddable: true } }, { customerConversionGoal: { category: 'PAGE_VIEW', origin: 'WEBSITE', biddable: false } }]
      if (q.includes('FROM campaign_conversion_goal')) {
        return [
          { campaign: { id: '21', name: 'Shop A' }, campaignConversionGoal: { category: 'PURCHASE', origin: 'WEBSITE', biddable: true } },
          { campaign: { id: '22', name: 'Search B' }, campaignConversionGoal: { category: 'PURCHASE', origin: 'WEBSITE', biddable: true } },
          { campaign: { id: '22', name: 'Search B' }, campaignConversionGoal: { category: 'PAGE_VIEW', origin: 'WEBSITE', biddable: true } },
        ]
      }
      return [{ campaign: { id: '21', name: 'Shop A' }, conversionGoalCampaignConfig: { goalConfigLevel: 'CUSTOMER' } }, { campaign: { id: '22', name: 'Search B' }, conversionGoalCampaignConfig: { goalConfigLevel: 'CUSTOMER' } }]
    })
    const read = await liveConversions(target)
    expect(read.campaigns).toEqual([
      expect.objectContaining({ campaignId: '21', goalsFrom: 'CUSTOMER', biddableGoals: ['PURCHASE/WEBSITE'], differsFromAccount: false }),
      expect.objectContaining({ campaignId: '22', biddableGoals: ['PAGE_VIEW/WEBSITE', 'PURCHASE/WEBSITE'], differsFromAccount: true }),
    ])
    expect(read.notRead).toEqual([])
  })

  it('billing: micros → cents; a part Google refuses is named, the other still answers', async () => {
    h.rows.mockImplementation(async (_t: unknown, q: string) => {
      if (q.includes('FROM billing_setup')) throw new Error('Google Ads refused it: not allowed.')
      return [{ accountBudget: { id: '61', status: 'APPROVED', approvedSpendingLimitMicros: '500000000', amountServedMicros: '123450000', billingSetup: 'customers/1/billingSetups/71', pendingProposal: { proposalType: 'UPDATE', spendingLimitMicros: '600000000' } } }]
    })
    const read = await liveBilling(target)
    expect(read.setups).toEqual([])
    expect(read.notRead).toEqual([{ part: 'billing-setups', why: 'Google Ads refused it: not allowed.' }])
    expect(read.accountBudgets[0]).toMatchObject({ accountBudgetId: '61', billingSetupId: '71', spendingLimitCents: 50000, amountServedCents: 12345, pending: { type: 'UPDATE', spendingLimitCents: 60000 } })
  })

  it('links: Merchant Center, YouTube, and the GA4 properties the GA4 conversion actions come from', async () => {
    h.rows.mockImplementation(async (_t: unknown, q: string) => {
      if (q.endsWith('FROM product_link')) return [{ productLink: { productLinkId: '81', type: 'MERCHANT_CENTER', merchantCenter: { merchantCenterId: '5' } } }]
      if (q.includes('FROM product_link_invitation')) return []
      if (q.includes('FROM data_link')) return [{ dataLink: { dataLinkId: '91', type: 'VIDEO', status: 'ENABLED', youtubeVideo: { channelId: 'UCx' } } }]
      return [
        { conversionAction: { id: '41', name: 'Purchase (GA4)', googleAnalytics4Settings: { propertyId: '999', propertyName: 'Shop GA4' } } },
        { conversionAction: { id: '42', name: 'Begin checkout (GA4)', googleAnalytics4Settings: { propertyId: '999', propertyName: 'Shop GA4' } } },
        { conversionAction: { id: '43', name: 'Website purchase' } },
      ]
    })
    const read = await liveLinks(target)
    expect(read.productLinks).toEqual([expect.objectContaining({ linkId: '81', type: 'MERCHANT_CENTER', merchantCenterId: '5' })])
    expect(read.youtube).toEqual([expect.objectContaining({ dataLinkId: '91', channelId: 'UCx', status: 'ENABLED' })])
    expect(read.ga4Properties).toEqual([{ propertyId: '999', propertyName: 'Shop GA4', conversionActions: ['Purchase (GA4)', 'Begin checkout (GA4)'] }])
  })

  it('labels: where one label is used; experiments with their arms', async () => {
    h.rows.mockImplementation(async (_t: unknown, q: string) => {
      if (q.includes('FROM label ')) return [{ label: { id: '77', name: 'Brand', status: 'ENABLED', textLabel: { backgroundColor: '#ff0000' } } }]
      if (q.includes('FROM ad_group_criterion_label')) return [{ campaign: { id: '21' }, adGroup: { id: '51' }, adGroupCriterion: { criterionId: '901', keyword: { text: 'giacca', matchType: 'EXACT' }, status: 'ENABLED' } }]
      if (q.includes('FROM experiment ')) return [{ experiment: { experimentId: '11', name: 'Bid test', status: 'ENABLED', type: 'SEARCH_CUSTOM' } }]
      if (q.includes('FROM experiment_arm')) return [{ experimentArm: { experiment: 'customers/1/experiments/11', name: 'Trial', control: false, trafficSplit: '50', campaigns: ['customers/1/campaigns/23'] } }]
      return []
    })
    const labels = await liveLabels(target, '77')
    expect(labels.labels[0]).toMatchObject({ labelId: '77', color: '#ff0000' })
    expect(labels.usedOn?.keywords).toEqual([{ campaignId: '21', keywordId: '51~901', text: 'giacca', matchType: 'EXACT', status: 'ENABLED' }])
    const experiments = await liveExperiments(target)
    expect(experiments.experiments[0].arms).toEqual([{ name: 'Trial', control: false, trafficSplitPct: 50, campaignIds: ['23'], inDesignCampaignIds: [] }])
  })

  it('lookups: a user list with its size and where it can serve', () => {
    expect(accountLookupRowOf('user-lists', { userList: { id: '3', name: 'Buyers 180d', type: 'REMARKETING', sizeRangeForSearch: 'ONE_THOUSAND_TO_TEN_THOUSAND', eligibleForSearch: true, membershipLifeSpan: '180' } }))
      .toMatchObject({ id: '3', name: 'Buyers 180d', sizeForSearch: 'ONE_THOUSAND_TO_TEN_THOUSAND', eligibleForSearch: true, eligibleForDisplay: false, membershipDays: 180 })
    expect(accountLookupRowOf('combined-audiences', { combinedAudience: { id: '4', name: 'Riders' } })).toEqual({ id: '4', name: 'Riders', type: 'COMBINED', description: null })
    expect(accountLookupRowOf('life-events', { lifeEvent: {
      id: '5', name: 'Recently moved', parent: 'lifeEvents/1', launchedToAll: true,
      availabilities: [{ channel: { availabilityMode: 'CHANNEL_TYPE', advertisingChannelType: 'DISPLAY' } }, { channel: { availabilityMode: 'CHANNEL_TYPE_AND_SUBTYPES', advertisingChannelType: 'VIDEO' } }, { channel: { availabilityMode: 'CHANNEL_TYPE', advertisingChannelType: 'DISPLAY' } }],
    } })).toEqual({ id: '5', name: 'Recently moved', type: 'LIFE_EVENT', description: null, parentId: '1', launchedToAll: true, channels: ['DISPLAY', 'VIDEO'] })
    expect(accountLookupRowOf('life-events', { lifeEvent: { id: '6', availabilities: [{ channel: { availabilityMode: 'ALL_CHANNELS' } }] } }).channels).toEqual(['ALL'])
  })
})
