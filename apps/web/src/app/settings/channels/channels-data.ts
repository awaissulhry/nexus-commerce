'use client'

/**
 * CX.2 — the two reads every tab shares: the accounts (`/api/accounts`, one row
 * per connected account with CX.1's authStatus/scopes/drift/timestamps) and the
 * connector catalogue (`/api/cx/channels`, one entry per channel the API knows,
 * available or not). Both are honest server facts; nothing here derives state.
 */

import { useCallback, useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import type { AccountRow } from '@/design-system/components/AccountSwitcher'

export type { AccountRow }

export interface CatalogueChannel {
  key: string
  channelType: string
  displayName: string
  available: boolean
  authMode: string
  requiredScopes: string[]
  reviewGatedScopes: string[]
  regions: { key: string; label: string }[]
  defaultRegion: string | null
  refreshTokenLifetimeSec: number | null
  rotatesRefreshToken: boolean
  webhooks: unknown
  sandbox: unknown
  connectException: string | null
  apiVersion: string | null
}

export interface AdsConnection {
  id: string
  profileId: string
  marketplace: string
  region: string
  accountLabel: string | null
  mode: string
  isActive: boolean
  lastVerifiedAt: string | null
  lastErrorAt: string | null
  lastError: string | null
  tokenExpiresAt: string | null
  daysToTokenExpiry: number | null
  tokenExpiryStatus: 'unknown' | 'expired' | 'critical' | 'warning' | 'ok'
}

interface Loadable<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

function useJson<T>(path: string, reloadSignal: unknown, pick: (raw: unknown) => T): Loadable<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}${path}`, { credentials: 'include', cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(pick(await res.json()))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])
  useEffect(() => {
    void reload()
  }, [reload, reloadSignal])
  return { data, loading, error, reload }
}

export function useAccounts(reloadSignal: unknown) {
  return useJson('/api/accounts', reloadSignal, (raw) => {
    const r = raw as { accounts?: AccountRow[]; notConnected?: string[]; canSwitch?: boolean }
    return { accounts: r.accounts ?? [], notConnected: r.notConnected ?? [] }
  })
}

export function useCatalogue(reloadSignal: unknown = 0) {
  return useJson('/api/cx/channels', reloadSignal, (raw) => (raw as { channels?: CatalogueChannel[] }).channels ?? [])
}

export function useAdsConnections(reloadSignal: unknown) {
  return useJson('/api/advertising/connections', reloadSignal, (raw) => {
    const r = raw as { items?: AdsConnection[]; adsMode?: string }
    return { items: r.items ?? [], adsMode: r.adsMode ?? 'sandbox' }
  })
}

/** The one place channel display names live on this page (the catalogue carries them for its own keys). */
export function channelName(channelType: string): string {
  switch (channelType) {
    case 'AMAZON':
      return 'Amazon'
    case 'EBAY':
      return 'eBay'
    case 'SHOPIFY':
      return 'Shopify'
    case 'ETSY':
      return 'Etsy'
    case 'AMAZON_ADS':
      return 'Amazon Ads'
    default:
      return channelType
  }
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 'unknown'
  const diff = now - t
  const abs = Math.abs(diff)
  const future = diff < 0
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'}`
  let text: string
  if (abs < 45_000) text = 'just now'
  else if (abs < 3_600_000) text = unit(Math.round(abs / 60_000), 'min')
  else if (abs < 86_400_000) text = unit(Math.round(abs / 3_600_000), 'hour')
  else text = unit(Math.round(abs / 86_400_000), 'day')
  if (text === 'just now') return text
  return future ? `in ${text}` : `${text} ago`
}

export const STATUS_LABEL: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  connected: { label: 'Connected', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'warning' },
  needs_reauth: { label: 'Sign-in needed', tone: 'danger' },
  revoked: { label: 'Access revoked', tone: 'danger' },
  disconnected: { label: 'Disconnected', tone: 'neutral' },
  unknown: { label: 'Not yet checked', tone: 'info' },
}
