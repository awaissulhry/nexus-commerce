'use client'

import { useCallback } from 'react'
import { useT } from '../../../../lib/i18n/provider'
import { VERSIONS_NS, type Say } from './model'

/** A parameter that is itself a key of this step's catalogue (`gateItem.MATERIALS`) is said in words first. */
const KEYED = /^gateItem\.[A-Z_]+$/

/** `say` a phrase of the studio's, this step's or Changes & versions' catalogue (each loaded by the studio). */
export function useSay(): (phrase: Say | null | undefined) => string | null {
  const products = useT('products')
  const versions = useT(VERSIONS_NS)
  const changes = useT('products-changes')
  return useCallback(
    (phrase) => {
      if (!phrase) return null
      const t = phrase.ns === 'products' ? products : phrase.ns === 'changes' ? changes : versions
      const params: Record<string, string | number> = {}
      for (const [name, value] of Object.entries(phrase.params ?? {})) params[name] = typeof value === 'string' && KEYED.test(value) ? versions(value) : value
      return t(phrase.key, params)
    },
    [products, versions, changes],
  )
}
