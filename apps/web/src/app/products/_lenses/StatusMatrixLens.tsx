'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'
import type { ProductRow } from '../_types'
import {
  CHANNEL_GROUPS,
  CONTENT_LOCALES,
  type ChannelGroup,
  type ContentLocale,
  type MatrixFlatRow,
} from './_matrix/types'
import { MatrixToolbar } from './_matrix/MatrixToolbar'
import { MatrixTable } from './_matrix/MatrixTable'

const LS_LOCALE = 'products.matrix.contentLocale'
const LS_EXPANDED_CHANNELS = 'products.matrix.expandedChannels'

function readStoredLocale(uiLocale: string): ContentLocale {
  if (typeof window === 'undefined') return uiLocale as ContentLocale
  const v = window.localStorage.getItem(LS_LOCALE)
  return v && CONTENT_LOCALES.includes(v as ContentLocale) ? (v as ContentLocale) : (uiLocale as ContentLocale)
}

function readStoredExpandedChannels(): Set<ChannelGroup> {
  if (typeof window === 'undefined') return new Set()
  try {
    const v = window.localStorage.getItem(LS_EXPANDED_CHANNELS)
    if (!v) return new Set()
    const parsed = JSON.parse(v) as string[]
    return new Set(parsed.filter((c): c is ChannelGroup => CHANNEL_GROUPS.includes(c as ChannelGroup)))
  } catch {
    return new Set()
  }
}

interface Props {
  products: ProductRow[]
  loading: boolean
}

export function StatusMatrixLens({ products, loading }: Props) {
  const { locale: uiLocale } = useTranslations()

  // Content locale — independent of UI locale.
  const [contentLocale, setContentLocaleState] = useState<ContentLocale>('en')
  useEffect(() => {
    setContentLocaleState(readStoredLocale(uiLocale))
  }, [uiLocale])

  const handleLocaleChange = useCallback((locale: ContentLocale) => {
    setContentLocaleState(locale)
    window.localStorage.setItem(LS_LOCALE, locale)
  }, [])

  // Expanded channel groups (hybrid: collapsed = rolled-up single col).
  const [expandedChannelGroups, setExpandedChannelGroups] = useState<Set<ChannelGroup>>(
    new Set(),
  )
  useEffect(() => {
    setExpandedChannelGroups(readStoredExpandedChannels())
  }, [])

  const handleToggleChannelGroup = useCallback((ch: ChannelGroup) => {
    setExpandedChannelGroups((prev) => {
      const next = new Set(prev)
      if (next.has(ch)) next.delete(ch)
      else next.add(ch)
      window.localStorage.setItem(LS_EXPANDED_CHANNELS, JSON.stringify([...next]))
      return next
    })
  }, [])

  const handleExpandAll = useCallback(() => {
    const next = new Set<ChannelGroup>(CHANNEL_GROUPS)
    setExpandedChannelGroups(next)
    window.localStorage.setItem(LS_EXPANDED_CHANNELS, JSON.stringify([...next]))
  }, [])

  const handleCollapseAll = useCallback(() => {
    setExpandedChannelGroups(new Set())
    window.localStorage.setItem(LS_EXPANDED_CHANNELS, JSON.stringify([]))
  }, [])

  // Lazy-loaded children keyed by parentId. Fetched with marketplace-
  // coverage params so child rows get their own traffic-light data.
  const [childrenByParent, setChildrenByParent] = useState<Record<string, ProductRow[]>>({})
  const [loadingChildren, setLoadingChildren] = useState<Set<string>>(new Set())
  // Stable ref so fetchChildrenFor doesn't recreate on every children change.
  const childrenRef = useRef(childrenByParent)
  childrenRef.current = childrenByParent

  const fetchChildrenFor = useCallback(async (parentId: string) => {
    if (childrenRef.current[parentId]) return
    setLoadingChildren((prev) => new Set(prev).add(parentId))
    try {
      const qs = new URLSearchParams({
        parentId,
        limit: '200',
        includeCoverage: 'true',
        includeTags: 'true',
        includeMarketplaceCoverage: 'true',
        includeTranslations: 'true',
      })
      const res = await fetch(`${getBackendUrl()}/api/products?${qs.toString()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status}`)
      const data = await res.json()
      setChildrenByParent((prev) => ({ ...prev, [parentId]: data.products ?? [] }))
    } catch {
      setChildrenByParent((prev) => ({ ...prev, [parentId]: [] }))
    } finally {
      setLoadingChildren((prev) => {
        const next = new Set(prev)
        next.delete(parentId)
        return next
      })
    }
  }, [])

  // Expanded parent rows (variant expand/collapse).
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const handleToggleParent = useCallback((id: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
        void fetchChildrenFor(id)
      }
      return next
    })
  }, [fetchChildrenFor])

  // Evict child caches when the top-level products list refreshes so
  // the next expand re-fetches against possibly-changed children.
  const productsRef = useRef(products)
  useEffect(() => {
    if (productsRef.current !== products) {
      productsRef.current = products
      setChildrenByParent({})
      setExpandedParents(new Set())
    }
  }, [products])

  // Build flat row list: top-level rows, with lazy-loaded children
  // appended beneath expanded parents.
  const flatRows = useMemo<MatrixFlatRow[]>(() => {
    const rows: MatrixFlatRow[] = []
    for (const product of products) {
      if (product.parentId !== null) continue
      rows.push({ kind: 'parent', product, depth: 0 })
      if (expandedParents.has(product.id)) {
        const children = childrenByParent[product.id]
        if (children) {
          for (const child of children) {
            rows.push({ kind: 'child', product: child, depth: 1 })
          }
        }
      }
    }
    return rows
  }, [products, expandedParents, childrenByParent])

  return (
    <div className="flex flex-col h-full border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <MatrixToolbar
        contentLocale={contentLocale}
        onLocaleChange={handleLocaleChange}
        expandedChannelGroups={expandedChannelGroups}
        onExpandAll={handleExpandAll}
        onCollapseAll={handleCollapseAll}
      />

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-sm text-slate-400 dark:text-slate-500">
          Loading…
        </div>
      ) : products.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-slate-400 dark:text-slate-500">
          No products
        </div>
      ) : (
        <MatrixTable
          flatRows={flatRows}
          contentLocale={contentLocale}
          expandedChannelGroups={expandedChannelGroups}
          onToggleChannelGroup={handleToggleChannelGroup}
          expandedParents={expandedParents}
          onToggleParent={handleToggleParent}
          loadingChildren={loadingChildren}
        />
      )}
    </div>
  )
}
