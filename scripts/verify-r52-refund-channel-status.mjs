#!/usr/bin/env node
// Verify R5.2 — refund-channel-status diagnostic endpoint reports
// the live adapter mode per channel.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API = 'http://localhost:8080'

let pass = 0, fail = 0
const ok = (l) => { console.log('  ✓', l); pass++ }
const bad = (l, d) => { console.log('  ✗', l, '\n    →', d); fail++ }

console.log('\n[1] GET /returns/refund-channel-status')
const r = await fetch(`${API}/api/fulfillment/returns/refund-channel-status`)
const j = await r.json()
if (r.ok && Array.isArray(j.items)) ok(`200 OK, ${j.items.length} adapter rows`)
else { bad('shape wrong', JSON.stringify(j).slice(0, 200)); process.exit(1) }

console.log('\n[2] All five active-channel adapters present')
const channels = j.items.map((it) => it.channel)
const uniqueChannels = [...new Set(channels)].sort()
const expected = ['AMAZON', 'EBAY', 'ETSY', 'SHOPIFY', 'WOOCOMMERCE']
if (JSON.stringify(uniqueChannels) === JSON.stringify(expected)) ok(`channels: ${uniqueChannels.join(', ')}`)
else bad('channel set wrong', JSON.stringify(uniqueChannels))

console.log('\n[3] eBay adapter is real')
{
  const ebay = j.items.find((it) => it.channel === 'EBAY')
  if (ebay?.mode === 'real') ok('eBay mode=real')
  else bad('eBay mode wrong', JSON.stringify(ebay))
}

console.log('\n[4] Amazon split FBM/FBA both manual_required')
{
  const amazons = j.items.filter((it) => it.channel === 'AMAZON')
  if (amazons.length === 2) ok('2 Amazon rows (FBM + FBA)')
  else bad(`expected 2, got ${amazons.length}`, JSON.stringify(amazons))
  const fbm = amazons.find((a) => a.variant === 'FBM')
  const fba = amazons.find((a) => a.variant === 'FBA')
  if (fbm?.mode === 'manual_required') ok('FBM mode=manual_required')
  else bad('FBM mode wrong', JSON.stringify(fbm))
  if (fba?.mode === 'manual_required') ok('FBA mode=manual_required')
  else bad('FBA mode wrong', JSON.stringify(fba))
}

console.log('\n[5] Shopify mode tracks NEXUS_ENABLE_SHOPIFY_REFUND env')
{
  const shopify = j.items.find((it) => it.channel === 'SHOPIFY')
  const expected = process.env.NEXUS_ENABLE_SHOPIFY_REFUND === 'true' ? 'real' : 'dryRun'
  if (shopify?.mode === expected) ok(`Shopify mode=${shopify.mode} (env=${process.env.NEXUS_ENABLE_SHOPIFY_REFUND ?? 'unset'})`)
  else bad(`Shopify mode mismatch — expected ${expected}, got ${shopify?.mode}`, JSON.stringify(shopify))
  if (shopify?.envFlag === 'NEXUS_ENABLE_SHOPIFY_REFUND') ok('Shopify carries envFlag for UI to render the toggle hint')
  else bad('envFlag missing on Shopify row', JSON.stringify(shopify))
}

console.log('\n[6] Out-of-scope channels marked not_implemented')
{
  const woo = j.items.find((it) => it.channel === 'WOOCOMMERCE')
  const etsy = j.items.find((it) => it.channel === 'ETSY')
  if (woo?.mode === 'not_implemented') ok('WooCommerce not_implemented')
  else bad('Woo mode wrong', JSON.stringify(woo))
  if (etsy?.mode === 'not_implemented') ok('Etsy not_implemented')
  else bad('Etsy mode wrong', JSON.stringify(etsy))
}

console.log('\n[7] byMode summary count matches items')
{
  const total = Object.values(j.byMode ?? {}).reduce((acc, n) => acc + n, 0)
  if (total === j.items.length) ok(`byMode totals ${total} = items.length`)
  else bad(`byMode total ${total} != ${j.items.length}`, JSON.stringify(j.byMode))
}

console.log('\n[8] Every row has a non-empty notes string')
{
  const empties = j.items.filter((it) => !it.notes || it.notes.length < 10)
  if (empties.length === 0) ok('all rows have meaningful notes')
  else bad(`${empties.length} rows with empty/short notes`, JSON.stringify(empties))
}

console.log(`\n=========================`)
console.log(`Result: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
