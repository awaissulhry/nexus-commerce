'use client'
import { useEffect, useMemo, useState } from 'react'
import type { InformationField } from '@nexus/shared/shopify-information'
import { getBackendUrl } from '@/lib/backend-url'
import { loadEbayPolicies, policyLists } from './ebayPolicies'
import { marketplaceReferenceLabels, mergeReferenceLabels, nameReferenceColumns, type NamedColumn, type ReferenceLabels } from './referenceLabels'
import { isReferenceField, loadReferenceChoices } from './referenceOptions'

type Sheet = { family?: { id: string }; columns: Array<NamedColumn & { shopifyField?: InformationField }>; rows: Array<{ productType?: string | null; values: Record<string, { value: unknown }> }>; scope: { kind: string; connectionId?: string | null; locale?: string } }

async function read(path: string, signal: AbortSignal) {
  const response = await fetch(`${getBackendUrl()}/api/${path}`, { credentials: 'include', signal })
  if (!response.ok) throw new Error(`Name lookup failed (HTTP ${response.status})`)
  return response.json()
}

/** Slow taxonomy/account lookups enrich columns without replacing rows or holding up the sheet. */
export function useReferenceNames<T extends Sheet>(sheet: T | null, channel: string, market: string, accountId?: string): T | null {
  const connectionId = sheet?.scope.connectionId ?? accountId
  const categoryIds = [...new Set((sheet?.rows ?? []).map(row => row.values.categoryId?.value).filter(value => value != null && value !== '').map(String))].sort().join(',')
  const productTypes = [...new Set((sheet?.rows ?? []).map(row => row.productType).filter((value): value is string => !!value))].sort().join(',')
  const browseNodeIds = [...new Set((sheet?.rows ?? []).flatMap(row => ['recommended_browse_nodes', 'browseNodeId'].flatMap(key => {
    const value = row.values[key]?.value
    return (Array.isArray(value) ? value : [value]).filter(item => typeof item === 'string' || typeof item === 'number').map(String).filter(id => /^\d{1,30}$/.test(id))
  })))].sort().join(',')
  const keys = (sheet?.columns ?? []).map(column => column.key).sort().join(',')
  const shopifyFields = (sheet?.columns ?? []).filter(column => column.shopifyField?.type.includes('_reference'))
  const shopifyIds = channel === 'SHOPIFY' ? [...new Set(shopifyFields.flatMap(column => (sheet?.rows ?? []).flatMap(row => {
    const raw = row.values[column.key]?.value
    try { return (column.shopifyField!.type.startsWith('list.') && typeof raw === 'string' ? JSON.parse(raw) : [raw]).filter((id: unknown): id is string => typeof id === 'string' && id.startsWith('gid://shopify/')) } catch { return [] }
  })))].sort().join(',') : ''
  const coordinate = JSON.stringify([channel, market, connectionId, categoryIds, productTypes, browseNodeIds, keys, shopifyIds, sheet?.family?.id, sheet?.scope.locale])
  const [resolved, setResolved] = useState<{ coordinate: string; labels: ReferenceLabels } | null>(null)

  useEffect(() => {
    if (!keys) return
    const abort = new AbortController()
    const present = new Set(keys.split(','))
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
        .then((references: Array<{ id: string; label: string }>) => apply(Object.fromEntries(shopifyFields.map(column => [column.key, Object.fromEntries(references.map(reference => [reference.id, reference.label]))])))))
    }
    if (channel === 'EBAY') {
      for (const productType of categoryIds.split(',').filter(Boolean)) {
        tasks.push(read(`categories/reference-labels?${new URLSearchParams({ channel, marketplace: market, productType })}`, abort.signal).then(body => apply(body.labels ?? {})))
      }
      if (categoryIds) tasks.push(read(`ebay/flat-file/category-breadcrumbs?${new URLSearchParams({ ids: categoryIds, marketplace: market })}`, abort.signal)
        .then(body => apply({ categoryId: Object.fromEntries(Object.entries(body.breadcrumbs ?? {}).flatMap(([id, value]) => {
          const path = value as { en?: string; local?: string }
          // The selected market's taxonomy is authoritative; shared numeric IDs can differ elsewhere.
          const label = path.local ?? (market === 'UK' || market === 'GB' ? path.en : undefined)
          return label ? [[id, label]] : []
        })) })))
      if (Object.keys(policyLists).some(key => present.has(key))) tasks.push(loadEbayPolicies(market, false, connectionId)
        .then(body => apply(Object.fromEntries(Object.entries(policyLists).map(([key, list]) => [key, Object.fromEntries((body[list] ?? []).map(policy => [policy.id, policy.name]))])))))
    }
    if (channel === 'ETSY') for (const field of ['shipping_profile_id', 'shop_section_id', 'return_policy_id', 'readiness_state_id']) {
      if (present.has(field) && isReferenceField(field)) tasks.push(loadReferenceChoices(field, { connectionId, market }).then(choices => apply({ [field]: choices.labels })))
    }
    if (present.has('descriptionThemeId')) tasks.push(loadReferenceChoices('descriptionThemeId')
      .then(choices => apply({ descriptionThemeId: choices.labels })))
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
          tasks.push(loadReferenceChoices('merchant_shipping_group', { market, productType, connectionId })
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
  }, [coordinate, channel, market, connectionId, categoryIds, productTypes, browseNodeIds, keys, shopifyIds, sheet?.family?.id, sheet?.scope.locale, sheet?.columns])

  return useMemo(() => sheet ? { ...sheet, columns: nameReferenceColumns(sheet.columns, resolved?.coordinate === coordinate ? resolved.labels : {}) } : null,
    [sheet, resolved, coordinate]) as T | null
}
