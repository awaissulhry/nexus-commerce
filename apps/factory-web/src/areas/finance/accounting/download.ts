'use client'

import { storeUrl } from '../../../record-panels/store'
import type { Presigned } from '../../../record-panels/api'

/**
 * A file of a batch, downloaded from its 60-second presigned link (the bytes never pass through the API's JSON routes):
 * an anchor with the file's name, clicked once. A store the browser cannot reach is refused before a byte leaves
 * (`storeUrl`).
 */
export async function downloadStored(link: () => Promise<Presigned>, name: string): Promise<void> {
  const presigned = await link()
  const anchor = document.createElement('a')
  anchor.href = storeUrl(presigned.url)
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}
