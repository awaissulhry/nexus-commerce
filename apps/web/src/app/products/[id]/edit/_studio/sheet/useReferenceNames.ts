'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { InformationField } from '@nexus/shared/shopify-information'
import { getBackendUrl } from '@/lib/backend-url'
import { loadEbayPolicies, policyLists } from './ebayPolicies'
import { marketplaceReferenceLabels, mergeReferenceLabels, nameReferenceColumns, type NamedColumn, type ReferenceLabels } from './referenceLabels'
import { isReferenceField, loadReferenceChoices } from './referenceOptions'

type Sheet = { meta?: unknown; family?: { id: string }; columns: Array<NamedColumn & { shopifyField?: InformationField }>; rows: Array<{ productType?: string | null; values: Record<string, { value: unknown }> }>; scope: { kind: string; connectionId?: string | null; locale?: string } }

async function read(path: string, signal: AbortSignal) {
  const response = await fetch(`${getBackendUrl()}/api/${path}`, { credentials: 'include', signal })
  if (!response.ok) throw new Error(`Name lookup failed (HTTP ${response.status})`)
  return response.json()
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** Coverage is accepted only for the sheet's exact coordinate and an unambiguous completed lookup. */
function sheetNames(meta: unknown, channel: string, market: string) {
  const result = { labels: {} as ReferenceLabels, covered: { descriptionThemeId: [] as string[], categoryId: [] as string[] } }
  const names = record(meta) ? meta.referenceNames : undefined
  if (!record(names) || names.channel !== channel || names.market !== market || !Array.isArray(names.lookups)) return result
  for (const field of ['descriptionThemeId', 'categoryId'] as const) {
    const matching = names.lookups.filter(lookup => record(lookup) && lookup.field === field)
    if (matching.length !== 1) continue
    const lookup = matching[0] as Record<string, unknown>
    if (!Array.isArray(lookup.ids) || lookup.ids.length > 1000 || !lookup.ids.every(id => typeof id === 'string' && id.length > 0) ||
        new Set(lookup.ids).size !== lookup.ids.length || !record(lookup.labels)) continue
    const ids = lookup.ids as string[]
    const allowed = new Set(field === 'categoryId' ? ids.map(id => id.toUpperCase()) : ids)
    if (Object.entries(lookup.labels).some(([id, name]) => !allowed.has(id) || typeof name !== 'string' || !name.trim())) continue
    result.covered[field] = ids
    result.labels[field] = lookup.labels as Record<string, string>
  }
  return result
}

/** A completed missing-ID read removes only that old name; a failed read removes nothing. */
function applySheetNames(previous: ReferenceLabels, hydrated: ReturnType<typeof sheetNames>): ReferenceLabels {
  const labels = { ...previous }
  for (const field of ['descriptionThemeId', 'categoryId'] as const) {
    if (!hydrated.labels[field]) continue
    const names = { ...labels[field] }
    for (const id of hydrated.covered[field]) delete names[field === 'categoryId' ? id.toUpperCase() : id]
    labels[field] = { ...names, ...hydrated.labels[field] }
  }
  return labels
}

/** Slow taxonomy/account lookups enrich columns without replacing rows or holding up the sheet. */
export function useReferenceNames<T extends Sheet>(sheet: T | null, channel: string, market: string, accountId?: string): T | null {
  const connectionId = sheet?.scope.connectionId ?? accountId
  const namesKey = JSON.stringify(sheetNames(sheet?.meta, channel, market))
  // Reads replace meta; local row edits retain it. Even identical names from a new read supersede an older catalog.
  const hydrated = useMemo(() => JSON.parse(namesKey) as ReturnType<typeof sheetNames>, [namesKey, sheet?.meta])
  const themeIdsKey = JSON.stringify([...new Set((sheet?.rows ?? []).map(row => row.values.descriptionThemeId?.value)
    .filter(value => value != null && value !== '' && value !== 'none').map(String))].sort())
  const categoryIds = [...new Set((sheet?.rows ?? []).map(row => row.values.categoryId?.value).filter(value => value != null && value !== '').map(String))].sort().join(',')
  const productTypes = [...new Set((sheet?.rows ?? []).map(row => row.productType).filter((value): value is string => !!value))].sort().join(',')
  const browseNodeIds = [...new Set((sheet?.rows ?? []).flatMap(row => ['recommended_browse_nodes', 'browseNodeId'].flatMap(key => {
    const value = row.values[key]?.value
    return (Array.isArray(value) ? value : [value]).filter(item => typeof item === 'string' || typeof item === 'number').map(String).filter(id => /^\d{1,30}$/.test(id))
  })))].sort().join(',')
  const keys = (sheet?.columns ?? []).map(column => column.key).sort().join(',')
  // An empty cell has no catalog name to resolve; its editor still loads available choices.
  const assignedNames = [...Object.keys(policyLists), 'descriptionThemeId'].filter(key => (sheet?.rows ?? []).some(row => {
    const value = row.values[key]?.value
    return value != null && value !== '' && !(key === 'descriptionThemeId' && value === 'none')
  })).sort().join(',')
  const shopifyFields = (sheet?.columns ?? []).filter(column => column.shopifyField?.type.includes('_reference'))
  const shopifyIds = channel === 'SHOPIFY' ? [...new Set(shopifyFields.flatMap(column => (sheet?.rows ?? []).flatMap(row => {
    const raw = row.values[column.key]?.value
    try { return (column.shopifyField!.type.startsWith('list.') && typeof raw === 'string' ? JSON.parse(raw) : [raw]).filter((id: unknown): id is string => typeof id === 'string' && id.startsWith('gid://shopify/')) } catch { return [] }
  })))].sort().join(',') : ''
  const shopifyReferenceKeys = shopifyFields.map(column => column.key).sort().join(',')
  // P2 (I4-4) — everything the lookups read, and nothing else: a read of the same sheet (new objects, same facts) or an
  // edit to a value that is not a reference asks for no name again.
  const coordinate = JSON.stringify([channel, market, connectionId, categoryIds, productTypes, browseNodeIds, keys, assignedNames, shopifyIds, shopifyReferenceKeys, sheet?.family?.id, sheet?.scope.locale])
  const themeCatalog = useRef<{ coordinate: string; ids: Set<string>; hydrated: typeof hydrated } | null>(null)
  const [resolved, setResolved] = useState<{ coordinate: string; labels: ReferenceLabels } | null>(null)
  const [breadcrumbs, setBreadcrumbs] = useState<{ coordinate: string; labels: ReferenceLabels } | null>(null)
  /* 2026-09-24 — pictures for Shopify references (files, video posters, products), from the same lookup as their
     names, so a file cell can show the image itself. Display only; never a value. */
  const [pictures, setPictures] = useState<{ coordinate: string; images: Record<string, string>; swatches: Record<string, string> } | null>(null)

  // Keep successful names if a later optional lookup fails. Fresh sheet names win immediately below.
  useEffect(() => {
    if (!Object.keys(hydrated.labels).length) return
    setResolved(previous => {
      const labels = applySheetNames(previous?.coordinate === coordinate ? previous.labels : {}, hydrated)
      return previous?.coordinate === coordinate && JSON.stringify(previous.labels) === JSON.stringify(labels) ? previous : { coordinate, labels }
    })
  }, [coordinate, hydrated])

  useEffect(() => {
    if (channel !== 'EBAY') return
    const pending = categoryIds.split(',').filter(id => id && !hydrated.covered.categoryId.includes(id))
    if (!pending.length) return
    const abort = new AbortController()
    void Promise.allSettled(pending.map(productType => read(`categories/reference-labels?${new URLSearchParams({ channel, marketplace: market, productType })}`, abort.signal)
      .then(body => { if (!abort.signal.aborted) setResolved(previous => ({ coordinate, labels: mergeReferenceLabels(previous?.coordinate === coordinate ? previous.labels : {}, body.labels ?? {}) })) })))
    return () => abort.abort()
  }, [coordinate, hydrated.covered.categoryId])

  useEffect(() => {
    const ids = JSON.parse(themeIdsKey) as string[]
    const catalog = themeCatalog.current?.coordinate === coordinate ? themeCatalog.current : null
    if (!keys.split(',').includes('descriptionThemeId') || !ids.some(id => !hydrated.covered.descriptionThemeId.includes(id) && !catalog?.ids.has(id))) return
    const abort = new AbortController()
    void loadReferenceChoices('descriptionThemeId', {}, { live: false, refresh: true, reusePending: false }).then(choices => {
      if (!abort.signal.aborted) {
        // Known IDs need no second read. A new ID needs a fresh catalog, whose completed absence also removes old names.
        themeCatalog.current = { coordinate, ids: new Set(Object.keys(choices.labels)), hydrated }
        setResolved(previous => ({ coordinate, labels: { ...(previous?.coordinate === coordinate ? previous.labels : {}), descriptionThemeId: choices.labels } }))
      }
    }).catch(() => {})
    return () => abort.abort()
  }, [coordinate, themeIdsKey, hydrated.covered.descriptionThemeId])

  useEffect(() => {
    if (!keys) return
    const abort = new AbortController()
    const present = new Set(keys.split(','))
    const assigned = new Set(assignedNames.split(','))
    const apply = (labels: ReferenceLabels) => {
      if (!abort.signal.aborted) setResolved(previous => ({ coordinate, labels: mergeReferenceLabels(previous?.coordinate === coordinate ? previous.labels : {}, labels) }))
    }
    const tasks: Promise<unknown>[] = []
    if (channel === 'ETSY' && productTypes) {
      const query = new URLSearchParams({ ids: productTypes, ...(connectionId ? { accountId: connectionId } : {}) })
      tasks.push(read(`categories/etsy-taxonomy?${query}`, abort.signal)
        .then(body => apply({ taxonomy_id: Object.fromEntries((body.items ?? []).map((item: { productType: string; displayName: string }) => [item.productType, item.displayName])) })))
    }
    if (channel === 'SHOPIFY' && shopifyIds && connectionId && sheet?.family?.id) {
      const ids = shopifyIds.split(','), query = new URLSearchParams({ accountId: connectionId, market: 'GLOBAL', ...(sheet.scope.locale ? { locale: sheet.scope.locale } : {}) })
      for (let offset = 0; offset < ids.length; offset += 100) tasks.push(fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(sheet.family.id)}/shopify-linked/reference-names?${query}`, {
        method: 'POST', credentials: 'include', signal: abort.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids.slice(offset, offset + 100) }),
      }).then(async response => { if (!response.ok) throw new Error('Shopify reference names are unavailable'); return response.json() })
        .then((references: Array<{ id: string; label: string; image?: string | null; swatch?: string | null }>) => {
          apply(Object.fromEntries(shopifyFields.map(column => [column.key, Object.fromEntries(references.map(reference => [reference.id, reference.label]))])))
          const found = Object.fromEntries(references.flatMap(reference => typeof reference.image === 'string' && reference.image ? [[reference.id, reference.image]] : []))
          const colours = Object.fromEntries(references.flatMap(reference => typeof reference.swatch === 'string' && reference.swatch ? [[reference.id, reference.swatch]] : []))
          if (!abort.signal.aborted && (Object.keys(found).length || Object.keys(colours).length)) setPictures(previous => {
            const same = previous?.coordinate === coordinate
            return { coordinate, images: { ...(same ? previous.images : {}), ...found }, swatches: { ...(same ? previous.swatches : {}), ...colours } }
          })
        }))
    }
    if (channel === 'EBAY') {
      if (categoryIds) tasks.push(read(`ebay/flat-file/category-breadcrumbs?${new URLSearchParams({ ids: categoryIds, marketplace: market })}`, abort.signal)
        .then(body => { if (!abort.signal.aborted) setBreadcrumbs({ coordinate, labels: { categoryId: Object.fromEntries(Object.entries(body.breadcrumbs ?? {}).flatMap(([id, value]) => {
          const path = value as { en?: string; local?: string }
          // The selected market's taxonomy is authoritative; shared numeric IDs can differ elsewhere.
          const label = path.local ?? (market === 'UK' || market === 'GB' ? path.en : undefined)
          return label ? [[id, label]] : []
        })) } }) }))
      if (Object.keys(policyLists).some(key => present.has(key) && assigned.has(key))) tasks.push(loadEbayPolicies(market, false, connectionId)
        .then(body => apply(Object.fromEntries(Object.entries(policyLists).map(([key, list]) => [key, Object.fromEntries((body[list] ?? []).map(policy => [policy.id, policy.name]))])))))
    }
    if (channel === 'ETSY') for (const field of ['shipping_profile_id', 'shop_section_id', 'return_policy_id', 'readiness_state_id']) {
      if (present.has(field) && isReferenceField(field)) tasks.push(loadReferenceChoices(field, { connectionId, market }, { live: false }).then(choices => apply({ [field]: choices.labels })))
    }
    if (present.has('productType') && channel === 'AMAZON') tasks.push(read(`listing-wizard/product-types?${new URLSearchParams({ channel, marketplace: market })}`, abort.signal)
      .then(body => apply({ productType: Object.fromEntries((body.items ?? []).map((item: { productType: string; displayName: string }) => [item.productType, item.displayName])) })))
    if ((channel === 'AMAZON' || channel === 'MASTER') && productTypes) {
      for (const productType of productTypes.split(',')) {
        const query = new URLSearchParams({ marketplace: market, productType, ...(connectionId ? { accountId: connectionId } : {}) })
        const ids = browseNodeIds ? browseNodeIds.split(',') : []
        for (let offset = 0; offset < Math.max(1, ids.length); offset += 200) {
          const nameQuery = new URLSearchParams(query)
          if (ids.length) nameQuery.set('browseNodeIds', ids.slice(offset, offset + 200).join(','))
          tasks.push(read(`categories/reference-labels?${nameQuery}`, abort.signal).then(body => apply(body.labels ?? {})))
        }
        if (present.has('merchant_shipping_group') || present.has('shippingTemplate')) {
          // 🔴 A PAGE LOAD, not a gesture: cache-only (LX.6 / R-LX-4). Names that are not cached
          // leave the raw template ID visible; the cell editor's own live read fills them in.
          tasks.push(loadReferenceChoices('merchant_shipping_group', { market, productType, connectionId }, { live: false })
            .then(choices => apply({ merchant_shipping_group: choices.labels, shippingTemplate: choices.labels })))
        }
      }
    }
    const marketKeys = [...present].filter(key => /(^|__)(marketplace_id|marketplaceId|marketplace|market)$/.test(key))
    if (marketKeys.length) tasks.push(read('marketplaces', abort.signal).then(body => {
      const names = marketplaceReferenceLabels(body, channel)
      apply(Object.fromEntries(marketKeys.map(key => [key, names])))
    }))
    // Each lookup settles independently. Unavailable names keep the original ID visible.
    void Promise.allSettled(tasks)
    return () => abort.abort()
  }, [coordinate]) // every value the lookups read is in `coordinate`; the sheet's object identity is not

  return useMemo(() => {
    if (!sheet) return null
    const current = pictures?.coordinate === coordinate ? pictures : null
    const names = applySheetNames(resolved?.coordinate === coordinate ? resolved.labels : {}, hydrated)
    // A later complete catalog beats the sheet metadata it followed; the next fresh sheet wins again.
    if (themeCatalog.current?.coordinate === coordinate && themeCatalog.current.hydrated === hydrated && resolved?.coordinate === coordinate) {
      names.descriptionThemeId = resolved.labels.descriptionThemeId
    }
    // A selected-market taxonomy path is authoritative over a stored mapping's cached name.
    const columns = nameReferenceColumns(sheet.columns, mergeReferenceLabels(names, breadcrumbs?.coordinate === coordinate ? breadcrumbs.labels : {}))
    return { ...sheet, columns: current ? columns.map(column => column.shopifyField?.type.includes('_reference') ? { ...column, referenceImages: current.images, referenceSwatches: current.swatches } : column) : columns }
  }, [sheet, resolved, pictures, coordinate, hydrated, breadcrumbs]) as T | null
}
