import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const p = new PrismaClient()
const J = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v } catch { return v } }
const first = (a) => Array.isArray(a) && a[0] && typeof a[0] === 'object' ? (a[0].value ?? JSON.stringify(a[0])) : (a ?? '—')

// Compare XXS (broken) vs a working sibling (S), IT market
const want = ['GALE-JACKET-BLACK-MEN-XXS', 'GALE-JACKET-BLACK-MEN-S']
for (const sku of want) {
  const prod = await p.product.findFirst({ where: { sku }, select: { id: true } })
  if (!prod) { console.log(`${sku}: not found`); continue }
  const l = await p.channelListing.findFirst({ where: { productId: prod.id, channel: 'AMAZON', marketplace: 'IT' }, select: { platformAttributes: true, externalListingId: true } })
  const a = (J(l?.platformAttributes) || {}).attributes || {}
  console.log(`\n══ ${sku}  (ASIN ${l?.externalListingId ?? '—'}) ══`)
  for (const k of ['parentage_level','child_parent_sku_relationship','variation_theme','size','externally_assigned_product_identifier','merchant_suggested_asin','supplier_declared_has_product_identifier_exemption','inner','outer','closure','item_name']) {
    const v = a[k]
    const show = k === 'child_parent_sku_relationship' ? JSON.stringify(v)?.slice(0,80)
      : k === 'item_name' ? String(first(v)).slice(0,40)
      : Array.isArray(v) ? JSON.stringify(v).slice(0,80) : (v ?? '—')
    console.log(`  ${k.padEnd(46)} ${show ?? '—'}`)
  }
}
await p.$disconnect()
