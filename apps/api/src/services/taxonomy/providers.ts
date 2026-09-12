import { gunzipSync } from 'node:zlib'
import { flattenAmazonTypes, flattenEbayTree, flattenEtsyTree, flattenShopifyTree, type TaxonomyDownload } from './model.js'

export interface TaxonomyProvider {
  label: string
  kind: 'categories' | 'productTypes'
  scope: 'market' | 'global'
  requirements: 'category' | 'store'
  download: (marketplace: string) => Promise<TaxonomyDownload>
}

/** Adding an integration requires a provider adapter; navigation is driven by configured markets. */
export const taxonomyProviders: Readonly<Record<string, TaxonomyProvider>> = {
  AMAZON: {
    label: 'Amazon', kind: 'productTypes', scope: 'market', requirements: 'category',
    async download(marketplace) {
      const { getAmazonSpClient } = await import('../../lib/amazon-sp-client.js')
      const { amazonTaxonomyScope } = await import('./amazon.js')
      const scope = await amazonTaxonomyScope(marketplace)
      return flattenAmazonTypes(await (await getAmazonSpClient(scope.accountId)).callAPI({ operation: 'searchDefinitionsProductTypes', endpoint: 'productTypeDefinitions', version: '2020-09-01', query: { marketplaceIds: [scope.marketplaceId] } }))
    },
  },
  EBAY: {
    label: 'eBay', kind: 'categories', scope: 'market', requirements: 'category',
    async download(marketplace) {
      const { EbayCategoryService } = await import('../ebay-category.service.js')
      return flattenEbayTree(await new EbayCategoryService().downloadTaxonomyTree(marketplace))
    },
  },
  ETSY: {
    label: 'Etsy', kind: 'categories', scope: 'global', requirements: 'category',
    async download() {
      const { resolveConnection } = await import('../connection-resolver.service.js')
      const { etsyReader } = await import('../etsy/read-client.js')
      const account = await resolveConnection({ channel: 'ETSY', primary: true })
      const { get } = await etsyReader(account.id)
      return flattenEtsyTree(await get('/seller-taxonomy/nodes'))
    },
  },
  SHOPIFY: {
    label: 'Shopify', kind: 'categories', scope: 'global', requirements: 'store',
    async download() {
      // Stable published release, independent of store-specific metafield definitions.
      const response = await fetch('https://github.com/Shopify/product-taxonomy/releases/latest/download/categories.en.json.gz', { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error(`Shopify taxonomy download failed (${response.status}).`)
      const compressed = Buffer.from(await response.arrayBuffer())
      if (compressed.length > 50_000_000) throw new Error('Shopify taxonomy download exceeds the supported size.')
      return flattenShopifyTree(JSON.parse(gunzipSync(compressed, { maxOutputLength: 250_000_000 }).toString('utf8')))
    },
  },
}

export function taxonomyMarket(channel: string, marketplace: string) {
  return taxonomyProviders[channel]?.scope === 'global' ? 'GLOBAL' : marketplace.replace(/^EBAY_/i, '').toUpperCase().replace(/^GB$/, 'UK')
}
