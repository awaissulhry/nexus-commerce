'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { getStyle, type StyleView } from '../../../../products/styles/api'
import { readProblem } from '../../model'
import type { Part } from '../record-model'

/**
 * F-PT-401 (order PRODUCTION tab; 18-lead-settles L6) — the order's styles as "What we make it to" reads them, the container's part
 * (OrderRecord.tsx mounts it; a view never imports it): `GET /product/styles/:id` per distinct style (at most 10, styleIdsOf), only
 * with product.styles.view and only once the section came into view (`enabled`). Each style is read alone: one that fails says so on
 * its own row with its own Try again; the others still draw. Another order: nothing of the last one is kept.
 */
export function useStyleSpecs(api: ApiClient, orderId: string | null, styleIds: readonly string[], enabled: boolean): { readonly parts: ReadonlyMap<string, Part<StyleView>>; readonly again: (styleId: string) => void } {
  const [parts, setParts] = useState<ReadonlyMap<string, Part<StyleView>>>(new Map())
  const turn = useRef(0)
  const key = styleIds.join(',')
  const readOne = useCallback(
    (styleId: string, mine: number) => {
      setParts((known) => new Map(known).set(styleId, known.get(styleId)?.value ? known.get(styleId)! : { value: null, problem: null }))
      getStyle(api, styleId)
        .then((value) => mine === turn.current && setParts((known) => new Map(known).set(styleId, { value, problem: null })))
        .catch((error: unknown) => mine === turn.current && setParts((known) => new Map(known).set(styleId, { value: null, problem: readProblem(error) })))
    },
    [api],
  )
  useEffect(() => {
    turn.current++
    setParts(new Map())
  }, [orderId])
  useEffect(() => {
    if (!enabled || key === '') return
    const mine = ++turn.current
    for (const styleId of key.split(',')) readOne(styleId, mine)
  }, [enabled, key, readOne])
  const again = useCallback((styleId: string) => readOne(styleId, turn.current), [readOne])
  return { parts, again }
}
