const { getFleetMap } = await import('../src/services/agent-fleet/fleet-map.service.js')
const { default: prisma } = await import('../src/db.js')
const m = await getFleetMap('7d')
for (const e of m.edges) {
  if (e.samples.length === 0) continue
  console.log(e.id)
  for (const s of e.samples)
    console.log('   ', s.severity.padEnd(8), s.kind.padEnd(22), '->', s.entityName ?? `(UNRESOLVED) ${s.entityId}`)
}
await prisma.$disconnect()
