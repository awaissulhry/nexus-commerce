/* ER2 smoke — composable builder endpoints + extended launch (sandbox mode
   locally: zero eBay calls). Rules-based GEN w/ criterion+DYNAMIC and
   PRI-manual w/ 2 ad groups + negatives; full cleanup. Discovery-plan arm is
   smoked post-migration. */
import Fastify from 'fastify'
import prisma from '/Users/awais/nexus-commerce/apps/api/src/db.js'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const app = Fastify()
await app.register(routes, { prefix: '/api' })
const created: string[] = []
try {
  const t = await app.inject({ method: 'GET', url: '/api/ebay-ads/builder/templates' })
  console.log('TEMPLATES:', t.statusCode, '| count:', t.json().templates.length)

  const l = await app.inject({ method: 'POST', url: '/api/ebay-ads/builder/listings', payload: { marketplace: 'EBAY_IT', strategy: 'CPS', goalFactor: 0.7 } })
  const lj = l.json()
  console.log('LISTINGS:', l.statusCode, '| rows:', lj.listings.length, '| conflicts:', lj.totals.conflicts, '| name:', lj.suggestedName)

  const s = await app.inject({ method: 'POST', url: '/api/ebay-ads/builder/seeds', payload: { marketplace: 'EBAY_IT', listingIds: lj.listings.slice(0, 5).map((x: { itemId: string }) => x.itemId) } })
  console.log('SEEDS:', s.statusCode, '| count:', s.json().seeds.length, '| top:', s.json().seeds.slice(0, 2).map((x: { text: string }) => x.text).join(' · '))

  const bs = await app.inject({ method: 'POST', url: '/api/ebay-ads/builder/budget-suggest', payload: { marketplace: 'EBAY_IT', listingIds: [] } })
  console.log('BUDGET:', bs.statusCode, '| local:', bs.json().suggestedCents, '| ebay:', bs.json().ebaySuggestedCents)

  // rules-based GEN launch (criterion + DYNAMIC) — sandbox
  const r1 = await app.inject({ method: 'POST', url: '/api/ebay-ads/builder/launch', payload: {
    goal: 'catch_all', name: 'zz-er2-rules-gen', marketplace: 'EBAY_IT',
    adRateStrategy: 'DYNAMIC', ratePct: 5, dynamicCapPct: 9,
    criterion: { autoSelectFutureInventory: true, selectionRules: [{ brands: ['Xavia'], minPrice: 10 }] },
    items: [], rulePacks: ['Rate above break-even — repair (CPS)'],
  } })
  const j1 = r1.json()
  if (j1.campaignId) created.push(j1.campaignId)
  const c1 = j1.campaignId ? await prisma.ebayCampaign.findUnique({ where: { id: j1.campaignId }, select: { isRulesBased: true, campaignCriterion: true, adRateStrategy: true } }) : null
  console.log('LAUNCH rules-GEN:', r1.statusCode, '| mode:', j1.mode, '| isRulesBased:', c1?.isRulesBased, '| strategy:', c1?.adRateStrategy, '| autoSelect:', (c1?.campaignCriterion as { autoSelectFutureInventory?: boolean } | null)?.autoSelectFutureInventory, '| packs:', j1.rulePacksBound?.length)
  console.log('  timeline has rules line:', (j1.timeline as string[]).some((x) => x.includes('Rules-based selection')) ? 'PASS' : 'FAIL')

  // PRI-manual launch with 2 ad groups + negatives — sandbox
  const r2 = await app.inject({ method: 'POST', url: '/api/ebay-ads/builder/launch', payload: {
    goal: 'hero', name: 'zz-er2-pri-groups', marketplace: 'EBAY_IT',
    targetingType: 'MANUAL', dailyBudgetCents: 500, items: [],
    adGroups: [
      { name: 'Brand', defaultBidCents: 30, keywords: [{ text: 'xavia giacca', matchType: 'PHRASE', bidCents: 35 }], negatives: [{ text: 'usato', matchType: 'EXACT' }] },
      { name: 'Generic', defaultBidCents: 25, keywords: [{ text: 'giacca moto touring', matchType: 'PHRASE', bidCents: 25 }, { text: 'giubbotto moto', matchType: 'EXACT', bidCents: 30 }] },
    ],
    rulePacks: ['Keyword bleeder — pause (CPC)'],
  } })
  const j2 = r2.json()
  if (j2.campaignId) created.push(j2.campaignId)
  console.log('LAUNCH pri-groups:', r2.statusCode, '| mode:', j2.mode, '| groups:', JSON.stringify(j2.groupResults))
} finally {
  if (created.length) {
    const kw = await prisma.ebayKeyword.deleteMany({ where: { campaignId: { in: created } } })
    const ng = await prisma.ebayNegativeKeyword.deleteMany({ where: { campaignId: { in: created } } })
    const gr = await prisma.ebayAdGroup.deleteMany({ where: { campaignId: { in: created } } })
    const ads = await prisma.ebayAd.deleteMany({ where: { campaignId: { in: created } } })
    const rules = await prisma.ebayAdsRule.deleteMany({ where: { OR: created.map((id) => ({ scope: { path: ['campaignIds'], array_contains: id } })) } })
    const exts = (await prisma.ebayCampaign.findMany({ where: { id: { in: created } }, select: { externalCampaignId: true } })).map((x) => x.externalCampaignId)
    const acts = await prisma.campaignAction.deleteMany({ where: { entityId: { in: exts } } })
    const camps = await prisma.ebayCampaign.deleteMany({ where: { id: { in: created } } })
    console.log('CLEANUP:', JSON.stringify({ keywords: kw.count, negatives: ng.count, groups: gr.count, ads: ads.count, rules: rules.count, actions: acts.count, campaigns: camps.count }))
  }
}
process.exit(0)
