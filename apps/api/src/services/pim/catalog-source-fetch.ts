import { TRANSFER_MAX_FILE_BYTES } from './catalog-transfer-file.js'
import { publicAddress, safeFetch } from '../net/safe-fetch.js'

/** The public-address check, now shared in services/net/safe-fetch.ts; kept under this name for its callers. */
export const publicSourceAddress = publicAddress

/** Pin the validated DNS answer, limit time/bytes and refuse redirects to other destinations. */
export async function fetchCatalogSource(sourceUrl: string) {
  const { buffer } = await safeFetch(sourceUrl, { maxBytes: TRANSFER_MAX_FILE_BYTES, timeoutMs: 30_000, maxRedirects: 0 })
  const url = new URL(sourceUrl)
  return { buffer, filename: decodeURIComponent(url.pathname.split('/').pop() || 'source.csv') }
}
