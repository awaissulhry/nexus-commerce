/**
 * NEG.7 — the six conditions of study §4.4, measured. READ-ONLY.
 *
 * "What must be true before AUTO — and it is not a long list." Six sections have shipped since that
 * list was written; this asks which of the six are actually closed now, from the data and the code
 * rather than from the changelog.
 *
 * 🔴 Condition 5 is the one with a number attached: all seven rules are ACCOUNT-WIDE, and
 * `sync_negatives_across_campaigns` on IT was measured at **74 campaign-level negatives per
 * execution** from a rule whose daily cap is 20. That is the blast radius this section has to
 * render, so it is recomputed here rather than quoted.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
const verdict = (n: number, label: string, closed: boolean, detail: string) =>
  console.log(`  ${closed ? '✓' : '🔴'} ${n}. ${label}\n       ${detail}`)

console.log('\n═══ NEG.7 — the six conditions of §4.4 ═══\n')

// ── the rules themselves ──────────────────────────────────────────────────────────────────────
h('The negative-targeting rules')
/** The section's rules are identified by what they DO — there is no `type` column; `actions` is
 *  a Json array and the negative vocabulary is these three handlers. */
const NEG_ACTIONS = ['add_negative_exact', 'sync_negatives_across_campaigns', 'harvest_and_negate']
const allRules = await prisma.automationRule.findMany({
  select: {
    id: true, name: true, domain: true, trigger: true, actions: true, enabled: true,
    autonomyLevel: true, maxExecutionsPerDay: true, maxValueCentsEur: true,
    scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
    executionCount: true, lastMatchedAt: true,
  },
})
const actionTypesOf = (r: (typeof allRules)[number]) =>
  (Array.isArray(r.actions) ? (r.actions as Array<Record<string, unknown>>) : []).map((a) => String(a?.type ?? ''))
const rules = allRules.filter((r) => actionTypesOf(r).some((t) => NEG_ACTIONS.includes(t)))
console.log(`  rules in the account: ${allRules.length} · rules that negate: ${rules.length}`)
for (const r of rules) {
  const acts = actionTypesOf(r)
  const scope = [
    r.scopeMarketplace ? `marketplace=${r.scopeMarketplace}` : null,
    r.scopePortfolioId ? `portfolio=${r.scopePortfolioId}` : null,
    r.scopeCampaignId ? `campaign=${r.scopeCampaignId}` : null,
    r.scopeProductId ? `product=${r.scopeProductId}` : null,
  ].filter(Boolean)
  console.log(`    ${r.enabled ? 'ON ' : 'off'} ${String(r.autonomyLevel).padEnd(8)} ${r.name}`)
  console.log(`         does:    ${acts.join(', ')}`)
  console.log(`         scope:   ${scope.length ? scope.join(' · ') : '🔴 ACCOUNT-WIDE (all four scope columns null)'}`)
  console.log(`         caps:    ${r.maxExecutionsPerDay ?? '—'}/day · value ${r.maxValueCentsEur ?? '—'} · executed ${r.executionCount}× · last match ${r.lastMatchedAt ? r.lastMatchedAt.toISOString().slice(0, 10) : 'never'}`)
}
const armed = rules.filter((r) => r.enabled && String(r.autonomyLevel) === 'AUTO')
console.log(`  🔴 enabled AND on AUTO: ${armed.length}${armed.length ? ` — ${armed.map((r) => r.name).join(', ')}` : ''}`)

// ── 1 · protectConverting has a reader, and a test that fails without it ──────────────────────
h('condition 1 — protectConverting read and enforced')
const { readFileSync, existsSync } = await import('node:fs')
const svcPath = 'src/services/advertising/ads-protect-converting.ts'
const testPath = 'src/services/advertising/ads-protect-converting.vitest.test.ts'
const hasSvc = existsSync(svcPath)
const hasTest = existsSync(testPath)
const handlers = readFileSync('src/services/advertising/automation-action-handlers.ts', 'utf8')
const harvest = readFileSync('src/services/advertising/ads-harvest.service.ts', 'utf8')
const enforcedIn = [
  ['add_negative_exact', /add_negative_exact[\s\S]{0,4000}?checkProtectConverting/.test(handlers)],
  ['sync_negatives_across_campaigns', /sync_negatives_across_campaigns[\s\S]{0,4000}?checkProtectConverting/.test(handlers)],
  ['applyHarvest', harvest.includes('checkProtectConverting') || harvest.includes('decideNegation')],
] as const
verdict(1, 'protectConverting enforced',
  hasSvc && hasTest && enforcedIn.every(([, ok]) => ok),
  `reader ${hasSvc ? 'present' : 'MISSING'} · test ${hasTest ? 'present' : 'MISSING'} · ${enforcedIn.map(([k, ok]) => `${k}:${ok ? 'yes' : 'NO'}`).join(' · ')}`)

// ── 2 · every createNegative caller passes marketplace ────────────────────────────────────────
h('condition 2 — marketplace passed by every createNegative caller')
const { execSync } = await import('node:child_process')
// 🔴 Exclude test files: `vi.mock('./ads-negative-kw.service.js', () => ({ createNegative: ... }))`
// matches this grep and is a MOCK DEFINITION, not a call site. Counting it as an unfixed caller is
// a failure the probe invents.
const callSites = execSync(`grep -rn "await createNegative(" src --include="*.ts" | grep -v "vitest.test.ts"`, { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
let missingMarket = 0
for (const line of callSites) {
  const [file, ln] = line.split(':')
  const src = readFileSync(file, 'utf8').split('\n')
  const start = Number(ln) - 1
  const chunk = src.slice(start, start + 14).join('\n')
  // 🔴 ES6 SHORTHAND. `{ ..., scope, marketplace }` passes it without a colon, and requiring one
  // reported all three real call sites as unfixed when every one of them was correct.
  const ok = /marketplace\s*:/.test(chunk) || /[,{]\s*marketplace\s*[,}]/.test(chunk)
  if (!ok) missingMarket++
  console.log(`    ${ok ? '✓' : '🔴'} ${file}:${ln}`)
}
verdict(2, 'marketplace reaches the gate', missingMarket === 0,
  `${callSites.length} call sites, ${missingMarket} without a marketplace argument`)

// ── 3 · negative-aware endpoint routing ───────────────────────────────────────────────────────
h('condition 3 — negative-aware endpoint routing')
const client = readFileSync('src/services/ads-core/../advertising/ads-api-client.ts', 'utf8')
const routed = client.includes('negativeLevel') && client.includes('isNegative')
verdict(3, 'a retirement lands on the right endpoint', routed,
  routed ? 'ads-api-client.ts routes on { kind, isNegative, negativeLevel }' : 'ads-api-client.ts still routes every target to /sp/targets')

// ── 4 · list, remove, bulk-remove, evidence ───────────────────────────────────────────────────
h('condition 4 — the removal path exists')
const retireSvc = existsSync('src/services/advertising/negatives-retire.service.ts')
const retiredRows = await prisma.adTarget.count({ where: { retiredAt: { not: null } } })
verdict(4, 'list / remove / bulk-remove / evidence', retireSvc,
  `negatives-retire.service.ts ${retireSvc ? 'present' : 'MISSING'} · AdTarget.retiredAt set on ${int(retiredRows)} rows (0 is expected — nothing has been retired through us)`)

// ── 5 · 🔴 scope bound — the blast radius ─────────────────────────────────────────────────────
h('condition 5 — 🔴 scope bound')
const campaigns = await prisma.campaign.findMany({
  select: { id: true, name: true, marketplace: true, status: true, externalCampaignId: true, liveBidWritesEnabled: true },
})
const byMarket = new Map<string, typeof campaigns>()
for (const c of campaigns) {
  const m = c.marketplace ?? '—'
  byMarket.set(m, [...(byMarket.get(m) ?? []), c])
}
console.log('  campaigns per marketplace (the reach of ONE unscoped execution):')
for (const [m, cs] of [...byMarket].sort((a, b) => b[1].length - a[1].length)) {
  const enabled = cs.filter((c) => String(c.status) === 'ENABLED').length
  console.log(`    ${m.padEnd(6)} ${String(cs.length).padStart(3)} campaigns · ${String(enabled).padStart(3)} ENABLED · ${cs.filter((c) => c.liveBidWritesEnabled).length} allowlisted`)
}
const it = byMarket.get('IT') ?? []
const itEnabled = it.filter((c) => String(c.status) === 'ENABLED')
console.log(`  🔴 sync_negatives_across_campaigns on IT would touch ${int(itEnabled.length)} ENABLED campaigns per execution`)
const unscoped = rules.filter((r) => !r.scopeMarketplace && !r.scopePortfolioId && !r.scopeCampaignId && !r.scopeProductId)
const syncRules = rules.filter((r) => actionTypesOf(r).includes('sync_negatives_across_campaigns'))
console.log(`  rules running sync_negatives_across_campaigns: ${syncRules.length} — ${syncRules.map((r) => `${r.name} (cap ${r.maxExecutionsPerDay ?? '—'}/day, ${r.enabled ? 'ON' : 'off'}, ${r.autonomyLevel})`).join(' · ') || 'none'}`)
verdict(5, 'rules are scope-bound', unscoped.length === 0,
  `${unscoped.length} of ${rules.length} rules carry NO scope — each executes account-wide`)

// ── 6 · the 132 triaged ───────────────────────────────────────────────────────────────────────
h('condition 6 — the whitelist contradictions triaged')
const reviews = await prisma.adNegativeReview.count()
const { getProtections } = await import('../src/services/advertising/negatives-protections.service.js')
const prot = await getProtections({ market: 'all' })
verdict(6, 'AUTO is not appending to a base nobody has read', prot.backward.totals.open === 0,
  `${int(prot.backward.totals.contradictions)} contradictions · ${int(prot.backward.totals.reviewed)} reviewed · ${int(prot.backward.totals.open)} OPEN · ${int(reviews)} decision rows`)

console.log('\n─── verdict ───────────────────────────────────────────────────────────────────')
console.log('  NEG.7 renders this. It arms nothing.')
await prisma.$disconnect()
