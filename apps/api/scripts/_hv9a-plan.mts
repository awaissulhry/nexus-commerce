/** HV.9a — the PLAN for write 1. READ-ONLY: planPromotion only, no writes. */
import '../src/env.js'
const { planPromotion } = await import('../src/services/advertising/harvest-promote.service.js')
const eur=(c:number|null)=>c==null?'—':`€${(c/100).toFixed(2)}`
const ID = 'DE|115625353077718|425987969360011|motorradjacke 4xl'
const plan = await planPromotion({ market: 'DE', candidateIds: [ID], userId: 'preflight' })
console.log('\n═══ planPromotion for write 1 ═══')
console.log(JSON.stringify(plan, null, 1).slice(0, 2600))
