/**
 * NEG page study — pass 3. READ-ONLY.
 *
 * Closes the two sections pass 2 lost to schema mistakes (AdsRuleSuggestion.proposedAction, not
 * actionType), and verifies the one inference I am NOT willing to publish unverified:
 *
 *   "62 negatives were archived TODAY" — updatedAt is @updatedAt and the v1 sync rewrites
 *   lastSyncedAt on every matched row, so updatedAt may just be the last ingest tick for
 *   everything. Check the distribution before reading anything into it.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 76 - s.length))}`)

console.log('\n═══ NEG — page study, pass 3 ═══\n')

const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: {
    id: true, expressionValue: true, expressionType: true, status: true, negativeLevel: true,
    createdAt: true, updatedAt: true, lastSyncedAt: true,
    adGroup: { select: { name: true, campaign: { select: { id: true, name: true, marketplace: true, status: true, portfolioId: true } } } },
  },
})

h('1 · updatedAt — does it mean anything, or is it the last sync tick?')
const upd = new Map<string, number>()
for (const n of negs) { const d = n.updatedAt.toISOString().slice(0, 10); upd.set(d, (upd.get(d) ?? 0) + 1) }
for (const [d, c] of [...upd].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  updatedAt ${d}  ${int(c)}`)
const arch = negs.filter((n) => n.status === 'ARCHIVED')
const archUpd = new Map<string, number>()
for (const n of arch) { const d = n.updatedAt.toISOString().slice(0, 10); archUpd.set(d, (archUpd.get(d) ?? 0) + 1) }
console.log(`  ARCHIVED rows' updatedAt: ${[...archUpd].map(([k, v]) => `${k}=${v}`).join(' · ')}`)
console.log(`  → if the whole base shares one updatedAt day, the date says "last ingest", not "archived then".`)

h('2 · Creation cohorts')
const cohort = new Map<string, number>()
for (const n of negs) { const d = n.createdAt.toISOString().slice(0, 10); cohort.set(d, (cohort.get(d) ?? 0) + 1) }
console.log(`distinct creation days: ${cohort.size}`)
for (const [d, c] of [...cohort].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${d}  ${int(c)}`)

h('3 · Where the negatives live — the four scope grains')
const byCamp = new Map<string, number>()
const byMkt = new Map<string, number>()
const byPf = new Map<string, number>()
let liveCamp = 0
for (const n of negs) {
  const c = n.adGroup?.campaign
  byCamp.set(c?.name ?? '?', (byCamp.get(c?.name ?? '?') ?? 0) + 1)
  byMkt.set(c?.marketplace ?? '?', (byMkt.get(c?.marketplace ?? '?') ?? 0) + 1)
  byPf.set(c?.portfolioId ?? 'none', (byPf.get(c?.portfolioId ?? 'none') ?? 0) + 1)
  if (c?.status === 'ENABLED') liveCamp++
}
console.log(`campaigns holding at least one negative: ${byCamp.size}`)
console.log(`negatives in an ENABLED campaign: ${int(liveCamp)} of ${int(negs.length)}`)
console.log(`by market: ${[...byMkt].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`portfolios: ${byPf.size} distinct (incl. "none"=${byPf.get('none') ?? 0})`)
console.log(`top 10 campaigns by negative count:`)
for (const [c, n] of [...byCamp].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${pad(c, 44)} ${int(n)}`)

h('4 · The proposal queue (AdsRuleSuggestion — proposedAction, not actionType)')
const sugg = await prisma.adsRuleSuggestion.findMany({
  select: { status: true, proposedAction: true, entityType: true, createdAt: true, decidedAt: true, decidedBy: true },
  orderBy: { createdAt: 'desc' }, take: 5000,
})
const t = <T,>(rows: T[], f: (r: T) => string) => {
  const m = new Map<string, number>(); for (const r of rows) m.set(f(r), (m.get(f(r)) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1])
}
console.log(`rows: ${int(sugg.length)}`)
console.log(`status: ${t(sugg, (s) => String(s.status)).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`entityType: ${t(sugg, (s) => String(s.entityType ?? '—')).slice(0, 8).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
const actOf = (s: typeof sugg[number]) => {
  const a = s.proposedAction as unknown
  if (a && typeof a === 'object') return String((a as { type?: string }).type ?? JSON.stringify(a).slice(0, 40))
  return String(a ?? '—')
}
console.log(`proposedAction.type: ${t(sugg, actOf).slice(0, 12).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
const negSugg = sugg.filter((s) => /negat|harvest/i.test(actOf(s)))
console.log(`negation/harvest suggestions: ${int(negSugg.length)} — ${t(negSugg, (s) => String(s.status)).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
if (negSugg.length) {
  console.log(`  newest ${negSugg[0]!.createdAt.toISOString().slice(0, 10)} · oldest ${negSugg[negSugg.length - 1]!.createdAt.toISOString().slice(0, 10)}`)
  const decided = negSugg.filter((s) => s.decidedAt)
  console.log(`  ever decided: ${decided.length}${decided.length ? ` (by ${[...new Set(decided.map((d) => d.decidedBy ?? '—'))].join(', ')})` : ''}`)
}

h('5 · The seven rules — cap, scope, and what they would do if armed')
const NEG_ACTIONS = ['harvest_and_negate', 'add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns']
const all = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, maxExecutionsPerDay: true, executionCount: true, scopeMarketplace: true, scopeCampaignId: true, scopePortfolioId: true, scopeProductId: true },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const rules = all.filter((r) => types(r.actions).some((x) => NEG_ACTIONS.includes(x)))
console.log(`${pad('rule', 42)} ${pad('on', 3)} ${pad('level', 8)} ${pad('scope', 22)} actions`)
for (const r of rules) {
  const scope = [r.scopeMarketplace && `mkt=${r.scopeMarketplace}`, r.scopeCampaignId && 'campaign', r.scopePortfolioId && 'portfolio', r.scopeProductId && 'product'].filter(Boolean).join(',') || 'ACCOUNT-WIDE'
  console.log(`${pad(r.name, 42)} ${pad(r.enabled ? 'ON' : '—', 3)} ${pad(String(r.autonomyLevel), 8)} ${pad(scope, 22)} ${types(r.actions).join(', ')}`)
}
// how many campaigns would sync_negatives_across_campaigns hit, per market?
for (const mkt of ['IT', 'DE', 'FR', 'ES']) {
  const n = await prisma.campaign.count({ where: { marketplace: mkt, status: 'ENABLED', externalCampaignId: { not: null } } })
  console.log(`  sync_negatives_across_campaigns on ${mkt} would write ${n} campaign-level negatives per execution`)
}

console.log('\n═══ done — read-only, nothing changed ═══\n')
await prisma.$disconnect()
