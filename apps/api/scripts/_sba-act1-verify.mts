// NAF.SB.ACT.1 — prove the five edits against the REAL database. Read-only.
import '../src/env.js'
const { getFleetTimeline, countFleetTimeline } = await import(
  '../src/services/agent-fleet/fleet-timeline.service.js'
)

const all = await countFleetTimeline({})
const noDiag = await countFleetTimeline({ includeDiagnostic: false })

console.log('=== 1 · approvals scoped to the fleet ===')
console.log('total events now      =', all.total, '(was 155)')
console.log('countsByKind          =', JSON.stringify(all.countsByKind))
console.log(
  'approval events left  =',
  (all.countsByKind['approval.requested'] ?? 0) + (all.countsByKind['approval.decided'] ?? 0),
  '(was 36)',
)
console.log('actors                =', all.actors.map((a) => a.key).join(', '))
console.log('  → junk actors gone? ', !all.actors.some((a) => ['manual-action', 'listing-quality-keeper'].includes(a.key)))

console.log('\n=== 2 · links point into /fleet ===')
const page = await getFleetTimeline({}, { limit: 200 })
const hrefs = [...new Set(page.events.map((e) => e.href).filter((h): h is string => h != null))]
console.log('distinct hrefs        =', hrefs.length)
console.log('  → any pre-move URL? ', hrefs.some((h) => h.includes('rules-automation')))
console.log('  → all start /fleet? ', hrefs.every((h) => h.startsWith('/fleet')))

console.log('\n=== 3 · workflowKey surfaces ===')
const stamped = page.events.filter((e) => e.workflowKey != null)
console.log('events with a routine =', stamped.length, '| keys =', [...new Set(stamped.map((e) => e.workflowKey))].join(', '))
console.log('  → any undefined?    ', page.events.some((e) => e.workflowKey === undefined))

console.log('\n=== 4 · dataVintage surfaces ===')
const vintaged = page.events.filter((e) => e.dataVintage != null)
console.log('findings with vintage =', vintaged.length, 'of', all.countsByKind['finding.raised'] ?? 0)
const drifted = vintaged.filter((e) => e.dataVintage!.slice(0, 10) !== e.at.slice(0, 10))
console.log('  → vintage ≠ first-seen day:', drifted.length, '(each of these would have read as fresh)')

console.log('\n=== 5 · diagnostics excluded, never concealed ===')
console.log('total incl. self-test =', all.total)
console.log('total excl. self-test =', noDiag.total)
console.log('countsByKind (excl.)  =', JSON.stringify(noDiag.countsByKind))
console.log('actors (excl.)        =', noDiag.actors.map((a) => a.key).join(', '))
const sum = Object.values(noDiag.countsByKind).reduce((a, b) => a + b, 0)
console.log('  → counts sum == total?', sum === noDiag.total, `(${sum} vs ${noDiag.total})`)
const p2 = await getFleetTimeline({ includeDiagnostic: false }, { limit: 200 })
console.log('  → rows == total?      ', p2.events.length === noDiag.total, `(${p2.events.length} vs ${noDiag.total})`)
console.log('  → self-test rows left?', p2.events.some((e) => e.diagnostic))

console.log('\n=== the honest headline ===')
const runs = p2.events.filter((e) => e.kind === 'run.ok' || e.kind === 'run.failed')
console.log('business runs         =', runs.length)
console.log('business run failures =', runs.filter((e) => e.kind === 'run.failed').length)

console.log('\n=== paging still walks the whole history with no gaps ===')
let cursor: string | undefined
const seen = new Set<string>()
let pages = 0
for (;;) {
  const p = await getFleetTimeline({}, { limit: 40, cursor })
  pages++
  for (const e of p.events) {
    if (seen.has(e.id)) throw new Error(`REPEAT: ${e.id}`)
    seen.add(e.id)
  }
  if (!p.nextCursor) break
  cursor = p.nextCursor
  if (pages > 20) throw new Error('runaway')
}
console.log(`walked ${seen.size} unique events in ${pages} pages | matches total? ${seen.size === all.total}`)
