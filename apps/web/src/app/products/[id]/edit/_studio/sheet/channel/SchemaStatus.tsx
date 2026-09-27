'use client'

import { useState } from 'react'
import { Button } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'
import { getBackendUrl } from '@/lib/backend-url'
import { commandConflictMessage, sendCommand, useCommandKey } from '@/lib/command-key'
import { channelLabel } from '../../scopes'
import { missingRuleSentence } from './rulesStatus'

/** How one market's Amazon rules differ from most markets' (`SheetSpecCoverage.marketDifference`). */
export interface MarketDifference {
  category: string
  comparedWith: string[]
  onlyHere: Array<{ key: string; label: string }>
  missingHere: Array<{ key: string; label: string }>
}

interface DownloadResult { productType: string; outcome: 'added' | 'already' | 'failed'; error?: string }

export function SchemaStatus({ channel, market, accountId, categories, missing, downloadable = [], differences = [], ages, open, onClose, onRefreshed }: {
  channel: string; market: string; categories: string[]; missing: string[]
  /** Missing rule sets the download action can fetch (`rulesStatus().downloadable`). */
  downloadable?: string[]
  differences?: MarketDifference[]
  accountId?: string | null
  open: boolean; onClose: () => void
  ages: Array<{ productType: string; fetchedAt: string }>; onRefreshed: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const downloadKey = useCommandKey()
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
  // 2026-09-27 — downloads only the MISSING rule sets this business uses (`POST /categories/schema/download`); the
  // server refuses a category that is not in use. One key per press, so a double-click cannot run it twice.
  const download = async () => {
    setBusy(true); setError(null)
    try {
      const { response, body, conflict } = await sendCommand<{ results?: DownloadResult[]; remaining?: number; error?: string }>(downloadKey,
        `${getBackendUrl()}/api/categories/schema/download`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, market, productTypes: downloadable }) })
      if (conflict) setError(commandConflictMessage(conflict, 'download'))
      else if (!response.ok) setError(body?.error ?? 'The rules could not be downloaded.')
      else {
        const failed = (body?.results ?? []).filter(r => r.outcome === 'failed')
        if (failed.length) { setError(failed.map(r => `${r.productType}: ${r.error ?? 'download failed'}`).join('; ')); onRefreshed() }
        else { onClose(); onRefreshed() }
      }
    } catch {
      setError('No answer from the server. The download may still be running: wait a moment, then choose Download rules again.')
    }
    setBusy(false)
  }
  const canDownload = !store && downloadable.length > 0
  return <>
    <Modal open={open} onClose={() => { if (!busy) onClose() }} title={`${channelLabel(channel)} · ${market} requirements`} size="md" footer={<>
      <Button variant="secondary" disabled={busy} onClick={() => onClose()}>Close</Button>
      {canDownload && <Button variant="primary" disabled={busy} onClick={() => void download()}>{busy ? 'Downloading…' : 'Download rules'}</Button>}
      {!store && !canDownload && <Button variant="primary" disabled={busy || !categories.length} onClick={() => void refresh()}>{busy ? 'Refreshing…' : 'Refresh requirements'}</Button>}
    </>}>
      {store ? <>
        <p>The information sheet checks the product fields shown for this {channel === 'SHOPIFY' ? 'store' : 'shop'}. Changes save to Nexus for the selected account.</p>
        <p>{channel === 'SHOPIFY' ? 'Review category requirements and any store-specific metafields before publishing.' : 'Review category-specific attributes, shipping and shop policies before publishing.'} Saving product information does not confirm that the channel has accepted or published it.</p>
      </> : <>
        <p>Requirements depend on the listing category and marketplace. Refresh them after changing categories and before publishing.</p>
        {channel === 'ETSY' && <p>Etsy category attributes use the same sheet and mapping controls as other channels. Saving changes here updates Nexus; it does not send or publish an Etsy listing.</p>}
        {!categories.length && <p>Select a listing category to load its requirements.</p>}
      </>}
      {missing.length > 0 && <p role="status">{missing.map(key => missingRuleSentence(channel, market, key)).join(' ')}</p>}
      {!store && <ul>{categories.map(category => <li key={category}>{category} · {ages.find(age => age.productType.replace(/^(EBAY|ETSY):/, '') === category)?.fetchedAt.slice(0, 10) ?? 'Not loaded'}</li>)}</ul>}
      {differences.filter(d => d.onlyHere.length || d.missingHere.length).map(d => (
        <p key={d.category}>
          {`${d.category}: Amazon asks for different fields in ${market}. Compared with ${d.comparedWith.join(', ')}`}
          {d.onlyHere.length > 0 && `, it adds ${d.onlyHere.map(f => f.label).join(', ')}`}
          {d.missingHere.length > 0 && `${d.onlyHere.length ? ' and' : ','} it does not have ${d.missingHere.map(f => f.label).join(', ')}`}
          {'. This is Amazon’s own rule for this market.'}
        </p>
      ))}
      {error && <p role="alert">{error}</p>}
    </Modal>
  </>
}
