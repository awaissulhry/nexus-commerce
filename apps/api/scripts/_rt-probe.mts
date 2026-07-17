/** Round-trip probe: edit a synthesized shared row → save → reload → assert
 *  EXACT round-trip → restore. Proves "stays as I leave it" on prod data. */
process.env.NEXUS_ENABLE_EBAY_PUBLISH = 'true'
process.env.EBAY_PUBLISH_MODE = 'dry-run'
process.env.EBAY_API_BASE = 'http://127.0.0.1:9'
delete process.env.NEXUS_EBAY_REAL_API

const { default: Fastify } = await import('fastify')
const { default: routes } = await import('../src/routes/ebay-flat-file.routes.js')
const app = Fastify({ logger: false })
await app.register(routes)
await app.ready()

const getRows = async () => {
  const r = await app.inject({ method: 'GET', url: '/ebay/flat-file/rows?scope=all&marketplace=IT' })
  return (r.json() as any).rows as any[]
}

const rows1 = await getRows()
const target = rows1.find((r) => String(r._rowId ?? '').startsWith('shared::') && String(r.parent_sku) === 'GALE-JACKET-ALT1')
if (!target) { console.log('NO SYNTHESIZED ROW FOUND'); process.exit(1) }
const orig = { it_price: target.it_price, subtitle: target.subtitle ?? '', condition: target.condition ?? '' }
console.log(`target: ${target._rowId} — orig price=${orig.it_price} subtitle="${orig.subtitle}" condition="${orig.condition}"`)

// 1. Mutate: price + two content fields
const mutated = { ...target, it_price: 106, subtitle: 'RT-PROBE-SUBTITLE', condition: 'NEW_WITH_TAGS', _dirty: true }
const save1 = await app.inject({ method: 'PATCH', url: '/ebay/flat-file/rows', payload: { rows: [mutated], marketplace: 'IT' } })
const s1 = save1.json() as any
console.log(`save1: HTTP ${save1.statusCode} memberships=${JSON.stringify(s1.sharedMemberships ?? null)}`)

// 2. Reload → assert verbatim
const rows2 = await getRows()
const after = rows2.find((r) => r._rowId === target._rowId)
const checks = [
  ['it_price', after?.it_price, 106],
  ['subtitle', after?.subtitle, 'RT-PROBE-SUBTITLE'],
  ['condition', after?.condition, 'NEW_WITH_TAGS'],
  ['aspect intact', after?.aspect_Taglia ?? after?.aspect_taglia, target.aspect_Taglia ?? target.aspect_taglia],
  ['item id live', after?.it_item_id, target.it_item_id],
]
let pass = true
for (const [name, got, want] of checks) {
  const ok = String(got) === String(want)
  if (!ok) pass = false
  console.log(`  ${ok ? '✓' : '✗'} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
}

// 3. Restore originals
const restore = { ...after, it_price: orig.it_price, subtitle: orig.subtitle, condition: orig.condition, _dirty: true }
const save2 = await app.inject({ method: 'PATCH', url: '/ebay/flat-file/rows', payload: { rows: [restore], marketplace: 'IT' } })
const rows3 = await getRows()
const final = rows3.find((r) => r._rowId === target._rowId)
const restored = String(final?.it_price) === String(orig.it_price) && String(final?.subtitle ?? '') === String(orig.subtitle)
console.log(`restore: HTTP ${save2.statusCode} — back to original: ${restored ? '✓' : '✗'} (price=${final?.it_price})`)
console.log(pass && restored ? '\nROUND-TRIP VERBATIM: PASS' : '\nFAIL')
await app.close()
process.exit(pass && restored ? 0 : 1)
