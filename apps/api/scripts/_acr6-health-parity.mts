/** ACR.6 — the health service after the change must return the SAME numbers as before. READ-ONLY. */
import '../src/env.js'
const { analyzeAutomationHealth } = await import('../src/services/advertising/ads-automation-health.service.js')
const { default: prisma } = await import('../src/db.js')

const h = await analyzeAutomationHealth()
console.log('\nanalyzeAutomationHealth().rules =', JSON.stringify(h.rules))
console.log('risks =', JSON.stringify(h.risks))

// Independently recompute the OLD expression to prove parity on today's data.
const rules = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { enabled: true, dryRun: true } })
const oldLive = rules.filter((r) => r.enabled && !r.dryRun).length
const oldDry = rules.filter((r) => r.enabled && r.dryRun).length
const oldDisabled = rules.filter((r) => !r.enabled).length
console.log(`old expression   = {"total":${rules.length},"live":${oldLive},"dryRun":${oldDry},"disabled":${oldDisabled}}`)

const same = h.rules.live === oldLive && h.rules.dryRun === oldDry && h.rules.disabled === oldDisabled
console.log(same ? '\n✅ identical on current data — behaviour-preserving' : '\n⚠️ NUMBERS MOVED — investigate before shipping')

await prisma.$disconnect()
