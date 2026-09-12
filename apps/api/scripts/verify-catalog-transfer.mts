/** Exercises the real catalog writer in an always-rolled-back transaction. No marketplace calls. */
import assert from 'node:assert/strict'
import prisma from '../src/db.js'
import { buildTransferPlan, transferContracts, type TransferContext, type TransferProduct } from '../src/services/pim/catalog-transfer-plan.js'
import { applyTransferTarget } from '../src/services/pim/catalog-transfer.service.js'
import { transferTargetKey, type TransferRow } from '@nexus/shared/catalog-transfer'

const sku = `NEXUS-TRANSFER-VERIFY-${Date.now()}`
const rollback = new Error('ROLLBACK_VERIFIED_CATALOG_TRANSFER')
let verified = false
try {
  const [family, account, markets] = await Promise.all([
    prisma.productFamily.findUniqueOrThrow({ where: { code: 'jackets' }, select: { id: true, code: true, label: true } }),
    prisma.channelConnection.findFirstOrThrow({ where: { channelType: 'AMAZON', isPrimary: true, isActive: true }, select: { id: true, channelType: true, marketplace: true } }),
    prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, code: true } }),
  ])
  const context: TransferContext = { products: new Map(), listings: new Map(), families: [family], categories: [], accounts: [account], markets }
  const contracts = transferContracts('IT')
  const row = (field: string, value?: unknown, action: TransferRow['action'] = 'SET'): TransferRow => ({ row: 2, entity: 'Products', sku, channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', field, action, value })
  const plan = await buildTransferPlan([row('family', family.code), row('name', 'Catalog verification fixture'), row('material', 'Cotton')], 'create', context, contracts)
  assert.deepEqual(plan.issues, [])
  await contracts.channel('AMAZON', 'IT', 'OUTERWEAR')
  try {
    await prisma.$transaction(async tx => {
      await applyTransferTarget(tx, plan.targets[0], 'verification-rollback', null)
      let product = await tx.product.findUniqueOrThrow({ where: { sku }, include: { categories: { select: { categoryId: true, isPrimary: true } } } })
      assert.equal(product.status, 'DRAFT'); assert.equal(product.familyId, family.id)
      context.products.set(sku, JSON.parse(JSON.stringify(product)) as TransferProduct)
      const localized = await buildTransferPlan([{ ...row('name', 'Giacca di verifica'), locale: 'it' }], 'update', context, contracts)
      assert.deepEqual(localized.issues, [])
      await applyTransferTarget(tx, localized.targets[0], 'verification-rollback', null)
      product = await tx.product.findUniqueOrThrow({ where: { sku }, include: { categories: { select: { categoryId: true, isPrimary: true } } } })
      assert.equal((product.localizedContent as Record<string, { title: string }>).it.title, 'Giacca di verifica')
      assert.equal(product.name, 'Catalog verification fixture')
      context.products.set(sku, JSON.parse(JSON.stringify(product)) as TransferProduct)
      const channelRow = (field: string, value?: unknown, action: TransferRow['action'] = 'SET'): TransferRow => ({ ...row(field, value, action), entity: 'Overrides', channel: 'AMAZON', accountId: account.id, marketplace: 'IT' })
      const listingPlan = await buildTransferPlan([{ ...channelRow('productType', 'OUTERWEAR'), entity: 'Listings' }, channelRow('item_name', 'Catalog channel fixture')], 'create', context, contracts)
      assert.deepEqual(listingPlan.issues, [])
      await applyTransferTarget(tx, listingPlan.targets[0], 'verification-rollback', null)
      let listing = await tx.channelListing.findFirstOrThrow({ where: { productId: product.id, channelConnectionId: account.id, marketplace: 'IT', aliasKey: '' } })
      assert.equal(listing.isPublished, false); assert.equal(listing.listingStatus, 'DRAFT')
      assert.equal(listing.followMasterTitle, false); assert.equal(listing.titleOverride, 'Catalog channel fixture')
      context.listings.set(transferTargetKey(channelRow('item_name')), [JSON.parse(JSON.stringify(listing))])
      const inherit = await buildTransferPlan([channelRow('item_name', undefined, 'INHERIT')], 'update', context, contracts)
      assert.deepEqual(inherit.issues, [])
      await applyTransferTarget(tx, inherit.targets[0], 'verification-rollback', null)
      listing = await tx.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
      assert.equal(listing.followMasterTitle, true); assert.equal(listing.titleOverride, null)
      assert.equal(listing.isPublished, false)
      const auditCount = await tx.auditLog.count({ where: { entityId: { in: [product.id, listing.id] } } })
      assert.equal(auditCount, 4)
      // A stale target cannot overwrite the localized edit, even inside this transaction.
      await assert.rejects(() => applyTransferTarget(tx, localized.targets[0], 'verification-rollback', null), /changed since preview/)
      verified = true
      throw rollback
    }, { timeout: 60_000 })
  } catch (e) { if (e !== rollback) throw e }
  assert.equal(verified, true)
  assert.equal(await prisma.product.count({ where: { sku } }), 0)
  console.log(JSON.stringify({ passed: true, checks: ['draft product creation', 'family assignment', 'localized content isolation', 'exact account draft listing', 'explicit title override', 'return to inheritance', 'audit entries', 'stale preview refusal', 'transaction rollback'], persistedTestProducts: 0 }))
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
  process.exit(process.exitCode ?? 0)
}
