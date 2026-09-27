import { getBackendUrl } from '@/lib/backend-url'

import type { UploadStatus } from './uploadModel'

/**
 * Images rebuild P4b — one file to the family's library through the existing upload route, whose duplicate check stays
 * the gate: 201 = a new photo; 200 `reused: 'exact'` = the same bytes are already in the library (that photo is used);
 * 409 `NEAR_DUPLICATE` = it looks like a library photo (the dialog offers "use it" or "upload anyway" = `force`).
 * One file at a time, on purpose: two parallel uploads of the same bytes could both pass the check.
 */
export async function uploadPhoto(productId: string, file: File, force = false): Promise<UploadStatus> {
  const body = new FormData()
  body.append('file', file)
  try {
    // The file's own name labels the photo in the library ("size-chart-de"), not the storage address.
    const alt = file.name.replace(/\.[a-z0-9]{2,5}$/i, '')
    const res = await fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/images?type=ALT&alt=${encodeURIComponent(alt)}${force ? '&force=true' : ''}`, { method: 'POST', body, credentials: 'include' })
    const data = await res.json().catch(() => null) as Record<string, unknown> | null
    if (res.status === 409 && data?.error === 'NEAR_DUPLICATE' && data.candidate && typeof data.candidate === 'object') {
      const c = data.candidate as { id: string; url: string; alt?: string | null }
      return { kind: 'similar', candidate: { id: c.id, url: c.url, label: c.alt?.trim() || decodeURIComponent(c.url.split('/').pop()?.split('?')[0] ?? 'Photo') } }
    }
    if (!res.ok) return { kind: 'failed', message: typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : `The upload failed (${res.status}).` }
    if (typeof data?.id !== 'string') return { kind: 'failed', message: 'The upload was accepted, but its answer could not be read. Reload the page.' }
    return data.reused === 'exact' ? { kind: 'exact', assetId: data.id } : { kind: 'new', assetId: data.id }
  } catch (error) {
    return { kind: 'failed', message: `The server could not be reached — the file was not sent. (${error instanceof Error ? error.message : String(error)})` }
  }
}
