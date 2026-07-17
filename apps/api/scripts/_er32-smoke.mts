/**
 * ER3.2 smoke — rule CRUD + validation + preview(no writes) + per-rule
 * evaluate + snooze-blocks-repropose + dismiss-allows-repropose + delete
 * (executions cascade, proposals survive). Uses an ALERT action scoped to one
 * campaign so nothing ever touches eBay; global mode is restored at the end.
 */
import Fastify from 'fastify'

const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default
const app = Fastify()
await app.register(routes, { prefix: '/api' })

const J = (r: { json: () => unknown }) => r.json() as Record<string, any>
let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── setup: a RUNNING CPS campaign to scope to ─────────────────────────────────
const camp = await prisma.ebayCampaign.findFirst({ where: { fundingModel: 'COST_PER_SALE', status: 'RUNNING' }, select: { id: true, name: true } })
if (!camp) { console.log('no RUNNING CPS campaign — abort'); process.exit(1) }
console.log(`scoped to: ${camp.name} (${camp.id})`)

const state = await prisma.marketingAutomationState.findUnique({ where: { channel: 'EBAY' } })
const priorMode = state?.globalMode ?? 'OFF'
if (state?.halted) { console.log('automation HALTED — abort (not touching)'); process.exit(1) }
await prisma.marketingAutomationState.upsert({ where: { channel: 'EBAY' }, create: { channel: 'EBAY', globalMode: 'SUGGEST' }, update: { globalMode: 'SUGGEST' } })

const body = {
  name: '_er32 smoke rule',
  trigger: { scope: 'CPS_AD', all: [
    { metric: 'impressions', windowDays: 7, op: 'gte', benchmark: 'account_avg', multiplier: 1, excludeRecentDays: 1 },
  ] },
  action: { type: 'alert' },
  scope: { campaignIds: [camp.id] },
  marketplace: 'EBAY_IT',
  cooldownHours: 24,
}

try {
  // ── validation rejects garbage ──────────────────────────────────────────────
  const bad = await app.inject({ method: 'POST', url: '/api/ebay-ads/automation/rules', payload: { ...body, trigger: { scope: 'CPS_AD', all: [{ metric: 'nope', windowDays: 200, op: 'eq' }] } } })
  check('create rejects invalid body (400)', bad.statusCode === 400, J(bad).error?.slice(0, 90))

  // ── create ──────────────────────────────────────────────────────────────────
  const created = await app.inject({ method: 'POST', url: '/api/ebay-ads/automation/rules', payload: body })
  const rule = J(created)
  check('create valid rule', created.statusCode === 200 && !!rule.id && rule.enabled === false && rule.mode === 'PROPOSE', `id=${rule.id} enabled=${rule.enabled} mode=${rule.mode}`)

  // ── templates + GET :id ─────────────────────────────────────────────────────
  const tpl = await app.inject({ method: 'GET', url: '/api/ebay-ads/automation/rules/templates' })
  check('templates endpoint', tpl.statusCode === 200 && J(tpl).templates.length === 6, `${J(tpl).templates?.length} templates`)
  const got = await app.inject({ method: 'GET', url: `/api/ebay-ads/automation/rules/${rule.id}` })
  check('GET rule by id (+executions)', got.statusCode === 200 && Array.isArray(J(got).executions), `executions=${J(got).executions?.length}`)

  // ── preview: counts, zero writes ────────────────────────────────────────────
  const beforeProps = await prisma.ebayAdsProposal.count()
  const beforeExecs = await prisma.ebayAdsRuleExecution.count()
  const pv = await app.inject({ method: 'POST', url: '/api/ebay-ads/automation/rules/preview', payload: body })
  const pvj = J(pv)
  check('preview returns counts + samples', pv.statusCode === 200 && pvj.evaluated >= 1 && pvj.matched >= 1 && pvj.samples.length >= 1, `evaluated=${pvj.evaluated} matched=${pvj.matched}`)
  const afterProps = await prisma.ebayAdsProposal.count()
  const afterExecs = await prisma.ebayAdsRuleExecution.count()
  check('preview wrote NOTHING', beforeProps === afterProps && beforeExecs === afterExecs, `proposals ${beforeProps}→${afterProps}, executions ${beforeExecs}→${afterExecs}`)
  const pvBad = await app.inject({ method: 'POST', url: '/api/ebay-ads/automation/rules/preview', payload: { ...body, action: { type: 'pause_keyword' } } })
  check('preview validates too (400)', pvBad.statusCode === 400)

  // ── edit: thresholds change, invalid rejected ───────────────────────────────
  const edited = await app.inject({ method: 'POST', url: `/api/ebay-ads/automation/rules/${rule.id}`, payload: { cooldownHours: 48, name: '_er32 smoke rule v2' } })
  check('edit config fields', edited.statusCode === 200 && J(edited).cooldownHours === 48 && J(edited).name === '_er32 smoke rule v2')
  const editBad = await app.inject({ method: 'POST', url: `/api/ebay-ads/automation/rules/${rule.id}`, payload: { trigger: { scope: 'CPS_AD', all: [] } } })
  check('edit rejects invalid merged body (400)', editBad.statusCode === 400)

  // ── per-rule evaluate (enabled + SUGGEST → proposals) ───────────────────────
  await app.inject({ method: 'POST', url: `/api/ebay-ads/automation/rules/${rule.id}`, payload: { enabled: true } })
  const ev1 = await app.inject({ method: 'POST', url: '/api/ebay-ads/automation/evaluate', payload: { ruleId: rule.id } })
  const ev1j = J(ev1)
  const pending1 = await prisma.ebayAdsProposal.findMany({ where: { ruleId: rule.id, status: 'PENDING' } })
  check('per-rule evaluate proposes', ev1.statusCode === 200 && ev1j.proposed >= 1 && pending1.length >= 1, `proposed=${ev1j.proposed} pending=${pending1.length}`)
  check('reasoning carries conditionResults', !!(pending1[0]?.reasoning as any)?.conditionResults?.length, JSON.stringify((pending1[0]?.reasoning as any)?.conditionResults?.[0] ?? {}).slice(0, 120))

  // ── snooze blocks re-propose ────────────────────────────────────────────────
  const snoozeId = pending1[0].id
  const dec1 = await app.inject({ method: 'POST', url: '/api/ebay-ads/automation/proposals/decide', payload: { ids: [snoozeId], decision: 'reject', snoozeDays: 7 } })
  check('snooze decide', dec1.statusCode === 200 && J(dec1).results[0].detail.startsWith('snoozed until'), J(dec1).results[0].detail)
  await app.inject({ method: 'POST', url: '/api/ebay-ads/automation/evaluate', payload: { ruleId: rule.id } })
  const afterSnooze = await prisma.ebayAdsProposal.findUnique({ where: { id: snoozeId } })
  check('snoozed target NOT re-proposed', afterSnooze?.status === 'REJECTED', `status=${afterSnooze?.status}`)

  // ── plain dismiss allows re-propose ─────────────────────────────────────────
  const pending2 = await prisma.ebayAdsProposal.findFirst({ where: { ruleId: rule.id, status: 'PENDING' } })
  if (pending2) {
    await app.inject({ method: 'POST', url: '/api/ebay-ads/automation/proposals/decide', payload: { ids: [pending2.id], decision: 'reject' } })
    await app.inject({ method: 'POST', url: '/api/ebay-ads/automation/evaluate', payload: { ruleId: rule.id } })
    const back = await prisma.ebayAdsProposal.findUnique({ where: { id: pending2.id } })
    check('plain dismiss re-proposes next run', back?.status === 'PENDING', `status=${back?.status}`)
  } else {
    check('plain dismiss re-proposes next run', false, 'no second pending proposal to test with')
  }

  // ── delete: executions cascade, proposals survive ───────────────────────────
  const execsBefore = await prisma.ebayAdsRuleExecution.count({ where: { ruleId: rule.id } })
  const del = await app.inject({ method: 'DELETE', url: `/api/ebay-ads/automation/rules/${rule.id}` })
  const gone = await app.inject({ method: 'GET', url: `/api/ebay-ads/automation/rules/${rule.id}` })
  const execsAfter = await prisma.ebayAdsRuleExecution.count({ where: { ruleId: rule.id } })
  const orphanProps = await prisma.ebayAdsProposal.count({ where: { ruleId: rule.id } })
  check('delete rule', del.statusCode === 200 && gone.statusCode === 404)
  check('executions cascaded, proposals survived', execsBefore >= 1 && execsAfter === 0 && orphanProps >= 1, `execs ${execsBefore}→${execsAfter}, proposals kept=${orphanProps}`)
} finally {
  // ── cleanup: test proposals + restore mode ──────────────────────────────────
  const cleaned = await prisma.ebayAdsProposal.deleteMany({ where: { proposedKey: { contains: `:${camp.id}:` }, kind: 'alert' } })
  await prisma.ebayAdsRule.deleteMany({ where: { name: { startsWith: '_er32 smoke rule' } } })
  await prisma.marketingAutomationState.update({ where: { channel: 'EBAY' }, data: { globalMode: priorMode } })
  console.log(`cleanup: ${cleaned.count} test proposals removed · global mode restored → ${priorMode}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
