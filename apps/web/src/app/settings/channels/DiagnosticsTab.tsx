'use client'

/**
 * CX.2 — Diagnostics tab. Everything here is a LIVE call or a stored ledger row:
 * Run heartbeat (`POST /api/cx/connections/:id/heartbeat`), Refresh token now
 * (`POST …/refresh`), the connection ledger (`GET …/events`), the channel's
 * recent inbound events, and — for eBay — the pre-existing category probe,
 * labelled for what it is (the primary account's token against the IT site).
 */

import { useCallback, useEffect, useState } from 'react'
import { Card, Banner, Listbox, MetricStrip, EmptyState } from '@/design-system/components'
import { Button, Pill, Tag, Skeleton } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { channelName, relativeTime, STATUS_LABEL, type AccountRow } from './channels-data'
import { LedgerGrid, InboundGrid, type LedgerRow, type InboundRow } from './ChannelEventsGrid'

interface HeartbeatResult {
  ok: boolean
  latencyMs: number
  authStatus: string
  scopeDrift: string[]
  message?: string
  errorClass?: string
}

export interface DiagnosticsTabProps {
  accounts: AccountRow[]
  loading: boolean
  onChanged: () => void
}

export function DiagnosticsTab({ accounts, loading, onChanged }: DiagnosticsTabProps) {
  const api = getBackendUrl()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const account = accounts.find((a) => a.id === selectedId) ?? accounts.find((a) => a.isPrimary) ?? accounts[0] ?? null
  // Key everything below on the account's IDENTITY, never on the object. A refetch
  // (which every live check triggers) hands back a new object for the same account;
  // depending on the object re-ran the reset effect and wiped the result the operator
  // had just asked for, ~200 ms after it appeared. Measured on prod 2026-08-29.
  const accountId = account?.id ?? null
  const accountChannel = account?.channel ?? null

  const [heartbeat, setHeartbeat] = useState<{ busy: boolean; result: HeartbeatResult | null; error: string | null }>({ busy: false, result: null, error: null })
  const [refresh, setRefresh] = useState<{ busy: boolean; text: string | null; tone: 'success' | 'danger' | 'warning' }>({ busy: false, text: null, tone: 'success' })
  const [ledger, setLedger] = useState<{ rows: LedgerRow[] | null; error: string | null }>({ rows: null, error: null })
  const [inbound, setInbound] = useState<{ rows: InboundRow[] | null; stats: { success: number; failed: number; pending: number; total: number } | null; error: string | null }>({ rows: null, stats: null, error: null })
  const [probe, setProbe] = useState<{ busy: boolean; ok: boolean | null; recommendation: string | null; details: string | null; error: string | null }>({ busy: false, ok: null, recommendation: null, details: null, error: null })

  const loadLedger = useCallback(async () => {
    if (!accountId) return
    setLedger({ rows: null, error: null })
    try {
      const res = await fetch(`${api}/api/cx/connections/${accountId}/events?take=100`, { credentials: 'include', cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { events: LedgerRow[] }
      setLedger({ rows: data.events ?? [], error: null })
    } catch (err) {
      setLedger({ rows: [], error: err instanceof Error ? err.message : 'Failed to load the ledger' })
    }
  }, [accountId, api])

  const loadInbound = useCallback(async () => {
    if (!accountChannel) return
    setInbound({ rows: null, stats: null, error: null })
    try {
      const res = await fetch(`${api}/api/settings/channels/${accountChannel.toLowerCase()}/detail`, { credentials: 'include', cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { recentEvents: InboundRow[]; eventStats: { success: number; failed: number; pending: number; total: number } }
      setInbound({ rows: data.recentEvents ?? [], stats: data.eventStats ?? null, error: null })
    } catch (err) {
      setInbound({ rows: [], stats: null, error: err instanceof Error ? err.message : 'Failed to load inbound events' })
    }
  }, [accountChannel, api])

  // Results belong to the account they were run against: clear them when the
  // operator picks a DIFFERENT account, and only then.
  useEffect(() => {
    setHeartbeat({ busy: false, result: null, error: null })
    setRefresh({ busy: false, text: null, tone: 'success' })
    setProbe({ busy: false, ok: null, recommendation: null, details: null, error: null })
  }, [accountId])

  useEffect(() => {
    void loadLedger()
    void loadInbound()
  }, [loadLedger, loadInbound])

  async function runHeartbeat() {
    if (!accountId) return
    setHeartbeat({ busy: true, result: null, error: null })
    try {
      const res = await fetch(`${api}/api/cx/connections/${accountId}/heartbeat`, { method: 'POST', credentials: 'include' })
      const data = (await res.json()) as Partial<HeartbeatResult> & { error?: string }
      if (typeof data.ok !== 'boolean') throw new Error(data.error ?? `HTTP ${res.status}`)
      setHeartbeat({ busy: false, result: data as HeartbeatResult, error: null })
      onChanged()
      void loadLedger()
    } catch (err) {
      setHeartbeat({ busy: false, result: null, error: err instanceof Error ? err.message : 'Heartbeat failed' })
    }
  }

  async function refreshNow() {
    if (!accountId) return
    setRefresh({ busy: true, text: null, tone: 'success' })
    try {
      const res = await fetch(`${api}/api/cx/connections/${accountId}/refresh`, { method: 'POST', credentials: 'include' })
      const data = (await res.json()) as { success?: boolean; accessTokenExpiresAt?: string | null; refreshed?: boolean; error?: string; code?: string }
      if (res.status === 409) setRefresh({ busy: false, text: data.error ?? 'Another worker holds the refresh lease — try again in a moment.', tone: 'warning' })
      else if (!res.ok) setRefresh({ busy: false, text: data.error ?? `Refresh failed (HTTP ${res.status})`, tone: 'danger' })
      else
        setRefresh({
          busy: false,
          text: `Refreshed — the access token now expires ${relativeTime(data.accessTokenExpiresAt ?? null)}${data.accessTokenExpiresAt ? ` (${new Date(data.accessTokenExpiresAt).toISOString()})` : ''}.`,
          tone: 'success',
        })
      onChanged()
      void loadLedger()
    } catch (err) {
      setRefresh({ busy: false, text: err instanceof Error ? err.message : 'Refresh failed', tone: 'danger' })
    }
  }

  async function runProbe() {
    setProbe({ busy: true, ok: null, recommendation: null, details: null, error: null })
    try {
      const res = await fetch(`${api}/api/ebay/diagnostics?marketplaceId=EBAY_IT`, { credentials: 'include', cache: 'no-store' })
      // Shape from apps/api/src/routes/ebay.routes.ts (GET /api/ebay/diagnostics).
      const data = (await res.json()) as {
        marketplaceId?: string
        connection?: { present: boolean; isActive: boolean; tokenOk: boolean; error?: string }
        envCredentials?: { appIdSet: boolean; certIdSet: boolean; looksLikePlaceholder: boolean }
        sampleSearch?: { ok: boolean; itemCount?: number; error?: string }
        recommendation?: string
        error?: string
      }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      const c = data.connection
      const e = data.envCredentials
      const s = data.sampleSearch
      const lines = [
        `connection row (most recently updated eBay row): ${c ? (c.present ? `present · ${c.isActive ? 'active' : 'inactive'} · token ${c.tokenOk ? 'ok' : 'failed'}${c.error ? ` — ${c.error}` : ''}` : 'none') : 'not reported'}`,
        `app credentials in env: ${e ? `app id ${e.appIdSet ? 'set' : 'MISSING'} · cert id ${e.certIdSet ? 'set' : 'MISSING'}${e.looksLikePlaceholder ? ' · looks like a placeholder' : ''}` : 'not reported'}`,
        `sample category search (${data.marketplaceId ?? 'EBAY_IT'}): ${s ? (s.ok ? `ok${typeof s.itemCount === 'number' ? ` · ${s.itemCount} items` : ''}` : `failed${s.error ? ` — ${s.error}` : ''}`) : 'not reported'}`,
      ]
      setProbe({ busy: false, ok: !!s?.ok && !!c?.tokenOk, recommendation: data.recommendation ?? null, details: lines.join('\n'), error: null })
    } catch (err) {
      setProbe({ busy: false, ok: false, recommendation: null, details: null, error: err instanceof Error ? err.message : 'Probe failed' })
    }
  }

  if (loading && accounts.length === 0) {
    return (
      <div style={{ display: 'grid', gap: 'var(--nds-space-3)' }}>
        <Skeleton height={44} />
        <Skeleton height={160} />
        <Skeleton height={240} />
      </div>
    )
  }
  if (!account) {
    return <EmptyState title="No connected account to check" description="Connect a channel first — Diagnostics runs live checks against a connected account." />
  }

  const status = STATUS_LABEL[account.authStatus ?? 'unknown'] ?? STATUS_LABEL.unknown

  return (
    <div style={{ display: 'grid', gap: 'var(--nds-space-3)' }}>
      <div className="nds-diag-picker">
        <span id="diag-account-label">Account</span>
        <Listbox
          size="sm"
          ariaLabel="Account to check"
          options={accounts.map((a) => ({ value: a.id, label: `${channelName(a.channel)} · ${a.label}${a.isPrimary ? ' (primary)' : ''}` }))}
          value={account.id}
          onChange={setSelectedId}
          width={360}
        />
        <Pill tone={status.tone} dot size="sm">
          {status.label}
        </Pill>
        {account.region && <Tag>{account.region}</Tag>}
      </div>

      <Card header="Live checks" description="Each button makes a real call against the channel and writes what happened to the ledger.">
        <div className="nds-diag-actions">
          <Button variant="secondary" size="sm" aria-disabled={heartbeat.busy || undefined} onClick={() => !heartbeat.busy && void runHeartbeat()}>
            {heartbeat.busy ? 'Checking…' : 'Run heartbeat'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-disabled={refresh.busy || account.managedBy === 'env' || undefined}
            onClick={() => {
              if (refresh.busy) return
              if (account.managedBy === 'env') {
                setRefresh({ busy: false, text: 'This account’s credentials come from the environment; there is no refresh token to rotate.', tone: 'warning' })
                return
              }
              void refreshNow()
            }}
          >
            {refresh.busy ? 'Refreshing…' : 'Refresh token now'}
          </Button>
        </div>
        {heartbeat.result && (
          <p className="nds-diag-result" role="status">
            <Pill tone={heartbeat.result.ok ? 'success' : 'danger'} dot size="sm">
              {heartbeat.result.ok ? 'OK' : 'Failed'}
            </Pill>{' '}
            {heartbeat.result.latencyMs} ms · status now {STATUS_LABEL[heartbeat.result.authStatus]?.label ?? heartbeat.result.authStatus}
            {heartbeat.result.errorClass ? ` · ${heartbeat.result.errorClass}` : ''}
            {heartbeat.result.message ? ` · ${heartbeat.result.message}` : ''}
            {heartbeat.result.scopeDrift?.length ? ` · ${heartbeat.result.scopeDrift.length} permission(s) not granted` : ''}
          </p>
        )}
        {heartbeat.error && (
          <Banner tone="danger" title="Heartbeat could not run">
            {heartbeat.error}
          </Banner>
        )}
        {refresh.text && (
          <Banner tone={refresh.tone} title={refresh.tone === 'success' ? 'Token refreshed' : 'Refresh'}>
            {refresh.text}
          </Banner>
        )}
      </Card>

      <Card header="Connection ledger" description="Every grant, refresh, heartbeat, status change and revoke — archived, never deleted.">
        {ledger.error && (
          <Banner tone="danger" title="Ledger unavailable">
            {ledger.error}
          </Banner>
        )}
        {ledger.rows === null ? (
          <Skeleton height={160} />
        ) : (
          <LedgerGrid rows={ledger.rows} emptyTitle="No ledger rows yet" emptyDescription="The first heartbeat or refresh writes the first row." />
        )}
      </Card>

      <Card header="Recent inbound events" description={`The last 50 notifications ${channelName(account.channel)} sent us.`}>
        {inbound.stats && (
          <MetricStrip
            metrics={[
              { label: 'OK', value: inbound.stats.success },
              { label: 'Failed', value: inbound.stats.failed },
              { label: 'Pending', value: inbound.stats.pending },
              { label: 'Total', value: inbound.stats.total },
            ]}
          />
        )}
        {inbound.error && (
          <Banner tone="danger" title="Inbound events unavailable">
            {inbound.error}
          </Banner>
        )}
        {inbound.rows === null ? (
          <Skeleton height={160} />
        ) : (
          <InboundGrid rows={inbound.rows} emptyTitle="No inbound events yet" emptyDescription={`${channelName(account.channel)} has not sent a notification we recorded.`} />
        )}
      </Card>

      {account.channel === 'EBAY' && (
        <Card
          header="eBay category probe"
          description="Probes the IT site with the token of the most recently UPDATED eBay row — not the account selected above, and not necessarily the primary. Kept from the previous page and labelled for what it is; CX.3 makes it per-account."
        >
          <div className="nds-diag-actions">
            <Button variant="secondary" size="sm" aria-disabled={probe.busy || undefined} onClick={() => !probe.busy && void runProbe()}>
              {probe.busy ? 'Probing…' : 'Run probe'}
            </Button>
          </div>
          {probe.error && (
            <Banner tone="danger" title="Probe failed">
              {probe.error}
            </Banner>
          )}
          {probe.recommendation !== null && (
            <Banner tone={probe.ok ? 'success' : 'warning'} title={probe.recommendation}>
              <pre className="nds-diag-pre">{probe.details}</pre>
            </Banner>
          )}
        </Card>
      )}
    </div>
  )
}
