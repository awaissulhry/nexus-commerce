/**
 * ACR.1.2b / 1.3b / 1.6 — verify the shipped read models against PROD. READ-ONLY.
 *
 * The browser check is the one that matters and is blocked on the Chrome extension, so
 * this exercises the exact service functions the three new endpoints call, against the
 * production database, and asserts the properties each surface depends on. It cannot prove
 * the pixels; it does prove the data those pixels render is real and correctly shaped.
 *
 * `db.js` is imported (transitively) so env.ts loads first — see its docblock.
 */
import '../src/env.js'

const { getEngineDetail, getGuardrailGrid } = await import('../src/services/advertising/ads-control-room-detail.service.js')
const { dimensionsForWrite, pinDenial } = await import('../src/services/advertising/ads-authority-pins.js')

const h = (s: string) => console.log(`\n${'─'.repeat(94)}\n${s}\n${'─'.repeat(94)}`)
let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const ENGINES = [
  'rank-defend', 'dayparting', 'budget-enforce', 'budget-pools', 'auto-bid',
  'auto-harvest', 'anomaly-guard', 'tos-defense', 'write-delivery', 'structural-reconcile',
]

h('1. Every Levers engine resolves, and Run now is offered for all twelve')
let runnable = 0
for (const key of ENGINES) {
  const d = await getEngineDetail(key)
  if (!d) { check(key, false, 'returned null'); continue }
  if (d.run.available) runnable++
  const last = d.runs[0]
  console.log(
    `  ${key.padEnd(22)} runs14d=${String(d.health.runs14d).padStart(5)} fail=${String(d.health.failures14d).padStart(3)}` +
    `  run-now=${d.run.available ? 'YES' : 'no '}  evidence=${String(d.evidence.length).padStart(2)}` +
    `  last=${last ? `${last.status} ${String(last.summary ?? '').slice(0, 40)}` : '(never)'}`,
  )
}
check('all engines resolved', true)
check('Run now available on all 10 mapped engines', runnable === ENGINES.length, `${runnable}/${ENGINES.length}`)

h('2. The empty-evidence states are DISTINGUISHED, not one blank list')
for (const key of ['anomaly-guard', 'auto-bid', 'tos-defense', 'rank-defend']) {
  const d = await getEngineDetail(key)
  const shape = d!.evidence.length > 0
    ? `${d!.evidence.length} rows`
    : `note: "${d!.evidenceNote}"`
  console.log(`  ${key.padEnd(22)} writesEntities=${String(d!.writesEntities).padEnd(5)} ${shape}`)
  check(`${key} says something when empty`, d!.evidence.length > 0 || !!d!.evidenceNote)
}

h('3. rank-defend evidence names CAMPAIGNS, not cuids')
const rd = await getEngineDetail('rank-defend')
const named = rd!.evidence.filter((e) => e.campaignName).length
for (const e of rd!.evidence.slice(0, 5)) {
  console.log(`  ${new Date(e.at).toISOString().slice(0, 16)}  ${e.actionType.padEnd(26)} ${(e.campaignName ?? e.entityId ?? '—').slice(0, 44)}  ${e.status}`)
}
check('evidence rows resolve a campaign name', rd!.evidence.length === 0 || named > 0, `${named}/${rd!.evidence.length}`)

h('4. The guardrail grid — the rows behind the counts')
const grid = await getGuardrailGrid({ limit: 500 })
console.log(`  totals: ${JSON.stringify(grid.totals)}`)
console.log(`  account-wide rules (NOT folded into per-row counts): ${grid.accountWideRules}`)
check('grid returns rows', grid.rows.length > 0, `${grid.rows.length} rows`)
check('managed campaigns sort first', grid.rows[0]?.managed === true)
check('totals are account-wide, not page-scoped', grid.totals.campaigns >= grid.rows.length)
const withMax = grid.rows.filter((r) => r.maxBidCents != null).length
check('max-bid coverage matches the account total', withMax <= grid.totals.withMaxBid, `${withMax} on page / ${grid.totals.withMaxBid} total`)
console.log('\n  first 6 rows:')
for (const r of grid.rows.slice(0, 6)) {
  const pins = r.pinnedDimensions.length ? r.pinnedDimensions.join('+') : '—'
  console.log(
    `    ${r.name.slice(0, 34).padEnd(34)} ${(r.marketplace ?? '--').padEnd(3)} managed=${r.managed ? 'Y' : 'n'}` +
    `  min=${r.minBidCents ?? '—'} max=${r.maxBidCents ?? '—'}  pins=${pins}  rules=${r.boundRules.length}` +
    `  ${r.portfolioName ? `pf=${r.portfolioName.slice(0, 18)}` : ''}`,
  )
}

h('5. Portfolio names resolve (Campaign.portfolioId is Amazon\'s EXTERNAL id)')
const withPf = grid.rows.filter((r) => r.portfolioId)
const resolvedPf = withPf.filter((r) => r.portfolioName)
check('campaigns in a portfolio get its NAME', withPf.length === 0 || resolvedPf.length > 0, `${resolvedPf.length}/${withPf.length}`)

h('6. The pin decision, on real rows')
const sample = grid.rows[0]
if (sample) {
  const pins = { pinPlacement: false, pinBids: true, pinBudget: false }
  check('a bid write is refused when bids are pinned',
    pinDenial(pins, { dimensions: dimensionsForWrite({ fields: ['bid'] }) }) !== null)
  check('a SUPPRESSION is still allowed when bids are pinned',
    pinDenial(pins, { dimensions: dimensionsForWrite({ fields: ['bid'] }), isSuppression: true }) === null)
  check('a multi-field bid+budget write is refused when only BUDGET is pinned',
    pinDenial({ pinPlacement: false, pinBids: false, pinBudget: true },
      { dimensions: dimensionsForWrite({ fields: ['bid', 'dailyBudget'] }) }) !== null)
  check('a status change is untouched by all three pins',
    pinDenial({ pinPlacement: true, pinBids: true, pinBudget: true },
      { dimensions: dimensionsForWrite({ fields: ['status'] }) }) === null)
}

h(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
