import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rules = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { name: true, conditions: true, actions: true } })
const byType = new Map<string, Map<string, Set<string>>>()
let emptyConds = 0
for (const r of rules) {
  if (!((r.conditions as any[]) ?? []).length) emptyConds++
  for (const a of ((r.actions as any[]) ?? [])) {
    const t = String(a?.type ?? '?')
    if (!byType.has(t)) byType.set(t, new Map())
    const m = byType.get(t)!
    for (const [k, v] of Object.entries(a ?? {})) {
      if (k === 'type') continue
      if (!m.has(k)) m.set(k, new Set())
      m.get(k)!.add(typeof v === 'object' ? `<${Array.isArray(v) ? 'array' : 'object'}>` : String(v))
    }
  }
}
console.log(`\n═══ ${rules.length} advertising rules · ${emptyConds} with EMPTY conditions ═══`)
for (const [t, m] of [...byType].sort()) {
  console.log(`\n${t}`)
  for (const [k, vals] of [...m].sort()) {
    const v = [...vals].slice(0, 6).join(' | ')
    console.log(`    ${k.padEnd(24)} ${v}${vals.size > 6 ? ` …(${vals.size})` : ''}`)
  }
}
await prisma.$disconnect()
