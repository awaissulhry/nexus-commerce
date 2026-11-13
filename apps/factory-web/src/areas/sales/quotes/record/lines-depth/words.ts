'use client'

import { useCallback } from 'react'
import { useT } from '../../../../../lib/i18n/provider'
import { DEPTH_NS, type Words } from './model'

/** The depth catalogue's translator and `say` for a Words (the `sales` catalogue when it names it). */
export function useDepthWords() {
  const t = useT(DEPTH_NS)
  const sales = useT('sales')
  const say = useCallback((words: Words | null | undefined): string => (words ? (words.ns === 'sales' ? sales(words.key, words.params) : t(words.key, words.params)) : ''), [t, sales])
  return { t, sales, say }
}
