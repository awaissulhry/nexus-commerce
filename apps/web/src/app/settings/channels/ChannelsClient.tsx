'use client'

import { useState, useEffect } from 'react'
import { ShoppingBag, Plug, AlertCircle, CheckCircle2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

interface ChannelConnection {
  id: string
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'
  isActive: boolean
  // 'oauth'   = real OAuth grant in ChannelConnection table (eBay today, more later)
  // 'env'     = synthesised from env vars (Amazon today, deprecated by P2-2 LWA OAuth)
  // 'pending' = adapter not yet shipped (Shopify/Woo/Etsy)
  isManagedBy: 'oauth' | 'env' | 'pending'
  sellerName: string | null
  storeName: string | null
  storeFrontUrl: string | null
  tokenExpiresAt: string | null
  lastSyncAt: string | null
  lastSyncStatus: string | null
  lastSyncError: string | null
}

interface ChannelDef {
  type: 'EBAY' | 'AMAZON' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'
  name: string
  description: string
}

/**
 * Honest time formatter — relative for short deltas (eBay tokens
 * expire in 2h, "next year" was misleading) and absolute for longer
 * ones. Returns a tuple so callers can colour stale/expired states.
 */
function formatRelative(iso: string): { text: string; tone: 'ok' | 'warn' | 'danger' } {
  const target = new Date(iso).getTime()
  const now = Date.now()
  const deltaMs = target - now // positive = future, negative = past
  const absMs = Math.abs(deltaMs)
  const absMin = Math.floor(absMs / 60000)
  const absHr = Math.floor(absMs / 3_600_000)
  const absDay = Math.floor(absMs / 86_400_000)

  // Far future / past — show absolute date+time
  if (absDay >= 1) {
    const formatted = new Date(iso).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    })
    return { text: formatted, tone: deltaMs >= 0 ? 'ok' : 'warn' }
  }

  // Within 24h — relative phrasing with hours and minutes
  let text: string
  if (deltaMs >= 0) {
    if (absMin < 1) text = 'in <1m'
    else if (absHr < 1) text = `in ${absMin}m`
    else text = `in ${absHr}h ${absMin % 60}m`
  } else {
    if (absMin < 1) text = 'just now'
    else if (absHr < 1) text = `${absMin}m ago`
    else text = `${absHr}h ${absMin % 60}m ago`
  }

  // Token-expiry semantics: <5m = danger (client should refresh),
  // <30m = warn, otherwise ok. Past = danger.
  let tone: 'ok' | 'warn' | 'danger'
  if (deltaMs < 0) tone = 'danger'
  else if (absMin < 5) tone = 'danger'
  else if (absMin < 30) tone = 'warn'
  else tone = 'ok'
  return { text, tone }
}

const TONE_CLASS: Record<'ok' | 'warn' | 'danger', string> = {
  ok: 'text-slate-900',
  warn: 'text-amber-700',
  danger: 'text-red-700',
}

const CHANNELS: ChannelDef[] = [
  { type: 'AMAZON', name: 'Amazon', description: 'Connect your Amazon seller account' },
  { type: 'EBAY', name: 'eBay', description: 'Connect your eBay seller account' },
  { type: 'SHOPIFY', name: 'Shopify', description: 'Connect your Shopify store' },
  { type: 'WOOCOMMERCE', name: 'WooCommerce', description: 'Connect your WooCommerce store' },
  { type: 'ETSY', name: 'Etsy', description: 'Connect your Etsy shop' },
]

export function ChannelsClient() {
  const [connections, setConnections] = useState<Map<string, ChannelConnection>>(
    new Map()
  )
  const [loading, setLoading] = useState(true)
  const [statusMsg, setStatusMsg] = useState<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null)
  const [connectingChannel, setConnectingChannel] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  // HH — diagnostics state for the eBay card. We keep it local rather
  // than threading through to status banner so the result sits next
  // to the Connection it describes (some workspaces have multiple
  // channels and the global statusMsg would be ambiguous).
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagnostics, setDiagnostics] = useState<{
    ok: boolean
    recommendation: string
    details: string
  } | null>(null)

  useEffect(() => {
    loadConnections()
  }, [])

  async function loadConnections() {
    try {
      setLoading(true)
      setStatusMsg(null)
      // The unified /api/connections endpoint returns one row per
      // supported channel — eBay from the OAuth-backed table, Amazon
      // synthesised from env vars, Shopify/Woo/Etsy as 'pending'
      // placeholders. Server already deduplicates active-vs-inactive
      // and most-recent so we just key the Map on `channel`.
      const res = await fetch(
        `${getBackendUrl()}/api/connections`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        throw new Error(`Failed to load connections (HTTP ${res.status})`)
      }
      const data = (await res.json()) as {
        success: boolean
        connections?: ChannelConnection[]
      }
      const list = data.connections ?? []
      const newConnections = new Map<string, ChannelConnection>()
      for (const conn of list) {
        newConnections.set(conn.channel, conn)
      }
      setConnections(newConnections)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load connections'
      setStatusMsg({ kind: 'error', text: message })
    } finally {
      setLoading(false)
    }
  }

  async function handleConnectEbay() {
    try {
      setConnectingChannel('EBAY')
      setStatusMsg(null)

      const response = await fetch(`${getBackendUrl()}/api/ebay/auth/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirectUri: `${window.location.origin}/settings/channels/ebay-callback`,
        }),
      })

      if (!response.ok) {
        throw new Error('Failed to initiate eBay connection')
      }

      const data = await response.json()

      if (!data.success || !data.authUrl) {
        throw new Error(data.error || 'Failed to generate authorization URL')
      }

      sessionStorage.setItem('ebayAuthState', data.state)
      window.location.href = data.authUrl
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed'
      setStatusMsg({ kind: 'error', text: message })
      setConnectingChannel(null)
    }
  }

  async function handleRevokeConnection(connectionId: string) {
    if (!confirm('Are you sure you want to disconnect this channel?')) return

    try {
      const response = await fetch(`${getBackendUrl()}/api/ebay/auth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId }),
      })

      if (!response.ok) {
        throw new Error('Failed to revoke connection')
      }

      // Refetch from the server rather than mutating local state.
      // Original code did `newConnections.delete(connectionId)` but
      // the Map is keyed by channelType ('EBAY'), not connectionId,
      // so the delete was a no-op and the UI kept rendering the old
      // active state. Refetch matches server state exactly and picks
      // up isActive=false on the now-revoked row.
      await loadConnections()
      setStatusMsg({ kind: 'success', text: 'Connection revoked.' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Revocation failed'
      setStatusMsg({ kind: 'error', text: message })
    }
  }

  async function handleDiagnoseEbay() {
    setDiagnosing(true)
    setDiagnostics(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/ebay/diagnostics?marketplaceId=EBAY_IT`,
        { cache: 'no-store' },
      )
      const json = (await res.json()) as {
        success?: boolean
        recommendation?: string
        connection?: { tokenOk?: boolean; tokenError?: string }
        envCredentials?: { looksLikePlaceholder?: boolean }
        sampleSearch?: { ok?: boolean; itemCount?: number; error?: string }
      }
      const ok = !!json?.sampleSearch?.ok
      const detailParts: string[] = []
      detailParts.push(
        `Connection token: ${json?.connection?.tokenOk ? 'OK' : json?.connection?.tokenError ?? 'unavailable'}`,
      )
      detailParts.push(
        `Env credentials: ${
          json?.envCredentials?.looksLikePlaceholder
            ? 'placeholder/missing'
            : 'set'
        }`,
      )
      detailParts.push(
        `Sample category search: ${
          ok
            ? `OK (${json?.sampleSearch?.itemCount ?? 0} matches)`
            : json?.sampleSearch?.error ?? 'failed'
        }`,
      )
      setDiagnostics({
        ok,
        recommendation: json?.recommendation ?? 'No recommendation returned.',
        details: detailParts.join('\n'),
      })
    } catch (err) {
      setDiagnostics({
        ok: false,
        recommendation: 'Diagnostics endpoint unreachable.',
        details: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDiagnosing(false)
    }
  }

  async function handleTestConnection(connectionId: string) {
    try {
      setTestingId(connectionId)
      const response = await fetch(
        `${getBackendUrl()}/api/ebay/auth/test?connectionId=${connectionId}`,
      )

      if (!response.ok) {
        throw new Error('Connection test failed')
      }

      const data = await response.json()
      setStatusMsg({
        kind: 'success',
        text: `Connection OK. Seller: ${data.seller?.signInName ?? '(unknown)'}`,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Test failed'
      setStatusMsg({ kind: 'error', text: `Connection test failed: ${message}` })
    } finally {
      setTestingId(null)
    }
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="bg-white border border-slate-200 rounded-lg p-4 animate-pulse"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-slate-200 rounded" />
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-slate-200 rounded w-1/2" />
                <div className="h-2 bg-slate-200 rounded w-3/4" />
              </div>
            </div>
            <div className="h-8 bg-slate-200 rounded" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {statusMsg && (
        <div
          className={cn(
            'border rounded-lg px-4 py-3 text-base flex items-start gap-2',
            statusMsg.kind === 'success' && 'bg-green-50 border-green-200 text-green-700',
            statusMsg.kind === 'error' && 'bg-red-50 border-red-200 text-red-700',
            statusMsg.kind === 'info' && 'bg-slate-50 border-slate-200 text-slate-700'
          )}
        >
          {statusMsg.kind === 'error' && (
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          )}
          <span>{statusMsg.text}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {CHANNELS.map((channel) => {
          const connection = connections.get(channel.type)
          const isConnected = !!connection?.isActive
          const isConnecting = connectingChannel === channel.type

          return (
            <Card key={channel.type}>
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 bg-slate-100 rounded-md flex items-center justify-center flex-shrink-0">
                    <ShoppingBag className="w-4 h-4 text-slate-600" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-lg font-semibold text-slate-900">
                      {channel.name}
                    </h3>
                    <p className="text-sm text-slate-500 mt-0.5">
                      {channel.description}
                    </p>
                  </div>
                </div>
                {isConnected && connection?.isManagedBy === 'env' ? (
                  <Badge variant="info" size="md">
                    Env-managed
                  </Badge>
                ) : isConnected ? (
                  <Badge variant="success" size="md">
                    Connected
                  </Badge>
                ) : connection?.isManagedBy === 'pending' ? (
                  <Badge variant="default" size="md">
                    Coming soon
                  </Badge>
                ) : connection?.isManagedBy === 'env' ? (
                  <Badge variant="danger" size="md">
                    Misconfigured
                  </Badge>
                ) : (
                  <Badge variant="default" size="md">
                    Not connected
                  </Badge>
                )}
              </div>

              {isConnected && connection && (
                <div className="space-y-1.5 mb-3 text-base border-t border-slate-100 pt-3">
                  {connection.sellerName && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Seller</span>
                      <span className="text-slate-900 truncate">{connection.sellerName}</span>
                    </div>
                  )}
                  {connection.storeName && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Store</span>
                      <span className="text-slate-900 truncate">{connection.storeName}</span>
                    </div>
                  )}
                  {connection.tokenExpiresAt && (() => {
                    const r = formatRelative(connection.tokenExpiresAt)
                    return (
                      <div className="flex justify-between gap-2">
                        <span className="text-slate-500">Token expires</span>
                        <span className={cn('tabular-nums', TONE_CLASS[r.tone])}>
                          {r.text}
                        </span>
                      </div>
                    )
                  })()}
                  {connection.lastSyncAt && (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Last sync</span>
                      <span className="text-slate-900 tabular-nums">
                        {formatRelative(connection.lastSyncAt).text}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* HH — diagnostics result panel on the eBay card. Surfaces
                  the auth-vs-network-vs-API breakdown next to the
                  connection it describes. */}
              {channel.type === 'EBAY' && diagnostics && (
                <div
                  className={cn(
                    'mt-2 mb-3 border rounded-md px-3 py-2 text-sm',
                    diagnostics.ok
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                      : 'border-amber-200 bg-amber-50 text-amber-800',
                  )}
                >
                  <div className="font-semibold mb-1 flex items-center gap-1">
                    {diagnostics.ok ? (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5" />
                    )}
                    {diagnostics.recommendation}
                  </div>
                  <pre className="whitespace-pre-wrap font-mono text-xs text-slate-600 leading-relaxed">
                    {diagnostics.details}
                  </pre>
                </div>
              )}

              {/* Env-managed connections (currently Amazon) are
                  read-only from the UI: there's nothing to revoke and
                  no per-tenant auth flow yet. The lastSyncError row
                  above already surfaces "credentials missing" when
                  isActive is false. */}
              <div className="flex gap-2 flex-wrap">
                {connection?.isManagedBy === 'env' ? (
                  isConnected ? (
                    <p className="text-sm text-slate-500 italic">
                      Managed via API server env vars. Disconnect by removing creds in Railway.
                    </p>
                  ) : (
                    <p className="text-sm text-red-600">
                      {connection.lastSyncError ?? 'Credentials missing — set env vars in Railway.'}
                    </p>
                  )
                ) : connection?.isManagedBy === 'pending' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled
                    className="flex-1"
                  >
                    Connector deferred
                  </Button>
                ) : isConnected && connection ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={testingId === connection.id}
                      onClick={() => handleTestConnection(connection.id)}
                      className="flex-1"
                    >
                      Test
                    </Button>
                    {channel.type === 'EBAY' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={diagnosing}
                        onClick={() => handleDiagnoseEbay()}
                        className="flex-1"
                      >
                        Diagnose
                      </Button>
                    )}
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => handleRevokeConnection(connection.id)}
                      className="flex-1"
                    >
                      Disconnect
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    loading={isConnecting}
                    icon={<Plug className="w-3.5 h-3.5" />}
                    onClick={() => {
                      if (channel.type === 'EBAY') {
                        handleConnectEbay()
                      } else {
                        setStatusMsg({
                          kind: 'info',
                          text: `${channel.name} connector is deferred.`,
                        })
                      }
                    }}
                    className="flex-1"
                  >
                    Connect
                  </Button>
                )}
              </div>
            </Card>
          )
        })}
      </div>

      <Card title="About marketplace connections">
        <ul className="text-base text-slate-600 space-y-1.5">
          <li>· Each connection authorizes Nexus to read products, listings, and orders from that channel.</li>
          <li>· OAuth tokens are refreshed automatically every 30 minutes before expiry.</li>
          <li>· Disconnecting revokes the token and stops all syncs for that channel.</li>
          <li>· Currently live: <strong>eBay OAuth</strong> + <strong>Amazon (env-managed)</strong>. Shopify, WooCommerce, and Etsy connectors are deferred.</li>
        </ul>
      </Card>
    </div>
  )
}
