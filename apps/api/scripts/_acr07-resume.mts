/**
 * ACR.0.7c — set the breaker threshold from measured behaviour, then resume.
 *
 * 500/hour: ~6x the post-consolidation arithmetic ceiling (22 enabled rules x 4 evaluator
 * ticks/hour = 88), comfortably above the 228 observed during the first-day backlog burst,
 * and still orders of magnitude below a genuine runaway. Set explicitly rather than left
 * null so the number is visibly an operator decision, not a code default nobody chose.
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { setGuardThresholds, resumeAutomation, getAutomationState } = await import('../src/services/advertising/ads-automation-state.service.js')

console.log('BEFORE:', JSON.stringify(await getAutomationState(), null, 1))
await setGuardThresholds({ maxActionsPerHour: 500 })
await resumeAutomation('operator:awais (ACR.0.7 — breaker tuned from measured rate)')
const after = await getAutomationState()
console.log('\nAFTER :', JSON.stringify(after, null, 1))
console.log(`\neffectivelyStopped = ${after.effectivelyStopped}  (false = writes may flow again)`)
process.exit(0)
