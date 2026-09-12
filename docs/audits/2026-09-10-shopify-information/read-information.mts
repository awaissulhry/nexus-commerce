/** Read-only capability check. No Shopify or database mutations. */
import '../../../apps/api/src/env.js'
import '../../../apps/api/src/services/cx/connectors/shopify/spec.js'
import { writeFile } from 'node:fs/promises'
import prisma from '../../../apps/api/src/db.js'
import { shopifyAdmin } from '../../../apps/api/src/services/shopify/admin-client.js'
import { readLinkedStoreSchema, searchLinkedReferences } from '../../../apps/api/src/services/shopify/linked-products-gateway.js'
import { readInformation, readInformationNativeOwners } from '../../../apps/api/src/services/shopify/information-gateway.js'
import { informationRegistry } from '../../../packages/shared/shopify-information.js'
const timer = setTimeout(() => { console.log(JSON.stringify({ status: 'TIMEOUT' })); process.exit(2) }, 55000)
try {
  const accounts = await prisma.channelConnection.findMany({ where: { channelType: 'SHOPIFY', isActive: true }, select: { id: true, displayName: true } })
  for (const account of accounts) {
    try {
      const { graphql } = await shopifyAdmin(account.id)
      const schema = await readLinkedStoreSchema(graphql)
      const found = await searchLinkedReferences(graphql, { type: 'product_reference' })
      const info = await readInformation(graphql, found.items.slice(0, 2).map(p => p.id))
      const nativeOwners = await readInformationNativeOwners(graphql, info.rows.map(row => row.id))
      if (nativeOwners.some(row => row.productId !== info.rows.find(original => original.id === row.id)?.productId)) throw new Error('Scalar read returned mismatched ownership')
      const evidence = { observedAt: new Date().toISOString(), boundary: 'Read-only. No Shopify or database mutations.', status: info.rows.length ? 'READ_VERIFIED' : 'SCHEMA_ONLY_NO_PRODUCTS', store: account.displayName, currency: info.currency, timezone: info.timezone, products: info.rows.filter(r => r.kind === 'PRODUCT').length, variants: info.rows.filter(r => r.kind === 'PRODUCTVARIANT').length, media: info.rows.reduce((n, r) => n + r.media.length, 0), fields: informationRegistry(schema), metaobjectDefinitions: schema.metaobjectDefinitions }
      await writeFile(new URL('./live-read-evidence.json', import.meta.url), JSON.stringify({ ...evidence, nativeOwnerReadVerified: nativeOwners.length }, null, 2) + '\n')
      console.log(JSON.stringify({ ...evidence, fields: evidence.fields.length, metaobjectDefinitions: evidence.metaobjectDefinitions.length }))
    } catch (error) { process.exitCode = 1; console.log(JSON.stringify({ status: 'READ_UNAVAILABLE', store: account.displayName, message: (error as Error).message })) }
  }
  if (!accounts.length) { process.exitCode = 1; console.log(JSON.stringify({ status: 'NO_ACTIVE_SHOPIFY_ACCOUNT' })) }
} finally { clearTimeout(timer); await prisma.$disconnect() }
