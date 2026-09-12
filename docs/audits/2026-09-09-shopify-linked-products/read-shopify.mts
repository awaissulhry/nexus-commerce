/** Read-only integration verification. No tokens or customer data are printed or saved. */
import '../../../apps/api/src/env.js'
import '../../../apps/api/src/services/cx/connectors/shopify/spec.js'
import prisma from '../../../apps/api/src/db.js'
import { shopifyAdmin } from '../../../apps/api/src/services/shopify/admin-client.js'
import { readLinkedStoreSchema, searchLinkedReferences, readLinkedOwner, readLinkedMetaobject, readLinkedFields, resolveLinkedReferences } from '../../../apps/api/src/services/shopify/linked-products-gateway.js'
const timer = setTimeout(() => { console.log(JSON.stringify({ status: 'TIMEOUT' })); process.exit(2) }, 55000)
try {
  const accounts = await prisma.channelConnection.findMany({ where: { channelType: 'SHOPIFY', isActive: true }, select: { id: true, displayName: true } })
  for (const account of accounts) {
    try {
      const { graphql } = await shopifyAdmin(account.id)
      const schema = await readLinkedStoreSchema(graphql)
      console.log(JSON.stringify({ store: account.displayName, status: 'SCHEMA_VERIFIED', definitions: schema.definitions.length, entryTypes: schema.metaobjectDefinitions.length, locales: schema.locales,
        productReferenceFields: schema.definitions.filter(d => d.type === 'list.product_reference').map(d => ({ name: d.name, namespace: d.namespace, key: d.key, ownerType: d.ownerType })), types: [...new Set(schema.definitions.map(d => d.type))] }))
      const products = await searchLinkedReferences(graphql, { type: 'product_reference' })
      if (products.items[0]) {
        const owner = await readLinkedOwner(graphql, products.items[0].id)
        console.log(JSON.stringify({ status: 'PRODUCT_READ_VERIFIED', fields: owner.fields.length, variants: owner.variants.length, searchPage: products.items.length, moreProducts: !!products.cursor }))
        if (owner.fields.length) {
          const exact = await readLinkedFields(graphql, owner.fields)
          if (exact.some((f, i) => f.value !== owner.fields[i].value || f.compareDigest !== owner.fields[i].compareDigest)) throw new Error('Owner and exact field reads differed during verification')
          console.log(JSON.stringify({ status: 'EXACT_FIELD_VALUES_VERIFIED', fields: exact.length }))
        }
      }
      for (const type of ['file_reference', 'collection_reference', 'page_reference', 'variant_reference']) {
        const page = await searchLinkedReferences(graphql, { type })
        const resolved = page.items.length ? await resolveLinkedReferences(graphql, page.items.slice(0, 2).map(i => i.id)) : []
        console.log(JSON.stringify({ status: 'REFERENCE_SEARCH_VERIFIED', type, items: page.items.length, resolved: resolved.length }))
      }
      const definition = schema.metaobjectDefinitions.find(d => !d.fields.some(f => f.readOnlyReason))
      if (definition) {
        const entries = await searchLinkedReferences(graphql, { type: 'metaobject_reference', metaobjectType: definition.type })
        if (entries.items[0]) { const entry = await readLinkedMetaobject(graphql, entries.items[0].id); console.log(JSON.stringify({ status: 'ENTRY_READ_VERIFIED', fields: entry.fields.length, references: entry.referencedBy.nodes.length })) }
      }
    } catch (error) { process.exitCode = 1; console.log(JSON.stringify({ store: account.displayName, status: 'READ_UNAVAILABLE', message: (error as Error).message })) }
  }
  if (!accounts.length) { process.exitCode = 1; console.log(JSON.stringify({ status: 'NO_ACTIVE_SHOPIFY_ACCOUNT' })) }
} finally { clearTimeout(timer); await prisma.$disconnect() }
