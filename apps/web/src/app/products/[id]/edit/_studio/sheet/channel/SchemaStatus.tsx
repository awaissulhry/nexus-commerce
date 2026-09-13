'use client'

import { useState } from 'react'
import { Button } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'
import { getBackendUrl } from '@/lib/backend-url'
import { channelLabel } from '../../scopes'

export function SchemaStatus({ channel, market, accountId, categories, missing, ages, open, onClose, onRefreshed }: {
  channel: string; market: string; categories: string[]; missing: string[]
  accountId?: string | null
  open: boolean; onClose: () => void
  ages: Array<{ productType: string; fetchedAt: string }>; onRefreshed: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const store = channel === 'SHOPIFY'
  const refresh = async () => {
    setBusy(true); setError(null)
    const results = await Promise.allSettled(categories.map(async productType => {
      const params = new URLSearchParams({ channel, marketplace: market, productType, force: '1', lite: '1' })
      if (accountId) params.set('accountId', accountId)
      const response = await fetch(`${getBackendUrl()}/api/categories/schema?${params}`, { credentials: 'include' })
      if (!response.ok) { const body = await response.json(); throw new Error(`${productType}: ${body.error ?? 'Requirements could not be refreshed'}`) }
    }))
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (errors.length) setError(errors.map(r => String(r.reason.message ?? r.reason)).join('; '))
    else { onClose(); onRefreshed() }
    setBusy(false)
  }
  return <>
    <Modal open={open} onClose={() => { if (!busy) onClose() }} title={`${channelLabel(channel)} · ${market} requirements`} size="md" footer={<>
      <Button variant="secondary" disabled={busy} onClick={() => onClose()}>Close</Button>
      {!store && <Button variant="primary" disabled={busy || !categories.length} onClick={() => void refresh()}>{busy ? 'Refreshing…' : 'Refresh requirements'}</Button>}
    </>}>
      {store ? <>
        <p>The information sheet checks the product fields shown for this {channel === 'SHOPIFY' ? 'store' : 'shop'}. Changes save to Nexus for the selected account.</p>
        <p>{channel === 'SHOPIFY' ? 'Review category requirements and any store-specific metafields before publishing.' : 'Review category-specific attributes, shipping and shop policies before publishing.'} Saving product information does not confirm that the channel has accepted or published it.</p>
      </> : <>
        <p>Requirements depend on the listing category and marketplace. Refresh them after changing categories and before publishing.</p>
        {channel === 'ETSY' && <p>Etsy category attributes use the same sheet and mapping controls as other channels. Saving changes here updates Nexus; it does not send or publish an Etsy listing.</p>}
        {!categories.length && <p>Select a listing category to load its requirements.</p>}
      </>}
      {missing.length > 0 && <p role="status">Incomplete: {missing.map(key => key === 'ETSY:*' ? 'Etsy category not selected' : key.replace(/^ETSY:/, 'Etsy category ')).join(', ')}. Readiness cannot be confirmed until these requirements are available.</p>}
      {!store && <ul>{categories.map(category => <li key={category}>{category} · {ages.find(age => age.productType.replace(/^(EBAY|ETSY):/, '') === category)?.fetchedAt.slice(0, 10) ?? 'Not loaded'}</li>)}</ul>}
      {error && <p role="alert">{error}</p>}
    </Modal>
  </>
}
