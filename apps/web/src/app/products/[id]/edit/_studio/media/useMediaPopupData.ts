'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'

import { apiGet } from '../images/api'
import type { MediaRead } from '../images/plan-page/model'

/**
 * Lane C — the photo plan as the pop-up reads it: ONE `GET /products/:id/media` when it opens (the same read as the
 * Media page), kept as the BASELINE the save is bound to, and quiet re-reads afterwards (an upload, another screen's
 * change) that only refresh what is shown. A save never uses a re-read to decide what it may overwrite.
 */
export type PopupReadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; read: MediaRead }

export function useMediaPopupData(productId: string) {
  const [state, setState] = useState<PopupReadState>({ status: 'loading' })
  const [baseline, setBaseline] = useState<MediaRead | null>(null)
  const saving = useRef(false)
  const alive = useRef(true)

  const load = useCallback(async (quiet: boolean): Promise<MediaRead | null> => {
    const res = await apiGet<MediaRead>(`/api/products/${encodeURIComponent(productId)}/media`)
    if (!alive.current) return null
    if (!res.ok) {
      if (!quiet) setState({ status: 'error', message: res.message })
      return null
    }
    setState({ status: 'ready', read: res.data })
    setBaseline(current => current ?? res.data)
    return res.data
  }, [productId])

  useEffect(() => {
    alive.current = true
    void load(false)
    return () => { alive.current = false }
  }, [load])

  // Another screen, tab or person changed this family's photos: read again, quietly, so the pop-up can say so.
  const readRef = useRef<MediaRead | null>(null)
  readRef.current = state.status === 'ready' ? state.read : null
  useInvalidationChannel(['product-media.changed'], event => {
    const read = readRef.current
    if (!read || saving.current || (event.id && event.id !== read.rootId && event.id !== read.productId)) return
    void load(true)
  })

  return {
    state, baseline,
    latest: state.status === 'ready' ? state.read : null,
    reload: useCallback(() => load(true), [load]),
    /** While a save is on its way, its own echo is not "someone else". */
    setSaving: useCallback((on: boolean) => { saving.current = on }, []),
  }
}
