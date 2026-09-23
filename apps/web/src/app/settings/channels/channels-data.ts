'use client'

/**
 * CX.2 — the two reads every tab shares: the accounts (`/api/accounts`, one row
 * per connected account with CX.1's authStatus/scopes/drift/timestamps) and the
 * connector catalogue (`/api/cx/channels`, one entry per channel the API knows,
 * available or not). Both are honest server facts; nothing here derives state.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { WORKSPACES_ENABLED } from '@/lib/workspaces/paths'
import { getBackendUrl } from '@/lib/backend-url'
import type { AccountRow } from '@/design-system/components/AccountSwitcher'
import { accountDisplayName, channelDisplayName } from '@/design-system/lib'

export type { AccountRow }

export interface CatalogueChannel {
  key: string
  channelType: string
  displayName: string
  available: boolean
  authMode: string
  connectMode: 'website_oauth' | 'self_authorization'
  permissionModel: 'oauth_scopes' | 'application_roles'
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
  // P4.5g — 'no_expiry' is a distinct answer from 'unknown': Amazon's 365-day rule
  // applies only to grants given on or after 2026-07-30, and ours predates it.
  tokenExpiryStatus: 'unknown' | 'expired' | 'critical' | 'warning' | 'ok' | 'no_expiry'
  tokenExpiryProvenance?: 'channel' | 'derived' | 'none' | 'unknown'
  tokenExpiryNote?: string
}

interface Loadable<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

function useJson<T>(path: string, reloadSignal: unknown, pick: (raw: unknown) => T, workspaceId?: string | null): Loadable<T> {
  const scoped = WORKSPACES_ENABLED && workspaceId !== undefined
  const key = JSON.stringify([path, scoped ? workspaceId : 'legacy'])
  const [state, setState] = useState<{ key: string; data: T | null; loading: boolean; error: string | null } | null>(null)
  const request = useRef<{ sequence: number; controller?: AbortController }>({ sequence: 0 })
  const reload = useCallback(async () => {
    const sequence = ++request.current.sequence
    request.current.controller?.abort()
    if (scoped && !workspaceId) { setState({ key, data: null, loading: false, error: null }); return }
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000)
    request.current.controller = controller
    setState({ key, data: null, loading: true, error: null })
    try {
      const headers: Record<string, string> = scoped && workspaceId ? { 'x-nexus-workspace-id': workspaceId } : {}
      const res = await fetch(`${getBackendUrl()}${path}`, { credentials: 'include', cache: 'no-store', headers, signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = pick(await res.json())
      if (request.current.sequence === sequence) setState({ key, data, loading: false, error: null })
    } catch (err) {
      if (request.current.sequence === sequence) setState({ key, data: null, loading: false,
        error: err instanceof Error && err.name !== 'AbortError' ? err.message : 'The request timed out. Refresh to try again.' })
    } finally { clearTimeout(timeout) }
  }, [path, key, pick, scoped, workspaceId])
  useEffect(() => {
    void reload()
    return () => { request.current.sequence++; request.current.controller?.abort() }
  }, [reload, reloadSignal])
  const current = state?.key === key ? state : null
  return { data: current?.data ?? null, loading: current?.loading ?? true, error: current?.error ?? null, reload }
}

const pickAccounts = (raw: unknown) => {
  const r = raw as { accounts?: AccountRow[]; notConnected?: string[] }
  if (!r || !Array.isArray(r.accounts) || !r.accounts.every(row => row && typeof row.id === 'string' && typeof row.channel === 'string' && typeof row.managedBy === 'string')) {
    throw new Error('The account list could not be verified.')
  }
  return { accounts: r.accounts.map(account => ({ ...account, label: accountDisplayName(account) })), notConnected: r.notConnected ?? [] }
}
const pickCatalogue = (raw: unknown) => (raw as { channels?: CatalogueChannel[] }).channels ?? []
const pickAds = (raw: unknown) => {
  const r = raw as { items?: AdsConnection[]; adsMode?: string }
  if (!r || !Array.isArray(r.items)) throw new Error('The advertising accounts could not be verified.')
  return { items: r.items, adsMode: r.adsMode ?? 'sandbox' }
}

export function useAccounts(reloadSignal: unknown, includeDisconnected = false, workspaceId: string | null = null) {
  return useJson(`/api/accounts${includeDisconnected ? '?includeDisconnected=1' : ''}`, reloadSignal, pickAccounts, workspaceId)
}

export function useCatalogue(reloadSignal: unknown = 0) {
  return useJson('/api/cx/channels', reloadSignal, pickCatalogue)
}

export function useAdsConnections(reloadSignal: unknown, workspaceId: string | null = null) {
  return useJson('/api/advertising/connections', reloadSignal, pickAds, workspaceId)
}

/** The one place channel display names live on this page (the catalogue carries them for its own keys). */
export function channelName(channelType: string): string {
  return channelDisplayName(channelType)
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
