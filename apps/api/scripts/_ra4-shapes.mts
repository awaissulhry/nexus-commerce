/** RA.AUTO — what shape are `conditions` and `actions` ACTUALLY in? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { name: true, trigger: true, conditions: true, actions: true },
  orderBy: { name: 'asc' },
})

const shape = (v: unknown): string => {
  if (v == null) return 'null'
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[${[...new Set(v.map((x) => shape(x)))].join('|')}]`
  if (typeof v === 'object') return `{${Object.keys(v as object).sort().join(',')}}`
  return typeof v
}

console.log('\n═══ conditions shapes ═══')
const cShapes = new Map<string, number>()
for (const r of rules) cShapes.set(shape(r.conditions), (cShapes.get(shape(r.conditions)) ?? 0) + 1)
for (const [s, n] of [...cShapes].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(3)} × ${s}`)

console.log('\n═══ actions shapes ═══')
const aShapes = new Map<string, number>()
for (const r of rules) aShapes.set(shape(r.actions), (aShapes.get(shape(r.actions)) ?? 0) + 1)
for (const [s, n] of [...aShapes].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(3)} × ${s}`)

console.log('\n═══ 6 real examples ═══')
for (const r of rules.slice(0, 6)) {
  console.log(`\n── ${r.name}  [${r.trigger}]`)
  console.log('   conditions:', JSON.stringify(r.conditions))
  console.log('   actions   :', JSON.stringify(r.actions))
}

console.log('\n═══ every distinct condition FIELD + OP in use ═══')
const leaves: Array<{ field: string; op: string; sample: unknown }> = []
const walk = (v: unknown) => {
  if (v == null) return
  if (Array.isArray(v)) { v.forEach(walk); return }
  const o = v as Record<string, unknown>
  if (typeof o.field === 'string' && typeof o.op === 'string') leaves.push({ field: o.field, op: o.op, sample: o.value })
  if (Array.isArray(o.children)) o.children.forEach(walk)
  if (o.child) walk(o.child)
  if (Array.isArray(o.conditions)) o.conditions.forEach(walk)
}
rules.forEach((r) => walk(r.conditions))
const byField = new Map<string, { ops: Set<string>; sample: unknown; n: number }>()
for (const l of leaves) {
  const e = byField.get(l.field) ?? { ops: new Set<string>(), sample: l.sample, n: 0 }
  e.ops.add(l.op); e.n++; byField.set(l.field, e)
}
console.log(`${leaves.length} condition leaves across ${byField.size} distinct fields:`)
for (const [f, e] of [...byField].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`   ${String(e.n).padStart(3)} × ${f.padEnd(34)} ops=${[...e.ops].join(',').padEnd(16)} e.g. ${JSON.stringify(e.sample)}`)
}
console.log(`rules with ZERO condition leaves: ${rules.filter((r) => { const b: typeof leaves = []; const w = (v: unknown) => { if (v == null) return; if (Array.isArray(v)) { v.forEach(w); return }; const o = v as Record<string, unknown>; if (typeof o.field === 'string' && typeof o.op === 'string') b.push({ field: o.field, op: o.op, sample: null }); if (Array.isArray(o.children)) o.children.forEach(w); if (o.child) w(o.child); if (Array.isArray(o.conditions)) o.conditions.forEach(w) }; w(r.conditions); return b.length === 0 }).length} of ${rules.length}`)

console.log('\n═══ every distinct action key set ═══')
const aKeys = new Map<string, number>()
for (const r of rules) for (const a of (Array.isArray(r.actions) ? r.actions : [])) {
  const o = a as Record<string, unknown>
  const k = `${String(o.type)} → {${Object.keys(o).filter((x) => x !== 'type').sort().join(',')}}`
  aKeys.set(k, (aKeys.get(k) ?? 0) + 1)
}
for (const [k, n] of [...aKeys].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(3)} × ${k}`)

console.log('\n(read-only — nothing was written)')
await prisma.$disconnect()
