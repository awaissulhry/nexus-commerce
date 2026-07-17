/**
 * ER5 smoke — versioning lifecycle: backfill v1 · create→v1 · edit→v2 ·
 * no-op save doesn't version · enabled toggle doesn't version · execution
 * stamps ruleVersion · revert appends v3 with v1's config · revert-to-current
 * 400s · versions list · delete cascades. Cleanup restores everything.
 */
import Fastify from 'fastify'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default
const app = Fastify()
await app.register(routes, { prefix: '/api' })
let fails = 0
const check = (l: string, ok: boolean, d = '') => { console.log(`${ok ? '✓' : '✗ FAIL'} ${l}${d ? ` — ${d}` : ''}`); if (!ok) fails++ }

// backfill
const backfilled = await prisma.ebayAdsRuleVersion.count({ where: { changedBy: 'backfill:er5' } })
const rules = await prisma.ebayAdsRule.count()
check('backfill: every existing rule has a v1 snapshot', backfilled === rules, `${backfilled}/${rules}`)

const state = await prisma.marketingAutomationState.findUnique({ where: { channel: 'EBAY' } })
const prior = state?.globalMode ?? 'OFF'
await prisma.marketingAutomationState.upsert({ where: { channel: 'EBAY' }, create: { channel: 'EBAY', globalMode: 'SUGGEST' }, update: { globalMode: 'SUGGEST' } })

const camp = await prisma.ebayCampaign.findFirst({ where: { fundingModel: 'COST_PER_SALE', status: 'RUNNING' }, select: { id: true } })
const body = {
  name: '_er5 version smoke',
  trigger: { scope: 'CPS_AD', all: [{ metric: 'impressions', windowDays: 7, op: 'gte', threshold: 0 }] },
  action: { type: 'alert' }, scope: camp ? { campaignIds: [camp.id] } : null, marketplace: 'EBAY_IT',
}
const rule = (await app.inject({ method: 'POST', url: '/api/ebay-ads/automation/rules', payload: body })).json() as { id: string; version: number }
try {
  check('create → version 1 + snapshot', rule.version === 1 && (await prisma.ebayAdsRuleVersion.count({ where: { ruleId: rule.id } })) === 1)

  // edit trigger → v2
  const e1 = (await app.inject({ method: 'POST', url: `/api/ebay-ads/automation/rules/${rule.id}`, payload: { trigger: { scope: 'CPS_AD', all: [{ metric: 'impressions', windowDays: 14, op: 'gte', threshold: 0 }] } } })).json() as { version: number }
  const v2row = await prisma.ebayAdsRuleVersion.findUnique({ where: { ruleId_version: { ruleId: rule.id, version: 2 } } })
  check('config edit → v2 snapshotted', e1.version === 2 && !!v2row && (v2row.trigger as { all: Array<{ windowDays: number }> }).all[0].windowDays === 14)

  // no-op save
  const e2 = (await app.inject({ method: 'POST', url: `/api/ebay-ads/automation/rules/${rule.id}`, payload: { trigger: { scope: 'CPS_AD', all: [{ metric: 'impressions', windowDays: 14, op: 'gte', threshold: 0 }] } } })).json() as { version: number }
  check('no-op save does NOT version', e2.version === 2 && (await prisma.ebayAdsRuleVersion.count({ where: { ruleId: rule.id } })) === 2)

  // enabled toggle
  const e3 = (await app.inject({ method: 'POST', url: `/api/ebay-ads/automation/rules/${rule.id}`, payload: { enabled: true } })).json() as { version: number; enabled: boolean }
  check('enabled toggle does NOT version', e3.version === 2 && e3.enabled === true && (await prisma.ebayAdsRuleVersion.count({ where: { ruleId: rule.id } })) === 2)

  // evaluate → execution + reasoning stamped v2
  await app.inject({ method: 'POST', url: '/api/ebay-ads/automation/evaluate', payload: { ruleId: rule.id } })
  const exec = await prisma.ebayAdsRuleExecution.findFirst({ where: { ruleId: rule.id }, orderBy: { createdAt: 'desc' } })
  check('execution stamps ruleVersion', exec?.ruleVersion === 2, `ruleVersion=${exec?.ruleVersion}`)
  const prop = await prisma.ebayAdsProposal.findFirst({ where: { ruleId: rule.id } })
  check('proposal reasoning stamps ruleVersion', (prop?.reasoning as { ruleVersion?: number } | null)?.ruleVersion === 2, prop ? `reasoning.ruleVersion=${(prop.reasoning as { ruleVersion?: number }).ruleVersion}` : 'no proposal (0 matches?)')

  // revert to v1 → v3 with v1 config
  const rv = await app.inject({ method: 'POST', url: `/api/ebay-ads/automation/rules/${rule.id}/revert`, payload: { toVersion: 1 } })
  const after = await prisma.ebayAdsRule.findUniqueOrThrow({ where: { id: rule.id } })
  const v3row = await prisma.ebayAdsRuleVersion.findUnique({ where: { ruleId_version: { ruleId: rule.id, version: 3 } } })
  check('revert → v3 appended with v1 config', rv.statusCode === 200 && after.version === 3 && (after.trigger as { all: Array<{ windowDays: number }> }).all[0].windowDays === 7 && v3row?.note === 'revert to v1')

  // revert to current config → 400
  const rv2 = await app.inject({ method: 'POST', url: `/api/ebay-ads/automation/rules/${rule.id}/revert`, payload: { toVersion: 1 } })
  check('revert to matching config → 400', rv2.statusCode === 400, (rv2.json() as { error?: string }).error?.slice(0, 50))

  // versions list
  const vl = (await app.inject({ method: 'GET', url: `/api/ebay-ads/automation/rules/${rule.id}/versions` })).json() as { versions: Array<{ version: number }> }
  check('versions list (desc)', vl.versions.map((v) => v.version).join(',') === '3,2,1')
} finally {
  await prisma.ebayAdsProposal.deleteMany({ where: { ruleId: rule.id } })
  const delOk = (await app.inject({ method: 'DELETE', url: `/api/ebay-ads/automation/rules/${rule.id}` })).statusCode === 200
  const orphanVersions = await prisma.ebayAdsRuleVersion.count({ where: { ruleId: rule.id } })
  check('delete cascades versions', delOk && orphanVersions === 0, `${orphanVersions} left`)
  await prisma.marketingAutomationState.update({ where: { channel: 'EBAY' }, data: { globalMode: prior } })
  console.log(`cleanup done · mode → ${prior}`)
}
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
