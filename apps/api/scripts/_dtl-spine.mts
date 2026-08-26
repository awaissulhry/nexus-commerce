// NAF.DT.1 verification — the spine against the real fleet history.
import '../src/env.js'
const { getFleetTimeline } = await import('../src/services/agent-fleet/fleet-timeline.service.js')
const { default: prisma } = await import('../src/db.js')

const page = await getFleetTimeline({}, { limit: 12 })
console.log(`TOTAL events: ${page.total}`)
console.log('by kind:', JSON.stringify(page.countsByKind))
console.log('actors:', page.actors.map((a) => `${a.name}(${a.kind})`).join(', '))
console.log('\n--- first page ---')
for (const e of page.events) {
  console.log(`${e.at.slice(0, 16)}  [${e.outcome.padEnd(9)}] ${e.title}`)
  if (e.detail) console.log(`${' '.repeat(24)}↳ ${e.detail.slice(0, 110)}`)
}
console.log('\nnextCursor:', page.nextCursor)

// paging integrity over the whole history
const seen = new Set<string>()
let cursor: string | null = null
let pages = 0
do {
  const p = await getFleetTimeline({}, { limit: 25, cursor: cursor ?? undefined })
  for (const e of p.events) {
    if (seen.has(e.id)) throw new Error(`DUPLICATE across pages: ${e.id}`)
    seen.add(e.id)
  }
  cursor = p.nextCursor
  pages++
} while (cursor && pages < 40)
console.log(`\npaged through ${seen.size} unique events in ${pages} pages (total says ${page.total})`)
console.log(seen.size === page.total ? 'PAGING OK — no gaps, no repeats' : 'MISMATCH')
await prisma.$disconnect()
