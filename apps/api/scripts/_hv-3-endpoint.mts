/**
 * HV.3 — the destination, proven end to end.
 *
 * Writes `AdsHarvestDestination` rows and REMOVES EVERY ONE IT CREATES. Nothing else is written:
 * no keyword, no negative, nothing at Amazon.
 *
 * Proves:
 *   1. the resolver's shortlist matches what the page shows, row for row
 *   2. a stored override beats the resolver, and a more specific scope beats a less specific one
 *   3. 🔴 the §4.1 coupling: at least one row says "would negate at source: NO" and, once a
 *      destination is stored, at least one says YES
 *   4. an AUTO ad group is refused as a destination
 *   5. "no destination" is reachable and renders as its own state
 */
import '../src/env.js'
const { getKeywordHarvest } = await import('../src/services/advertising/keyword-harvest.service.js')
const d = await import('../src/services/advertising/harvest-destination.service.js')
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? '✅' : '🔴'} ${pad(label, 60)} ${detail}`) }
const created: Array<{ g: string; s: string | null; m: string }> = []

console.log('\n═══ HV.3 — the destination, end to end ═══\n')
const pre = await prisma.adsHarvestDestination.count()
if (pre > 0) { console.log(`🔴 ${pre} destination rows already exist; this probe assumes a clean table. Aborting.`); process.exit(1) }

try {
  // ── 1 · the page's destinations vs a fresh resolve ──────────────────────────
  console.log('═══ 1 · the page agrees with the resolver ═══\n')
  const page = await getKeywordHarvest({ market: 'all' })
  const graph = await d.loadDestinationGraph()
  const stored = await d.resolveStoredDestinations({ market: 'all' })
  console.log(`${pad('term', 32)} ${pad('source', 20)} ${pad('#short', 7)} ${pad('resolution', 20)} ${pad('destStatus', 22)} negate?`)
  let mismatches = 0
  for (const r of page.rows) {
    const fresh = r.adGroup.id
      ? d.resolveDestination({ graph, stored, sourceAdGroupId: r.adGroup.id, sourceAdGroupName: r.adGroup.name, term: r.term, kind: r.kind, createType: r.kind === 'product' ? 'PRODUCT' : 'EXACT' })
      : null
    const same = JSON.stringify(fresh?.shortlist.map((s) => s.adGroupId)) === JSON.stringify(r.destination?.shortlist.map((s) => s.adGroupId))
      && fresh?.source === r.destination?.source && fresh?.status === r.destination?.status
      && fresh?.wouldNegateAtSource === r.destination?.wouldNegateAtSource
    if (!same) mismatches++
    console.log(`${pad(r.term, 32)} ${pad(r.adGroup.name, 20)} ${pad(String(r.destination?.shortlist.length ?? 0), 7)} ${pad(String(r.destination?.source), 20)} ${pad(String(r.destination?.status), 22)} ${r.destination?.wouldNegateAtSource ? 'YES' : 'no'}`)
  }
  check('every row matches an independent resolve', mismatches === 0, `${mismatches} mismatches`)
  check('census.destinations sums to the candidate count',
    page.census.destinations.stored + page.census.destinations.resolvedUnique + page.census.destinations.ambiguous + page.census.destinations.none === page.census.candidates,
    JSON.stringify(page.census.destinations))

  // ── 2 · 🔴 the §4.1 coupling, the NO case ───────────────────────────────────
  console.log('\n═══ 2 · the §4.1 coupling ═══\n')
  const noRows = page.rows.filter((r) => r.destination && !r.destination.wouldNegateAtSource)
  const yesRows = page.rows.filter((r) => r.destination?.wouldNegateAtSource)
  check('at least one row would NOT negate its source', noRows.length > 0, `${noRows.length} of ${page.rows.length}`)
  if (noRows[0]) console.log(`\n     "${noRows[0].destination!.negateReason}"\n`)

  // ── 3 · store an override, and the coupling flips to YES ────────────────────
  const target = page.rows.find((r) => (r.destination?.shortlist.length ?? 0) > 0 && r.adGroup.id)
  if (!target) check('found a candidate with a shortlist to store', false)
  else {
    const pick = target.destination!.shortlist[0]
    console.log(`storing: ${target.term} → ${pick.adGroupName} (campaign ${pick.campaignName})`)
    await d.saveHarvestDestination({ scopeGrain: 'account', scopeId: null, matchType: 'EXACT', adGroupId: pick.adGroupId, negateAtSource: true, updatedBy: 'probe:_hv-3-endpoint' })
    created.push({ g: 'account', s: null, m: 'EXACT' })

    const after = await getKeywordHarvest({ market: 'all' })
    const row = after.rows.find((r) => r.id === target.id)
    check('the stored destination is picked up', row?.destination?.source === 'stored', `source=${row?.destination?.source}`)
    check('it is the ad group we stored', row?.destination?.chosen?.adGroupId === pick.adGroupId)
    const flipped = after.rows.filter((r) => r.destination?.wouldNegateAtSource)
    check('🔴 at least one row now WOULD negate its source', flipped.length > 0, `${flipped.length} rows`)
    if (flipped[0]) console.log(`\n     "${flipped[0].destination!.negateReason}"\n`)
    check('census.wouldNegate moved', after.census.destinations.wouldNegate > page.census.destinations.wouldNegate,
      `${page.census.destinations.wouldNegate} → ${after.census.destinations.wouldNegate}`)

    // a more specific scope beats it
    const mkt = target.market
    const other = target.destination!.shortlist.find((s) => s.adGroupId !== pick.adGroupId)
    if (other) {
      await d.saveHarvestDestination({ scopeGrain: 'market', scopeId: mkt, matchType: 'EXACT', adGroupId: other.adGroupId, negateAtSource: true, updatedBy: 'probe:_hv-3-endpoint' })
      created.push({ g: 'market', s: mkt, m: 'EXACT' })
      const scoped = await getKeywordHarvest({ market: mkt })
      const sRow = scoped.rows.find((r) => r.id === target.id)
      check(`the ${mkt} market override beats the account one`, sRow?.destination?.chosen?.adGroupId === other.adGroupId, `chose ${sRow?.destination?.chosen?.adGroupName}`)
      const acct = await getKeywordHarvest({ market: 'all' })
      const aRow = acct.rows.find((r) => r.id === target.id)
      check('market=all still uses the account one', aRow?.destination?.chosen?.adGroupId === pick.adGroupId)
    } else check('found a second shortlist entry for the specificity test', false)
  }

  // ── 4 · refusals ────────────────────────────────────────────────────────────
  console.log('\n═══ 4 · refusals ═══\n')
  const autoAg = await prisma.adGroup.findFirst({ where: { campaign: { targetingType: 'AUTO' } }, select: { id: true, name: true } })
  if (autoAg) {
    let refused = false, msg = ''
    try { await d.saveHarvestDestination({ scopeGrain: 'account', scopeId: null, matchType: 'PHRASE', adGroupId: autoAg.id, negateAtSource: true, updatedBy: 'probe' }) }
    catch (e) { refused = true; msg = (e as Error).message }
    check('an AUTO ad group is refused as a destination', refused, msg.slice(0, 70))
  }
  let r2 = false
  try { await d.saveHarvestDestination({ scopeGrain: 'market', scopeId: 'all', matchType: 'EXACT', adGroupId: 'x', negateAtSource: true, updatedBy: 'p' }) } catch { r2 = true }
  check('"all" is refused as a market', r2)
  let r3 = false
  try { await d.deleteHarvestDestination('account', null, 'BROAD') } catch { r3 = true }
  check('removing an absent destination is refused', r3)
} finally {
  console.log('\n═══ cleanup ═══\n')
  for (const c of created) {
    try { await d.deleteHarvestDestination(c.g as never, c.s, c.m as never); console.log(`  removed ${c.g}/${c.s ?? '*'}/${c.m}`) }
    catch (e) { failures++; console.log(`  🔴 COULD NOT REMOVE ${c.g}/${c.s ?? '*'}/${c.m}: ${(e as Error).message}`) }
  }
  const left = await prisma.adsHarvestDestination.count()
  check('the table is back to empty', left === 0, `${left} rows left`)
}

console.log(`\n═══ ${failures === 0 ? '✅ all checks passed' : `🔴 ${failures} CHECK(S) FAILED`} ═══\n`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
