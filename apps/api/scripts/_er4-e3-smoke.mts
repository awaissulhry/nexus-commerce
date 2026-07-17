import Fastify from 'fastify'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default
const app = Fastify()
await app.register(routes, { prefix: '/api' })
let fails = 0
const check = (l: string, ok: boolean, d = '') => { console.log(`${ok ? '✓' : '✗ FAIL'} ${l}${d ? ` — ${d}` : ''}`); if (!ok) fails++ }

const camp = await prisma.ebayCampaign.findFirst({ where: { fundingModel: 'COST_PER_SALE', status: 'RUNNING' }, select: { id: true, name: true } })
if (!camp) { console.log('no CPS RUNNING campaign'); process.exit(1) }
const state = await prisma.marketingAutomationState.findUnique({ where: { channel: 'EBAY' } })
const prior = state?.globalMode ?? 'OFF'
await prisma.marketingAutomationState.upsert({ where: { channel: 'EBAY' }, create: { channel: 'EBAY', globalMode: 'SUGGEST' }, update: { globalMode: 'SUGGEST' } })

const rule = (await app.inject({ method: 'POST', url: '/api/ebay-ads/automation/rules', payload: {
  name: '_er4e3 impact smoke', trigger: { scope: 'CPS_AD', all: [{ metric: 'impressions', windowDays: 7, op: 'gte', threshold: 0 }] },
  action: { type: 'pause_ad' }, scope: { campaignIds: [camp.id] }, marketplace: 'EBAY_IT',
} })).json() as { id: string }
try {
  await app.inject({ method: 'POST', url: `/api/ebay-ads/automation/rules/${rule.id}`, payload: { enabled: true } })
  await app.inject({ method: 'POST', url: '/api/ebay-ads/automation/evaluate', payload: { ruleId: rule.id } })
  const props = await prisma.ebayAdsProposal.findMany({ where: { ruleId: rule.id, status: 'PENDING' } })
  check('proposals created', props.length >= 1, `${props.length} on ${camp.name}`)
  const withImpact = props.filter((p) => p.estimatedImpact != null)
  check('every proposal carries estimatedImpact', withImpact.length === props.length, `${withImpact.length}/${props.length}`)
  const ei = props[0]?.estimatedImpact as { feesDeltaCentsPerWeek?: number; salesAtRiskCentsPerWeek?: number; assumption?: string } | null
  const ref = props[0]?.entityRef as { listingId?: string }
  if (ei && ref?.listingId) {
    const since = new Date(); since.setUTCDate(since.getUTCDate() - 7)
    const f = await prisma.ebayAdsDailyPerformance.aggregate({ where: { entityType: 'LISTING', entityId: ref.listingId, date: { gte: since } }, _sum: { adFeesCents: true, salesCents: true } })
    const expFees = -Math.round((f._sum.adFeesCents ?? 0) * 1)
    const expRisk = Math.round((f._sum.salesCents ?? 0) * 1)
    check('pause maths = −weekly fees + sales at risk', ei.feesDeltaCentsPerWeek === expFees && ei.salesAtRiskCentsPerWeek === expRisk, `${JSON.stringify(ei)} vs fees=${expFees} risk=${expRisk}`)
    check('assumption stated', !!ei.assumption && ei.assumption.length > 20)
  } else check('pause maths', false, 'no impact payload')
  const api = (await app.inject({ method: 'GET', url: '/api/ebay-ads/automation/proposals?status=PENDING' })).json() as { proposals: Array<{ ruleId: string | null; estimatedImpact?: unknown }> }
  check('API payload carries the field', api.proposals.filter((p) => p.ruleId === rule.id).every((p) => p.estimatedImpact != null))
} finally {
  const del = await prisma.ebayAdsProposal.deleteMany({ where: { ruleId: rule.id } })
  await app.inject({ method: 'DELETE', url: `/api/ebay-ads/automation/rules/${rule.id}` })
  await prisma.marketingAutomationState.update({ where: { channel: 'EBAY' }, data: { globalMode: prior } })
  console.log(`cleanup: ${del.count} proposals removed · rule deleted · mode → ${prior}`)
}
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
