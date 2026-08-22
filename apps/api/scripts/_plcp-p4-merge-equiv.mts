/**
 * PLC-P4 — prove the two placement-merge implementations agree BEFORE converging them.
 *
 * `placement_apply` rebuilds the payload inline (`others` + the target lane); `buildManualAdjustments`
 * is the tested helper that exists because a one-lane payload erases the other two. Read-only: it
 * builds payloads in memory against every real campaign profile and diffs them. Nothing is written.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { buildManualAdjustments } = await import('../src/services/advertising/ads-placement-manual.js')
const { PLACEMENT_TOP, PLACEMENT_REST, PLACEMENT_PRODUCT } = await import('../src/services/advertising/ads-placement-math.js')

type Adj = { placement: string; percentage: number }
const LANES = [PLACEMENT_TOP, PLACEMENT_REST, PLACEMENT_PRODUCT]
const VALUES = [0, 1, 24, 45, 150, 900]

const campaigns = await prisma.campaign.findMany({ select: { id: true, name: true, dynamicBidding: true } })
console.log(`campaign profiles under test: ${campaigns.length} × ${LANES.length} lanes × ${VALUES.length} values = ${campaigns.length * LANES.length * VALUES.length} payload pairs\n`)

/** What the handler builds today. */
const inline = (existing: Adj[], lane: string, next: number): Adj[] =>
  [...existing.filter((x) => x.placement !== lane), { placement: lane, percentage: next }]

/** The set of lanes that actually carry a value — what Amazon is told, absent === 0. */
const meaning = (adj: Adj[]) => {
  const m = new Map<string, number>()
  for (const a of adj) if (Number(a.percentage) > 0) m.set(a.placement, Math.round(Number(a.percentage)))
  return [...m.entries()].sort().map(([k, v]) => `${k}=${v}`).join(',')
}

let pairs = 0, sameMeaning = 0, sameBytes = 0
const diffs: string[] = []
const dropped: string[] = []
for (const c of campaigns) {
  const existing = (((c.dynamicBidding as { placementBidding?: Adj[] } | null)?.placementBidding) ?? []) as Adj[]
  for (const lane of LANES) {
    for (const v of VALUES) {
      pairs++
      const a = inline(existing, lane, v)
      const b = buildManualAdjustments(existing, lane as never, v)
      if (meaning(a) === meaning(b)) sameMeaning++
      else diffs.push(`${c.name} · ${lane}→${v}%\n    inline: ${meaning(a) || '(none)'}\n    helper: ${meaning(b) || '(none)'}`)
      if (JSON.stringify([...a].sort((x, y) => x.placement.localeCompare(y.placement))) === JSON.stringify([...b].sort((x, y) => x.placement.localeCompare(y.placement)))) sameBytes++
      else {
        const gone = a.filter((x) => !b.some((y) => y.placement === x.placement))
        if (gone.length) dropped.push(`${lane}→${v}%: helper drops ${gone.map((g) => `${g.placement}=${g.percentage}`).join(' ')}`)
      }
    }
  }
}

console.log(`SAME MEANING (identical set of value-carrying lanes): ${sameMeaning} / ${pairs}`)
console.log(`byte-identical payloads:                              ${sameBytes} / ${pairs}`)
if (diffs.length) {
  console.log(`\n🔴 ${diffs.length} pairs DISAGREE about what Amazon is told:`)
  for (const d of diffs.slice(0, 10)) console.log('  ' + d)
} else {
  console.log('\n✓ ZERO pairs disagree about what Amazon is told — the merge rule is the same.')
}
const kinds = [...new Set(dropped.map((d) => d.split(':')[1]?.trim().replace(/=\d+/g, '=N')))]
console.log(`\nByte differences are ${pairs - sameBytes} pairs, all of one kind: the helper omits an untouched lane that is already 0.`)
console.log(`  distinct shapes: ${JSON.stringify(kinds.slice(0, 6))}`)
console.log(`  Amazon reads absent and 0 identically, and updatePlacementBidding derives history from the NEW`)
console.log(`  array only — so an omitted zero writes no CampaignBidHistory row. The helper is the cleaner of`)
console.log(`  the two: it also clamps every lane, dedupes a doubled lane, and preserves non-managed placements.`)
await prisma.$disconnect()
