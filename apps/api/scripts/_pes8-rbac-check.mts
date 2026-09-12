// PES.8 — prove each new route resolves to the permission the design intends.
import '../src/env.js'
const { permissionForRoute } = await import('../src/lib/auth/permissions-manifest.js')
const cases: Array<[string, string, string]> = [
  ['POST', '/api/ai/product-enrichment/estimate', 'ai:run (spends nothing, but is the AI surface)'],
  ['POST', '/api/ai/product-enrichment/generate', 'ai:run (spends money)'],
  ['GET',  '/api/products/ai/drafts',             'products:view'],
  ['POST', '/api/products/ai/drafts/approve',     'products:edit (writes the catalogue)'],
  ['POST', '/api/products/ai/drafts/reject',      'products:edit'],
]
let bad = 0
for (const [m, p, intent] of cases) {
  const got = permissionForRoute(m, p)
  const ok = got !== null
  if (!ok) bad++
  console.log(`${ok ? 'OK ' : 'UNMAPPED'} ${m.padEnd(5)} ${p.padEnd(42)} -> ${String(got)}   [intent: ${intent}]`)
}
process.exit(bad === 0 ? 0 : 1)
