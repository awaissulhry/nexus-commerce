'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProductMediaQuery, ProductMediaWorkspace } from '@nexus/shared/product-media'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'

import { adoptAfterUpload, VIDEO_FILE } from './galleryPopupModel'
import type { Upload } from './popupParts'

/**
 * Lane C, C2 — the older gallery as the pop-up reads and writes it, through TODAY's routes and bodies
 * (`GET / PUT /products/:id/product-media`, uploads to `/images` or `/videos`). The first read is the BASELINE the save is
 * bound to (its revision); a re-read after an upload moves the baseline only when nothing but the library changed.
 */

export function productMediaUrl(productId: string, context: ProductMediaQuery) {
  return `${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/product-media?${new URLSearchParams(Object.entries(context).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))}`
}

async function answer(res: Response) {
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error === 'NEAR_DUPLICATE' ? 'A similar file already exists. Choose it from the library.' : typeof data?.error === 'string' ? data.error : `The request failed (${res.status}).`)
  return data
}

export type GalleryReadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' }

export function useGalleryPopupData(productId: string, context: ProductMediaQuery, familyId: string | null) {
  const url = productMediaUrl(productId, context)
  const [state, setState] = useState<GalleryReadState>({ status: 'loading' })
  const [baseline, setBaseline] = useState<ProductMediaWorkspace | null>(null)
  const [latest, setLatest] = useState<ProductMediaWorkspace | null>(null)
  const alive = useRef(true)
  // Reads can answer out of order (a live event's read can overtake the first one): only the newest one started is shown.
  const newest = useRef(0)

  const read = useCallback(async (): Promise<ProductMediaWorkspace | null> => {
    const mine = ++newest.current
    try {
      const value = await answer(await fetch(url, { credentials: 'include', cache: 'no-store' })) as ProductMediaWorkspace
      // The first read that works is the baseline — also when it is the "Try again" after a failed first read.
      if (alive.current && mine === newest.current) { setLatest(value); setBaseline(current => current ?? value); setState({ status: 'ready' }) }
      return value
    } catch (error) {
      if (alive.current && mine === newest.current) setState(current => current.status === 'ready' ? current : { status: 'error', message: error instanceof Error ? error.message : 'Media could not be loaded.' })
      return null
    }
  }, [url])

  useEffect(() => {
    alive.current = true
    void read()
    return () => { alive.current = false }
  }, [read])

  // Someone else saved this family's photos (the live event, Owner D2): read again quietly — the pop-up then says the list
  // changed (its revision moved) and Enter would be refused; its own save's echo is not "someone else".
  // One read for a burst of events (a paste across many rows sends one per row), like the sheet's own column.
  const saving = useRef(false)
  const soon = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(soon.current), [])
  useInvalidationChannel(['product-media.changed'], event => {
    if (saving.current || !event.id || (event.id !== familyId && event.id !== productId)) return
    window.clearTimeout(soon.current)
    soon.current = window.setTimeout(() => { void read() }, 400)
  })

  /** Today's save. Answers the saved list, or throws with the server's own sentence. */
  const save = useCallback(async (body: { expectedRevision: string; collection: ProductMediaWorkspace['collection'] | null }) =>
    answer(await fetch(url, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) })) as Promise<ProductMediaWorkspace>, [url])

  /** After an upload: read again; the baseline moves only when nothing but the library changed. */
  const afterUpload = useCallback(async (added: string[]) => {
    const fresh = await read()
    if (fresh) setBaseline(current => current ? adoptAfterUpload(current, fresh, added) : fresh)
    return fresh
  }, [read])

  return { state, baseline, latest, reload: read, save, afterUpload, setSaving: useCallback((on: boolean) => { saving.current = on }, []) }
}

/** The upload routes' codes, as sentences (the routes' other answers are sentences already). */
const UPLOAD_CODES: Record<string, string> = {
  UNSUPPORTED_VIDEO: 'This video type is not supported. Use MP4, MOV or WebM.',
  VIDEO_TOO_LARGE: 'Videos must be no larger than 200 MB.',
  NO_FILE: 'The file did not arrive. Try again.',
  PRODUCT_NOT_FOUND: 'This product is unavailable. Reload the page.',
}

/** One file to the product's library through today's routes: images to `/images` (with its duplicate check), videos to
 *  `/videos`. Answers the same shape as the photo plan's upload, so the pop-up shows the same lines. */
export async function uploadGalleryFile(productId: string, file: File, force = false): Promise<{ kind: 'new' | 'exact'; assetId: string } | { kind: 'similar'; candidate: NonNullable<Upload['candidate']> } | { kind: 'failed'; message: string }> {
  const video = VIDEO_FILE.test(file.name)
  const body = new FormData()
  body.append('file', file)
  try {
    const res = await fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/${video ? 'videos' : 'images'}${force && !video ? '?force=true' : ''}`, { method: 'POST', credentials: 'include', body })
    const data = await res.json().catch(() => null) as Record<string, unknown> | null
    if (res.status === 409 && data?.error === 'NEAR_DUPLICATE' && data.candidate && typeof data.candidate === 'object') {
      const c = data.candidate as { id: string; url: string; alt?: string | null }
      return { kind: 'similar', candidate: { id: c.id, label: c.alt?.trim() || decodeURIComponent(c.url.split('/').pop()?.split('?')[0] ?? 'the file') } }
    }
    if (!res.ok) {
      const code = typeof data?.error === 'string' ? data.error : ''
      return { kind: 'failed', message: typeof data?.message === 'string' ? data.message : UPLOAD_CODES[code] ?? (code || `The upload failed (${res.status}).`) }
    }
    if (typeof data?.id !== 'string') return { kind: 'failed', message: 'The upload result could not be confirmed. Reload the page.' }
    return { kind: data.reused === 'exact' ? 'exact' : 'new', assetId: data.id }
  } catch (error) {
    return { kind: 'failed', message: `The server could not be reached — the file was not sent. (${error instanceof Error ? error.message : String(error)})` }
  }
}
