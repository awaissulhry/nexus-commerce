'use client'

import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { galleryLooksView } from '@nexus/factory-domain/product/images/contracts'
import type { ApiClient } from '../../../../lib/api/client'
import { useLiveChanges } from '../../../../record-panels/live'
import { lookPages, looksProblem, type LooksState, type StyleLook } from './gallery-model'

const answer = galleryLooksView.extend({ looks: z.array(galleryLooksView.shape.looks.element) })

/**
 * The Gallery view's pictures (B-W2b-236; SCR-303): while the gallery is on, the main picture, count and swatches of each
 * style on screen (`POST /product/pictures/looks`, 60 at a time), read again when the rows change or a style's pictures
 * change (live `style.pictures_changed`). A look is the picture's own address on the API (its bytes never change: the
 * browser keeps them).
 */
export function useGalleryLooks(api: ApiClient, on: boolean, ids: readonly string[]): LooksState {
  const [looks, setLooks] = useState<LooksState>({ status: 'idle' })
  const [tick, setTick] = useState(0)
  const key = ids.join(',')
  const seen = useRef(new Set<string>())
  seen.current = new Set(ids)

  useLiveChanges({ onChange: (change) => (change.type === 'style.pictures_changed' && seen.current.has(String(change.fields['styleId'])) ? setTick((value) => value + 1) : undefined) }, on)

  useEffect(() => {
    if (!on || ids.length === 0) {
      setLooks({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    setLooks((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    Promise.all(lookPages(ids).map((styleIds) => api.post('/product/pictures/looks', { body: { styleIds }, schema: answer, signal: controller.signal })))
      .then((pages) => {
        const byStyle: Record<string, StyleLook> = {}
        for (const page of pages) for (const look of page.looks) byStyle[look.styleId] = look
        setLooks({ status: 'ready', byStyle, at: new Date().toISOString() })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLooks({ status: 'error', problem: looksProblem(error) })
      })
    return () => controller.abort()
  }, [api, on, key, tick])

  return looks
}
