/**
 * AUTO.P0 — what each enabled rule actually DOES. READ-ONLY.
 * A cap is a statement about how much work a rule may do; sizing one without knowing the
 * action class is guessing. Also prints scope, because the cap has been doing scope's job.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: {
    id: true, name: true, trigger: true, autonomyLevel: true, dryRun: true, enabled: true,
    maxExecutionsPerDay: true, maxValueCentsEur: true, maxDailyAdSpendCentsEur: true,
    actions: true, conditions: true,
    scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
  },
  orderBy: { name: 'asc' },
})
const { resolveAutonomy } = await import('../src/services/advertising/ads-autonomy.js')

console.log(`\n═══ Enabled advertising rules: ${rules.length} ═══\n`)
for (const r of rules) {
  const acts = (Array.isArray(r.actions) ? r.actions : []) as Array<Record<string, unknown>>
  const level = resolveAutonomy(r as { enabled: boolean; dryRun: boolean; autonomyLevel?: string | null })
  const scope = [
    r.scopeMarketplace && `mkt=${r.scopeMarketplace}`,
    r.scopePortfolioId && 'portfolio', r.scopeCampaignId && 'campaign', r.scopeProductId && 'product',
  ].filter(Boolean).join(' ') || 'ACCOUNT-WIDE'
  console.log(`${pad(r.name, 44)} [${level}] cap=${r.maxExecutionsPerDay} maxVal=${r.maxValueCentsEur ?? '—'}¢ dailySpend=${r.maxDailyAdSpendCentsEur ?? '—'}¢`)
  console.log(`${' '.repeat(4)}trigger ${r.trigger} · scope ${scope}`)
  for (const a of acts) {
    const detail = Object.entries(a).filter(([k]) => k !== 'type').map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
    console.log(`${' '.repeat(4)}→ ${String(a.type)}  ${detail.slice(0, 130)}`)
  }
  console.log()
}
await prisma.$disconnect()
