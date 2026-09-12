/** Read-only verification of a completed source-definition/mapping plan. */
import { readFile, writeFile } from 'node:fs/promises'
import prisma from '../src/db.js'
import { getFieldCatalogue } from '../src/services/pim/mapping/field-catalogue.service.js'
import { exprDependenciesDeep } from '../src/services/pim/mapping/expr.js'
import { mappingToken } from '../src/services/pim/mapping/revision-token.js'
import { resolveBatch } from '../src/services/pim/mapping/resolve-batch.service.js'
import { previewPayload } from '../src/services/pim/payload-preview.js'
import { isPresent } from '../src/services/pim/resolve-channel-field.js'
import { categoryForListing, resolveCategoriesForProducts } from '../src/services/pim/mapping/category-mapping.service.js'

const [planPath = '/tmp/nexus-complete-channel-mapping.json', output = '/tmp/nexus-complete-channel-mapping-verification.json'] = process.argv.slice(2)
try {
  const plan = JSON.parse(await readFile(planPath, 'utf8'))
  const attributes = await prisma.customAttribute.findMany({ select: { code: true, type: true, validation: true } })
  const products = await prisma.product.findMany({ where: { deletedAt: null }, select: { id: true, sku: true, categoryAttributes: true, variantAttributes: true } })
  const observed = new Set(products.flatMap(p => [...Object.keys(p.categoryAttributes ?? {}), ...Object.keys(p.variantAttributes ?? {})]))
  const scopes: any[] = [], failures: string[] = []
  for (const scope of plan.scopes) {
    const catalogue = await getFieldCatalogue({ channel: scope.channel, marketplace: scope.market, productType: scope.category })
    // Preserved operator rules can read a real legacy bag key before it has a dictionary
    // definition. Verify that the key exists in stored data, and report it explicitly.
    const declared = new Set(catalogue.masterSourceKeys)
    const known = new Set([...declared, ...observed])
    const isKnown = (path: string) => known.has(path.replace(/^(categoryAttributes|variantAttributes)\./, ''))
    const fields = catalogue.fields.map(f => {
      const dependencies = [f.rule?.source, f.rule?.fallback, ...(f.rule?.transforms ?? []).flatMap(t => t.type === 'expr'
        ? exprDependenciesDeep(t.expr ?? `rule(${JSON.stringify(t.ref)})`, catalogue.expressions)?.attributes ?? [] : [])].filter(Boolean) as string[]
      const unknown = dependencies.filter(path => !isKnown(path))
      if (unknown.length) failures.push(`${scope.channel}/${scope.market}/${scope.category}/${f.fieldKey}: unknown ${unknown.join(', ')}`)
      if (f.schemaKnown === false) failures.push(`${scope.channel}/${scope.market}/${scope.category}/${f.fieldKey}: obsolete field`)
      return { field: f.fieldKey, shape: f.shape, status: f.status, source: f.rule?.source ?? null, transforms: f.rule?.transforms ?? [], owner: f.sourceOwner ?? null, unknown,
        legacySources: dependencies.filter(path => !declared.has(path.replace(/^(categoryAttributes|variantAttributes)\./, '')) && isKnown(path)) }
    })
    if (catalogue.counts.unmapped) failures.push(`${scope.channel}/${scope.market}/${scope.category}: ${catalogue.counts.unmapped} unmapped`)
    if (catalogue.counts.mapped + catalogue.counts.owned + catalogue.counts.unmapped !== catalogue.counts.total) failures.push('Inconsistent catalogue totals')
    scopes.push({ channel: scope.channel, market: scope.market, category: scope.category, schema: catalogue.schema, version: catalogue.mappingVersion, counts: catalogue.counts, fields })
    console.log(JSON.stringify({ channel: scope.channel, market: scope.market, category: scope.category, counts: catalogue.counts }))
  }
  const samples = await prisma.product.findMany({ where: { deletedAt: null, sku: { in: ['GALE-JACKET-YELLOW-MEN-XXS', 'AIRMESH-JACKET-BLACK-MEN-XL'] } }, select: { id: true, sku: true } })
  const parity: any[] = []
  for (const channel of ['AMAZON', 'EBAY']) {
    const resolved = await resolveBatch({ channel, marketplace: 'IT', productIds: samples.map(p => p.id) })
    for (const product of resolved.products) {
      const preview = await previewPayload({ channel, marketplace: 'IT', productId: product.productId })
      const expected = Object.fromEntries(Object.entries(product.cells).filter(([key, cell]) => key !== 'productType' && isPresent(cell.value)).map(([key, cell]) => [key, cell.value]))
      // Payload preview may include classification; every populated resolver cell must agree.
      const differing = Object.keys(expected).filter(key => mappingToken(expected[key]) !== mappingToken(preview.payload[key] ?? null))
      if (differing.length) failures.push(`${channel}/${product.sku}: preview differs for ${differing.join(', ')}`)
      parity.push({ channel, sku: product.sku, category: product.category, counts: product.counts, differing,
        examples: Object.fromEntries(Object.entries(product.cells).filter(([key]) => ['color', 'size', 'material', 'fabric_type'].includes(key)).map(([key, cell]) => [key, { value: cell.value, source: cell.rule?.source, provenance: cell.provenance, errors: cell.errors }])) })
    }
  }
  const markets = await prisma.channelListing.groupBy({ by: ['channel', 'marketplace'], where: { channel: { in: ['AMAZON', 'EBAY'] }, product: { deletedAt: null } }, _count: true })
  const listingCoverage: any[] = []
  for (const market of markets) {
    const rows: any[] = []
    for (let offset = 0; offset < products.length; offset += 100) {
      const ids = products.slice(offset, offset + 100).map(p => p.id)
      const categories = await resolveCategoriesForProducts({ productIds: ids, channel: market.channel, marketplace: market.marketplace })
      const listings = await prisma.channelListing.findMany({ where: { productId: { in: ids }, channel: market.channel, marketplace: market.marketplace },
        select: { id: true, productId: true, platformAttributes: true, channelConnectionId: true, aliasKey: true, listingStatus: true } })
      for (const listing of listings) {
        const category = categoryForListing(categories[listing.productId], market.channel, listing.platformAttributes)
        const covered = scopes.some(s => s.channel === market.channel && s.market === market.marketplace && s.category === category.channelCategoryId)
        rows.push({ sku: products.find(p => p.id === listing.productId)?.sku, listingId: listing.id, status: listing.listingStatus,
          account: listing.channelConnectionId, alias: listing.aliasKey, category: category.channelCategoryId, covered, conflicts: category.conflicts })
      }
    }
    const categories: Record<string, number> = {}
    for (const row of rows) categories[row.category ?? 'UNCLASSIFIED'] = (categories[row.category ?? 'UNCLASSIFIED'] ?? 0) + 1
    listingCoverage.push({ channel: market.channel, market: market.marketplace, total: rows.length,
      covered: rows.filter(r => r.covered).length, categories, uncovered: rows.filter(r => !r.covered) })
  }
  const report = { verifiedAt: new Date().toISOString(), productCount: products.length, definitionCount: attributes.length, definitions: attributes, scopes, parity,
    listingCoverage, unverifiedMarkets: plan.unverifiedMarkets, failures }
  await writeFile(output, JSON.stringify(report, null, 2))
  if (failures.length) throw new Error(failures.join('\n'))
  console.log(JSON.stringify({ verified: scopes.length, definitionCount: attributes.length, output, failures: 0 }))
} catch (error) { console.error(error); process.exitCode = 1 }
finally { await prisma.$disconnect(); process.exit(process.exitCode ?? 0) }
