// PES.8 verification step 1 — a DRY RUN against one XAVIA product.
// Builds every prompt for real and prices it. Makes no vendor call.
import '../src/env.js'
const { runEnrichment } = await import('../src/services/ai/enrichment/generate.service.js')
const { priceFor } = await import('../src/services/ai/rate-cards.js')
const { default: prisma } = await import('../src/db.js')

const AIREON = 'cmr1b1yxl0000s4rcvopsqv42'

const r = await runEnrichment({
  productIds: [AIREON],
  market: 'IT',
  scope: { channel: null, marketplace: null },
  dryRun: true,
})

console.log('=== DRY RUN ===')
console.log('refused:', r.refusedReason ?? '(no)')
console.log('provider/model:', r.provider, '/', r.model)
console.log('calls:', r.callCount, ' est $', r.estimatedCostUSD.toFixed(6))
console.log('columns in scope:', r.columnsInScope.length)
for (const c of r.columnsInScope.slice(0, 25)) {
  const caps = [c.maxLength ? `${c.maxLength}ch` : null, c.maxBytes ? `${c.maxBytes}B` : null].filter(Boolean).join('/')
  console.log(`   ${c.columnKey.padEnd(30)} ${(caps || 'no cap').padEnd(14)} ${c.capFrom ?? ''}`)
}
if (r.columnsInScope.length > 25) console.log(`   ... and ${r.columnsInScope.length - 25} more`)
console.log('plan:', JSON.stringify(r.plan, null, 2))

// What the same batch would cost on each candidate model — the model-choice
// number, not a guess.
const inTok = r.estimatedInputTokens
const outTok = r.estimatedOutputCeiling
console.log('\n=== SAME BATCH, PER MODEL (upper bound: max_tokens assumed fully used) ===')
for (const m of ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5']) {
  console.log(`   ${m.padEnd(28)} $${priceFor('anthropic', m, inTok, outTok).toFixed(5)}`)
}
console.log(`   (input ${inTok} tok, output ceiling ${outTok} tok, ${r.callCount} call(s))`)
await prisma.$disconnect()
