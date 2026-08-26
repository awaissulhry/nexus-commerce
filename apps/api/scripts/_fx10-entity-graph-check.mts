import '../src/env.js'
const { getEntityGraphOverview, getEntityNeighborhood } = await import('../src/services/agent-fleet/entity-graph.service.js')
const { default: prisma } = await import('../src/db.js')

const t0 = Date.now()
const overview = await getEntityGraphOverview()
console.log(`OVERVIEW (${Date.now() - t0}ms): ${overview.nodes.length} nodes, ${overview.edges.length} edges, truncated=${overview.truncated}`)
console.log('relations:', JSON.stringify(overview.relationCounts))
console.log('top nodes by degree:')
for (const n of overview.nodes.slice(0, 6)) console.log(`  ${n.label} (${n.sublabel ?? ''}) degree=${n.degree}`)

const hub = overview.nodes[0]
if (hub) {
  const t1 = Date.now()
  const nb = await getEntityNeighborhood(hub.type, hub.id, { depth: 2 })
  console.log(`\nNEIGHBOURHOOD of "${hub.label}" (${Date.now() - t1}ms): ${nb.nodes.length} nodes, ${nb.edges.length} edges, truncated=${nb.truncated}`)
  console.log('relations:', JSON.stringify(nb.relationCounts))
  console.log('sample nodes:')
  for (const n of nb.nodes.slice(0, 6)) console.log(`  [${n.type}] ${n.label} — ${n.sublabel ?? ''}`)
}
await prisma.$disconnect()
