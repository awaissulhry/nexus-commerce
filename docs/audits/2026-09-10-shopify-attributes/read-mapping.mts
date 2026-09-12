/** Read-only inventory of Shopify definitions and existing Nexus mapping sources. */
import '../../../apps/api/src/env.js'
import '../../../apps/api/src/services/cx/connectors/shopify/spec.js'
import { writeFile } from 'node:fs/promises'
import prisma from '../../../apps/api/src/db.js'
import { withWorkspace, LEGACY_WORKSPACE_ID } from '../../../apps/api/src/lib/workspace-context.js'
import { shopifyAdmin } from '../../../apps/api/src/services/shopify/admin-client.js'
import { readLinkedStoreSchema } from '../../../apps/api/src/services/shopify/linked-products-gateway.js'
import { getMappingForMarketplace } from '../../../apps/api/src/services/pim/schema-mapping.service.js'
import { resolveAttributes } from '../../../apps/api/src/services/pim/attribute-resolver.js'
import { getFieldCatalogue } from '../../../apps/api/src/services/pim/mapping/field-catalogue.service.js'
import { resolveBatch } from '../../../apps/api/src/services/pim/mapping/resolve-batch.service.js'
import { getStudioSheet } from '../../../apps/api/src/services/pim/studio-sheet.service.js'

try {
  await withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    const [accounts, attributes, products, listings, mapping] = await Promise.all([
      prisma.channelConnection.findMany({ where: { channelType: 'SHOPIFY', isActive: true }, select: { id: true, displayName: true } }),
      prisma.customAttribute.findMany({ select: { code: true, label: true, type: true, scope: true, validation: true } }),
      prisma.product.findMany({ where: { deletedAt: null } }),
      prisma.channelListing.findMany({ where: { channel: 'SHOPIFY' }, select: { id: true, productId: true, channelConnectionId: true, externalListingId: true, marketplace: true, platformAttributes: true } }),
      getMappingForMarketplace('SHOPIFY', 'GLOBAL'),
    ])
    const stores = []
    for (const account of accounts) {
      const { graphql, domain } = await shopifyAdmin(account.id)
      const schema = await readLinkedStoreSchema(graphql)
      stores.push({ accountId: account.id, domain, schema })
    }
    const sourceValues: Record<string, { populated: number; samples: unknown[] }> = {}
    for (const product of products) {
      const resolved = resolveAttributes({ product: product as any, parent: products.find(p => p.id === product.parentId) as any, locale: 'it' })
      for (const [key, cell] of Object.entries(resolved)) {
        const value = cell.value
        if (value == null || value === '' || Array.isArray(value) && !value.length) continue
        const item = sourceValues[key] ??= { populated: 0, samples: [] }; item.populated++
        if (item.samples.length < 3 && !item.samples.some(s => JSON.stringify(s) === JSON.stringify(value))) item.samples.push(value)
      }
    }
    if (process.argv.includes('--verify')) {
      const results = []
      for (const store of stores) {
        const catalogue = await getFieldCatalogue({ channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: store.accountId })
        const stats = new Map(catalogue.fields.map(field => [field.fieldKey, { key: field.fieldKey, label: field.label,
          source: field.rule?.source ?? field.sourceOwner?.path ?? null, status: field.status, rule: field.rule,
          populated: 0, empty: 0, invalid: 0, examples: [] as unknown[] }]))
        for (let start = 0; start < products.length; start += 100) {
          const batch = await resolveBatch({ channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: store.accountId,
            productIds: products.slice(start, start + 100).map(p => p.id), locale: 'en', includeCatalogue: false })
          for (const p of batch.products) for (const cell of Object.values(p.cells)) {
            const stat = stats.get(cell.fieldKey); if (!stat) throw new Error('Unexpected field: ' + cell.fieldKey)
            if (cell.value == null || cell.value === '' || Array.isArray(cell.value) && !cell.value.length) stat.empty++; else stat.populated++
            if (cell.errors.length) { stat.invalid++; if (stat.examples.length < 3) stat.examples.push({ productId: p.productId, value: cell.value, errors: cell.errors }) }
          }
        }
        const sheet = await getStudioSheet({ productId: 'cmokmy3a40078pm0p1fvnu523', scope: 'channel', channel: 'SHOPIFY', market: 'GLOBAL', accountId: store.accountId, locale: 'en' })
        results.push({ accountId: store.accountId, domain: store.domain, schemaRevision: store.schema.revision,
          counts: catalogue.counts, fields: [...stats.values()], sheet: { columns: sheet.columns.map(c => ({ key: c.key, label: c.label, editable: c.editable })),
          mapping: sheet.meta.mapping, rows: sheet.rows.map(r => ({ id: r.id, productId: r.productId, values: Object.fromEntries(Object.entries(r.values)
            .filter(([key, cell]) => cell.mapped?.sourcePath || ['status', 'availableQuantity', 'onHandQuantity'].includes(key))
            .map(([key, cell]) => [key, { value: cell.value, writable: cell.writable, mapped: { sourcePath: cell.mapped?.sourcePath, sourceOwner: cell.mapped?.sourceOwner, errors: cell.mapped?.errors } }])) })) } })
      }
      await writeFile(new URL('./mapping-verification.json', import.meta.url), JSON.stringify({ observedAt: new Date().toISOString(), products: products.length, stores: results }, null, 2) + '\n')
      console.log(JSON.stringify(results.map(s => ({ domain: s.domain, counts: s.counts, sheetColumns: s.sheet.columns.length,
        mapping: s.sheet.mapping, invalid: s.fields.filter(f => f.invalid), unmapped: s.fields.filter(f => f.status === 'unmapped') }))))
    }
    const report = { observedAt: new Date().toISOString(), stores, attributes, mapping, productCount: products.length, sourceValues,
      listings: listings.map(l => ({ ...l, platformAttributes: undefined, storedKeys: Object.keys((l.platformAttributes ?? {}) as object) })) }
    await writeFile(new URL('./mapping-inventory.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ stores: stores.map(s => ({ domain: s.domain, definitions: s.schema.definitions.length, locales: s.schema.locales })), attributes: attributes.length, products: products.length, listings: listings.length, mappedFields: Object.keys(mapping.fields) }))
  })
} finally { await prisma.$disconnect() }
