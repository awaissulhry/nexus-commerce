const query = () => new URLSearchParams(location.search)
export const useStudioProduct = () => ({ id: 'demo', sku: 'GALE-JACKET', name: 'Gale motorcycle jacket' })
export const useStudioSave = () => query().get('scenario') === 'saving' ? { kind: 'saving', pending: 1 } : { kind: 'saved', at: 123 }
export const useStudioDiscoveryFailure = () => query().get('scenario') === 'discovery'
export const useStudioScope = () => ({ scope: query().get('master') === '1' ? 'master' : 'AMAZON', market: 'IT', accountId: 'italy', listingId: 'listing-summer', tab: 'sheet', canChangeEditor: () => true,
  marketplaces: [{ id: 'amazon-it', channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', language: 'it', accounts: [{ id: 'italy', label: 'Nexus Italy', primary: true }] }, { id: 'shopify', channel: 'SHOPIFY', code: 'GLOBAL', name: 'Shopify', language: 'it', accounts: [{ id: 'shop', label: 'Nexus Shop', primary: true }] }] })
