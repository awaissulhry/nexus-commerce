/** ACR.1.4 — run the real Today board against prod. READ-ONLY (the service only reads). */
import '../src/env.js'
const { getTodayBoard } = await import('../src/services/advertising/ads-today-board.service.js')
const b = await getTodayBoard()
const eur = (c: number | null) => (c == null ? '—' : `€${(c / 100).toFixed(2)}`)
console.log(`\nGenerated ${b.generatedAt}`)
console.log(`Headline: ${eur(b.headline.wastedSpend30dCents)} across ${b.headline.wastedTargets} targets`)
console.log(`          ${b.headline.note}`)
console.log(`Totals: ${b.totals.critical} critical · ${b.totals.warning} warning · ${b.totals.info} info\n`)
for (const e of b.exceptions) {
  console.log(`${'─'.repeat(96)}`)
  console.log(`[${e.severity.toUpperCase()}] ${e.title}`)
  console.log(`  ${e.detail}`)
  console.log(`  count=${e.count}  amount=${eur(e.amountCents)} (${e.amountNote})`)
  console.log(`  since=${e.since ?? '—'}  action=${e.action ? `${e.action.label} → ${e.action.href}` : 'none'}`)
}
console.log(`${'─'.repeat(96)}\n`)
const { default: prisma } = await import('../src/db.js')
await prisma.$disconnect()
