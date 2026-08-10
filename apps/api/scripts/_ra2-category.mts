/** RA.2 — does ruleCategory() mislabel any rule that can WRITE as "Alerts — informs, never writes"? Read-only. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { ruleCategory, RULE_CATEGORY_META } = await import('../src/services/advertising/rule-category.js')
const { resolveAutonomy } = await import('../src/services/advertising/ads-autonomy.js')

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, actions: true, enabled: true, dryRun: true, autonomyLevel: true },
})

/** Actions that never touch Amazon. Everything else is a write of some kind. */
const NON_WRITING = new Set(['notify', 'alert_operator', 'log_only'])

const byCat: Record<string, number> = {}
const mislabelled: Array<{ name: string; level: string; actions: string[] }> = []

for (const r of rules) {
  const types = (Array.isArray(r.actions) ? r.actions : [])
    .map((a) => String((a as { type?: unknown })?.type ?? '')).filter(Boolean)
  const cat = ruleCategory(types)
  byCat[cat] = (byCat[cat] ?? 0) + 1
  const writing = types.filter((t) => !NON_WRITING.has(t))
  if (cat === 'alert' && writing.length > 0) {
    mislabelled.push({ name: r.name, level: resolveAutonomy(r), actions: [...new Set(writing)] })
  }
}

console.log('\nRules per category:')
for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${c.padEnd(10)} "${RULE_CATEGORY_META[c as keyof typeof RULE_CATEGORY_META].label}"`)
}

console.log(`\nCategorised "Alerts" (informs, never writes) but CAN write: ${mislabelled.length}`)
for (const m of mislabelled) {
  console.log(`  [${m.level.padEnd(7)}] ${m.name}`)
  console.log(`            actions: ${m.actions.join(', ')}`)
}

// Which action types the taxonomy has no FAMILY for — asked of the real function, so
// this cannot go stale the way a hand-copied list of mapped actions does (it did: the
// first version of this probe kept its own ALL_MAPPED and reported four "unmapped"
// types that ruleCategory had just been taught).
const landing = new Map<string, string>()
for (const r of rules) {
  for (const a of (Array.isArray(r.actions) ? r.actions : [])) {
    const t = String((a as { type?: unknown })?.type ?? '')
    if (t && !NON_WRITING.has(t)) landing.set(t, ruleCategory([t]))
  }
}
const leftovers = [...landing].filter(([, c]) => c === 'other' || c === 'alert')
console.log(`\nWriting action types with no family of their own: ${leftovers.length}`)
for (const [t, c] of leftovers) console.log(`  ${t} → ${c}`)

await prisma.$disconnect()
