'use client'

/**
 * PES.7 — the hook PES.4's drawer calls for a record's images (audit 4.12).
 *
 * The fetch lives HERE rather than inside `GalleryStrip`, which is what PES.4 asked for and is
 * right: two components fetching the same gallery eventually show two different galleries. The
 * strip stays a leaf that renders what it is handed.
 *
 * One request when the record has images of its own; a second only when it has none and a parent
 * exists — so the common case on a parent record costs exactly one call, and the inheritance
 * lookup is paid for only by the records that need it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { apiGet, routes } from '../api'
import { resolveRecordImages, type ProductImageRow, type RecordImages } from './recordImages'

export type RecordImagesState =
  | { status: 'loading' }
  | { status: 'ready'; data: RecordImages }
  /** The server's own words. The drawer shows this rather than an empty strip, which would read as
   *  "this record has no images" — a different and much more alarming statement. */
  | { status: 'error'; message: string }

export function useRecordImages(args: {
  /** The record being read — a parent product or a child SKU. */
  productId: string | null
  /** The record's parent, when it has one. Inheritance is only looked up if this is given. */
  parentId?: string | null
  parentLabel?: string | null
}): { state: RecordImagesState; reload: () => Promise<void> } {
  const { productId, parentId = null, parentLabel = null } = args
  const [state, setState] = useState<RecordImagesState>({ status: 'loading' })

  const load = useCallback(async () => {
    if (!productId) { setState({ status: 'ready', data: { images: [], inheritedFrom: null } }); return }
    setState({ status: 'loading' })

    const own = await apiGet<ProductImageRow[]>(routes.masterImages(productId))
    if (!own.ok) { setState({ status: 'error', message: own.message }); return }
    const ownRows = Array.isArray(own.data) ? own.data : []

    if (ownRows.length > 0 || !parentId) {
      setState({ status: 'ready', data: resolveRecordImages({ ownRows }) })
      return
    }

    // No images of its own: look up what it inherits rather than reporting none.
    const parent = await apiGet<ProductImageRow[]>(routes.masterImages(parentId))
    if (!parent.ok) {
      // The parent lookup failing must not be reported as "no images" — that is the false alarm
      // this whole module exists to avoid.
      setState({ status: 'error', message: `Could not read the parent's images — ${parent.message}` })
      return
    }
    setState({
      status: 'ready',
      data: resolveRecordImages({
        ownRows,
        parentRows: Array.isArray(parent.data) ? parent.data : [],
        parentLabel,
      }),
    })
  }, [parentId, parentLabel, productId])

  useEffect(() => { void load() }, [load])

  // Memoised: a fresh object here breaks any consumer that correctly lists it as a
  // dependency — the memo never caches, and reads as though it does (PES ruling #156).
  return useMemo(() => ({ state, reload: load }), [state, load])
}
