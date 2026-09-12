/** Read-only production adapters and pinned schema introspection. Never submits mutations. */
import '../../../apps/api/src/env.js'
import '../../../apps/api/src/services/cx/connectors/shopify/spec.js'
import { writeFile } from 'node:fs/promises'
import prisma from '../../../apps/api/src/db.js'
import { shopifyAdmin } from '../../../apps/api/src/services/shopify/admin-client.js'
import { readApplicableShopifyDefinitions, readLinkedStoreSchema, searchLinkedReferences, resolveLinkedReferences } from '../../../apps/api/src/services/shopify/linked-products-gateway.js'
import { readInformation } from '../../../apps/api/src/services/shopify/information-gateway.js'
const timeout = setTimeout(() => process.exit(2), 55000)
try {
  const accounts = await prisma.channelConnection.findMany({ where: { channelType: 'SHOPIFY', isActive: true }, select: { id: true, displayName: true } })
  for (const [index, account] of accounts.entries()) {
    const { graphql } = await shopifyAdmin(account.id)
    const read: typeof graphql = (query, variables) => { if (/\bmutation\b/.test(query)) throw new Error('Read-only verification'); return graphql(query, variables) }
    if (process.argv.includes('--gallery-only')) {
      const contract = await read(`query NexusCommonGalleryContracts {
        operationsType: __type(name:"Mutation") { fields { name } }
        append: __type(name:"ProductVariantAppendMediaInput") { inputFields { name } }
        detach: __type(name:"ProductVariantDetachMediaInput") { inputFields { name } }
        file: __type(name:"FileUpdateInput") { inputFields { name } }
        create: __type(name:"FileCreateInput") { inputFields { name } }
        inventoryPolicy: __type(name:"ProductVariantInventoryPolicy") { enumValues { name description } }
        translation: __type(name:"TranslatableResourceType") { enumValues { name description } }
        mediaErrors: __type(name:"MediaUserErrorCode") { enumValues { name description } }
      }`)
      const operations = ['fileCreate', 'fileUpdate', 'productReorderMedia', 'productVariantAppendMedia', 'productVariantDetachMedia', 'translationsRegister']
      const found = operations.filter(name => contract.operationsType.fields.some((f: any) => f.name === name))
      if (found.length !== operations.length) throw new Error('A common-gallery operation is unavailable in the pinned schema.')
      await writeFile(new URL(`./live-gallery-capabilities-${index + 1}.json`, import.meta.url), JSON.stringify({ observedAt: new Date().toISOString(), apiVersion: '2026-07', boundary: 'Read-only introspection; no mutations.', operations: found, ...contract, operationsType: undefined }, null, 2) + '\n')
      console.log(JSON.stringify({ operations: found, apiVersion: '2026-07' })); continue
    }
    if (process.argv.includes('--applicability-only')) {
      const sample = await read(`query NexusCategoryReadContract { products(first:1,query:"category_id:*") { nodes { category { id } } } }`)
      const category = sample.products.nodes[0]?.category?.id
      if (!category) throw new Error('No categorized product is available for the read-only applicability check.')
      const definitions = [...await readApplicableShopifyDefinitions(read, category)]
      await writeFile(new URL(`./live-applicability-${index + 1}.json`, import.meta.url), JSON.stringify({ observedAt: new Date().toISOString(), apiVersion: '2026-07', boundary: 'Read-only production applicability query; no mutations.', category, definitions }, null, 2) + '\n')
      console.log(JSON.stringify({ category, applicableDefinitions: definitions.length })); continue
    }
    const schema = await readLinkedStoreSchema(read)
    if (process.argv.includes('--schema-only')) {
      await writeFile(new URL(`./live-definition-capabilities-${index + 1}.json`, import.meta.url), JSON.stringify({ observedAt: new Date().toISOString(), apiVersion: '2026-07', boundary: 'Read-only definition/capability verification; no mutations.', store: account.displayName, schema }, null, 2) + '\n')
      console.log(JSON.stringify({ store: account.displayName, definitions: schema.definitions.length, constrained: schema.definitions.filter(d => d.constraints?.key).map(d => ({ key: d.key, subtypes: d.constraints!.values.length })) }))
      continue
    }
    const introspection = await read(`query NexusInformationReadContracts {
      package: __type(name:"ShippingPackage") { name }
      measurement: __type(name:"InventoryItemMeasurement") { fields { name } }
      stockInput: __type(name:"InventoryQuantityInput") { inputFields { name } }
      taxonomy: __type(name:"Taxonomy") { fields { name args { name } } }
      taxonomyCategory: __type(name:"TaxonomyCategory") { fields { name args { name } } }
      taxonomyAttribute: __type(name:"TaxonomyAttribute") { fields { name args { name } } }
      taxonomyChoiceList: __type(name:"TaxonomyChoiceListAttribute") { fields { name args { name } } }
      taxonomyValue: __type(name:"TaxonomyValue") { fields { name args { name } } }
      taxonomyDisclosure: __type(name:"TaxonomyDisclosure") { fields { name args { name } } }
      queryType: __type(name:"QueryRoot") { fields { name } }
    }`)
    const found = await searchLinkedReferences(read, { type: 'product_reference' })
    const info = await readInformation(read, found.items.slice(0, 1).map(p => p.id), schema)
    const translations = found.items.length ? await read(`query NexusReadTranslationCapabilities($ids:[ID!]!) { translatableResourcesByIds(first:100,resourceIds:$ids) { nodes { resourceId translatableContent { key type locale digest } } pageInfo { hasNextPage } } }`, { ids: info.rows.filter(r => r.kind === 'PRODUCT').map(r => r.id) }) : null
    const alternateLocale = schema.locales.find(l => !l.primary)?.locale
    if (alternateLocale) await readInformation(read, found.items.slice(0, 1).map(p => p.id), schema, alternateLocale)
    await searchLinkedReferences(read, { type: 'product_media' })
    const referenceRead = await resolveLinkedReferences(read, found.items.slice(0, 1).map(p => p.id))
    const evidence = { observedAt: new Date().toISOString(), apiVersion: '2026-07', boundary: 'Read only; no Shopify or database writes.', store: account.displayName,
      schema, translations, introspection: { ...introspection, queryType: introspection.queryType?.fields.filter((f: { name: string }) => /package|shipping|taxonomy|jurisdiction|disclosure/i.test(f.name)) },
      referenceRead, rows: info.rows.map(row => ({ owner: row.kind, keys: Object.keys(row.values), populated: Object.entries(row.values).filter(([, v]) => v !== null && v !== undefined).map(([k]) => k) })), currency: info.currency }
    await writeFile(new URL(`./live-capabilities-${index + 1}.json`, import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
    console.log(JSON.stringify({ store: account.displayName, rows: info.rows.length, definitions: schema.definitions.length, inventory: introspection.stockInput, package: introspection.package, translations }))
  }
  if (!accounts.length) console.log('No active Shopify account is available for read-only verification.')
} finally { clearTimeout(timeout); await prisma.$disconnect() }
