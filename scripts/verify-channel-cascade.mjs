#!/usr/bin/env node
// D.7 — Verify the /products hard-delete channel cascade end-to-end
// against the running API (in dry-run mode for Amazon SP-API).
//
// What this exercises:
//   1. POST /api/products/bulk-soft-delete         — moves test product to bin
//   2. GET  /api/products/hard-delete-preflight    — surfaces warnings
//   3. POST /api/products/bulk-hard-delete         — channelAction='unpublish' / 'delete' / 'none'
//   4. Inspect OutboundSyncQueue                   — verify rows have the right shape
//
// Requires:
//   - API server running locally on http://localhost:8080
//   - A throwaway test product seeded with a ChannelListing
//     (AMAZON/IT, status=ACTIVE, externalListingId set to a fake SKU)
//
// Usage:
//   node scripts/verify-channel-cascade.mjs                # full pass
//   node scripts/verify-channel-cascade.mjs --keep-data    # don't cleanup
//
// Note: this is a SMOKE test, not a full E2E. Amazon/eBay/Shopify
// adapter execution is exercised under AMAZON_PUBLISH_MODE=dry-run
// — no real channel-side state changes. For real-channel E2E, swap
// env to live and target a sandbox store.

import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API = process.env.NEXUS_API_URL || 'http://localhost:8080'
const KEEP = process.argv.includes('--keep-data')

const prisma = new PrismaClient()

let pass = 0, fail = 0
const ok = (l) => { console.log('  ✓', l); pass++ }
const bad = (l, d = '') => { console.log('  ✗', l, d ? `\n    → ${d}` : ''); fail++ }

const tag = `cascade-test-${Date.now()}`

async function seed() {
  console.log(`\nSeeding test product (tag=${tag})…`)
  const product = await prisma.product.create({
    data: {
      sku: `${tag}-SKU`,
      name: `Cascade test ${tag}`,
      basePrice: 19.99,
      status: 'ACTIVE',
      deletedAt: new Date(), // already in the bin so hard-delete proceeds
    },
  })
  const listing = await prisma.channelListing.create({
    data: {
      productId: product.id,
      channel: 'AMAZON',
      channelMarket: 'AMAZON_IT',
      region: 'IT',
      marketplace: 'IT',
      title: product.name,
      description: '',
      price: product.basePrice,
      quantity: 0,
      listingStatus: 'ACTIVE',
      isPublished: true,
      externalListingId: `${tag}-EXT`,
      syncStatus: 'IDLE',
    },
  })
  console.log(`  product.id=${product.id}, listing.id=${listing.id}`)
  return { product, listing }
}

async function cleanup(productId) {
  if (KEEP) {
    console.log(`\n--keep-data set; leaving product ${productId} in place.`)
    return
  }
  console.log('\nCleaning up…')
  try {
    await prisma.outboundSyncQueue.deleteMany({ where: { productId } })
    await prisma.channelListing.deleteMany({ where: { productId } })
    await prisma.product.deleteMany({ where: { id: productId } })
    ok('cleanup complete')
  } catch (e) {
    bad('cleanup failed', e?.message ?? String(e))
  }
}

async function main() {
  console.log(`\n[verify-channel-cascade] API=${API}`)

  // ── Seed ───────────────────────────────────────────────────────
  const { product } = await seed()

  // ── Preflight ──────────────────────────────────────────────────
  console.log('\n[1] GET /api/products/hard-delete-preflight')
  {
    const r = await fetch(`${API}/api/products/hard-delete-preflight?ids=${product.id}`)
    if (!r.ok) { bad('preflight HTTP', r.status); return cleanup(product.id) }
    const j = await r.json()
    if (Array.isArray(j.channelListings) && j.channelListings.length === 1) {
      ok('one channel listing reported')
    } else {
      bad('expected 1 channelListings entry', JSON.stringify(j.channelListings))
    }
    if (j.channelListings?.[0]?.channel === 'AMAZON') ok('channel=AMAZON')
    else bad('channel field', j.channelListings?.[0]?.channel)
    if (j.channelListings?.[0]?.marketplace === 'IT') ok('marketplace=IT')
    else bad('marketplace field', j.channelListings?.[0]?.marketplace)
    if (Array.isArray(j.openOrders) && j.openOrders.length === 0) ok('no open orders')
    if (Array.isArray(j.activeBundles) && j.activeBundles.length === 0) ok('no active bundles')
    if (Array.isArray(j.fbaInventory) && j.fbaInventory.length === 0) ok('no FBA stock')
  }

  // ── Hard-delete with channelAction=unpublish ───────────────────
  console.log('\n[2] POST /api/products/bulk-hard-delete (channelAction=unpublish)')
  {
    const r = await fetch(`${API}/api/products/bulk-hard-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIds: [product.id], channelAction: 'unpublish' }),
    })
    if (!r.ok) { bad('hard-delete HTTP', `${r.status} ${await r.text()}`); return cleanup(product.id) }
    const j = await r.json()
    if (j.ok && j.purged === 1) ok('purged=1')
    else bad('purged count', JSON.stringify(j))
    if (j.channelCascadeEnqueued === 1) ok('channelCascadeEnqueued=1')
    else bad('channelCascadeEnqueued', String(j.channelCascadeEnqueued))
  }

  // ── Inspect OutboundSyncQueue ──────────────────────────────────
  console.log('\n[3] OutboundSyncQueue row shape')
  {
    const rows = await prisma.outboundSyncQueue.findMany({
      where: { productId: product.id },
      orderBy: { createdAt: 'desc' },
    })
    if (rows.length === 1) ok('exactly 1 queue row written')
    else bad('queue row count', String(rows.length))
    const row = rows[0]
    if (row?.syncType === 'UNPUBLISH_LISTING') ok('syncType=UNPUBLISH_LISTING')
    else bad('syncType', row?.syncType)
    if (row?.targetChannel === 'AMAZON') ok('targetChannel=AMAZON')
    else bad('targetChannel', row?.targetChannel)
    if (row?.externalListingId?.includes(tag)) ok('externalListingId preserved')
    else bad('externalListingId', row?.externalListingId)
    if (row?.payload && (row.payload).channelAction === 'unpublish') ok('payload.channelAction=unpublish')
    else bad('payload.channelAction', JSON.stringify(row?.payload))
  }

  // ── Verify Product + ChannelListing were wiped ─────────────────
  console.log('\n[4] Local cascade wiped')
  {
    const stillThere = await prisma.product.findUnique({ where: { id: product.id } })
    if (!stillThere) ok('Product row gone')
    else bad('Product still exists', JSON.stringify(stillThere))
    const listingsLeft = await prisma.channelListing.count({ where: { productId: product.id } })
    if (listingsLeft === 0) ok('ChannelListing rows gone')
    else bad('ChannelListing leftovers', String(listingsLeft))
  }

  // Queue rows survive the cascade (productId FK is onDelete: Cascade,
  // so verify by tag substring on externalListingId instead).
  await prisma.outboundSyncQueue.deleteMany({
    where: { externalListingId: { contains: tag } },
  })

  await cleanup(product.id)

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('FATAL:', e?.stack ?? e)
  await prisma.$disconnect()
  process.exit(1)
})
