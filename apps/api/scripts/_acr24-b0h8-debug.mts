/** Diagnostic: what api_path + query does the lib actually send? READ-ONLY, one call. */
import '../src/env.js'
const { AmazonService, AMAZON_MARKETPLACE_CODE_TO_ID } = await import('../src/services/marketplaces/amazon.service.js')
const svc = new AmazonService()
const sp = await (svc as unknown as { getClient: () => Promise<unknown> }).getClient() as {
  callAPI: (a: unknown, o?: unknown) => Promise<unknown>
  _request: { api: (t: unknown, p: Record<string, unknown>) => Promise<unknown> }
}
const realApi = sp._request.api.bind(sp._request)
sp._request.api = async (token, req_params) => {
  console.log('API_PATH:', req_params.api_path)
  console.log('METHOD:', req_params.method)
  console.log('QUERY:', JSON.stringify(req_params.query))
  return realApi(token, req_params)
}
try {
  const res = await sp.callAPI({
    operation: 'searchCatalogItems',
    endpoint: 'catalogItems',
    query: {
      marketplaceIds: [AMAZON_MARKETPLACE_CODE_TO_ID.IT],
      identifiers: ['B0H8QTNY62'],
      identifiersType: 'ASIN',
      includedData: ['summaries'],
    },
  }, { version: '2022-04-01' }) as { items?: unknown[] }
  console.log('OK, items:', res.items?.length)
} catch (e) { console.log('ERR:', (e as Error).message.slice(0, 100)) }
process.exit(0)
