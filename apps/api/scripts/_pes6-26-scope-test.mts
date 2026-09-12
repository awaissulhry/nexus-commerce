/**
 * §1.6(I) — a `$key` reference resolves against the SAME coordinate the formula is written for.
 * Pins the PRINCIPLE (master reads master, channel reads its coordinate), not a literal string.
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname })
import prisma from '../src/db.js'
import { resolveAttributes } from '../src/services/pim/attribute-resolver.js'
import { evaluateAgainstContext } from '../src/services/pim/mapping/cell-formula.service.js'
import { resolveSourcePath } from '../src/services/pim/resolve-channel-field.js'

const ok = (c: boolean, m: string) => console.log(`  ${c ? 'PASS' : '🔴 FAIL'}  ${m}`)
const CHANNEL_LAYERS = new Set(['channelOverride', 'channelExplicit'])

const p = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET-BLACK-MEN-L' } })
const de = await prisma.channelListing.findFirst({ where: { productId: p!.id, channel: 'AMAZON', marketplace: 'DE' } })

const mkCtx = (listing: any, locale: string) => {
  const resolved = resolveAttributes({ product: p as any, parent: null, channelListing: listing, locale })
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(resolved)) flat[k] = v.value
  return { product: p, parent: null, channelListing: listing, locale, resolved, flat } as any
}
const masterCtx = mkCtx(null, 'en')
const channelCtx = mkCtx(de, 'de')

console.log('--- master scope reads the MASTER row ---')
ok(Object.values(masterCtx.resolved).every((v: any) => !CHANNEL_LAYERS.has(v.source)),
   'no key in a master resolve comes from a channel layer')
const mBrand = evaluateAgainstContext({ expr: '$brand', ctx: masterCtx, expressions: {} })
ok(mBrand.value === resolveSourcePath('brand', masterCtx.flat, p as any, 'en'),
   `$brand on master === the master resolver's brand (${JSON.stringify(mBrand.value)})`)

console.log('\n--- channel scope reads THAT coordinate ---')
const overridden = Object.keys(channelCtx.resolved).filter(k => CHANNEL_LAYERS.has(channelCtx.resolved[k].source))
ok(overridden.length > 0, `AMAZON·DE resolves ${overridden.length} key(s) from a channel layer: ${overridden.join(', ')}`)
const key = overridden.find(k => typeof channelCtx.resolved[k].value === 'string') ?? overridden[0]
const cVal = evaluateAgainstContext({ expr: `$${key}`, ctx: channelCtx, expressions: {} })
const mVal = evaluateAgainstContext({ expr: `$${key}`, ctx: masterCtx, expressions: {} })
ok(JSON.stringify(cVal.value) !== JSON.stringify(mVal.value),
   `$${key} differs by scope — channel=${JSON.stringify(String(cVal.value).slice(0,32))} master=${JSON.stringify(String(mVal.value).slice(0,32))}`)
ok(cVal.value === channelCtx.resolved[key].value, `$${key} on channel === that coordinate's resolved value`)

console.log('\n--- the ACTUAL cause of the report, on the PARENT PES.4 tested ---')
const parent = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' } })
const parentCtx = (() => {
  const resolved = resolveAttributes({ product: parent as any, parent: null, locale: 'en' })
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(resolved)) flat[k] = v.value
  return { product: parent, parent: null, channelListing: null, locale: 'en', resolved, flat } as any
})()
const pv = evaluateAgainstContext({ expr: '$brand', ctx: parentCtx, expressions: {} })
console.log('  GALE-JACKET Product.brand            :', JSON.stringify(parent!.brand))
console.log('  GALE-JACKET categoryAttributes.brand :', JSON.stringify(((parent!.categoryAttributes ?? {}) as any).brand))
console.log('  resolver master $brand               :', JSON.stringify(pv.value), `(source=${parentCtx.resolved.brand?.source})`)
ok(!CHANNEL_LAYERS.has(parentCtx.resolved.brand?.source),
   `master $brand comes from a MASTER layer (${parentCtx.resolved.brand?.source}) — not a channel/marketplace value`)
ok(parent!.brand !== ((parent!.categoryAttributes ?? {}) as any).brand,
   'the row genuinely holds TWO different master brands — Product.brand vs categoryAttributes.brand')
ok(pv.value === ((parent!.categoryAttributes ?? {}) as any).brand,
   'the resolver layers categoryAttributes OVER the legacy column, so $brand is the attribute')
console.log('\n  (on the CHILD, categoryAttributes.brand is unset, so $brand is the column: "Xavia")')
await prisma.$disconnect()
process.exit(0)
