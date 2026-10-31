import { storeHeaders, storeUrl } from '../../../record-panels/store'

/** The shipping screens' file fetches (a presigned GET: through this app's /api when the store is local). */

/** A presigned GET's bytes (the issued DDT's PDF): the file store's address goes through this app's /api when local. */
export async function presignedBytes(download: { url: string; headers: Record<string, string> }): Promise<Uint8Array> {
  const response = await fetch(storeUrl(download.url), { headers: storeHeaders(download), credentials: 'omit', cache: 'no-store' })
  if (!response.ok) throw new Error(`the file store answered ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

export function openPresigned(download: { url: string }) {
  const anchor = document.createElement('a')
  anchor.href = storeUrl(download.url)
  anchor.target = '_blank'
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

