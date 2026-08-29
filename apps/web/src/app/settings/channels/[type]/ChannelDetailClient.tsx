'use client'

/**
 * /settings/channels/[type] — one channel's connection, on the design system (CX.2 §5).
 *
 * Same route, same two endpoints as the Phase F.5 page it replaces:
 *   GET   /api/settings/channels/:type/detail        everything rendered here
 *   PATCH /api/settings/channels/:type/marketplaces  the CheckboxCard grid, through the save bar
 * plus the three CX.1 actions the old header only promised:
 *   POST  /api/cx/connections/:id/heartbeat          Test
 *   POST  /api/cx/connect/ebay/start                 Reconnect (eBay only until CX.3)
 *   POST  /api/accounts/:id/disconnect               Disconnect (revokes at the channel)
 *
 * Every value traces to a column the detail endpoint returns. "Connected" is `authStatus`,
 * never `isActive`; a null timestamp says "never", and the two columns nothing feeds yet
 * (`lastInboundAt` / `lastOutboundAt`, CX.4) say "not tracked yet" — "never" would be a lie
 * about a column no receiver writes.
 *
 * The pure half — types, status table, timestamps, holds, the calls — is `./channelDetail.ts`,
 * which the node-only test suite covers; this file is the markup over it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import {
  Banner,
  Card,
  KeyValue,
  MetricStrip,
  type KeyValueItem,
} from '@/design-system/components'
import { Button, CheckboxCard, Pill, Tag } from '@/design-system/primitives'
import { PageHeader } from '@/design-system/patterns'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { useSettingsForm } from '../../_shell/SettingsSaveBar'
import '../channels.css'
import { InboundGrid } from '../ChannelEventsGrid'
import {
  type ActionNote,
  type ChannelConnection,
  type ChannelDetail,
  type ConnectionScopeRow,
  type RecentEvent,
  type Tone,
  type WhenCell,
  MANAGED_BY,
  PAGE_MAX_WIDTH,
  SYNC_TONE,
  channelLabel,
  disconnectAccount,
  disconnectHold,
  fetchDetail,
  identityLine,
  marketplaceOptions,
  marketplacesDescription,
  patchMarketplaces,
  permissionsCopy,
  shortScope,
  reconnectHold,
  reconnectLabel,
  runHeartbeat,
  sameSet,
  showLastError,
  startReconnect,
  statusPill,
  testHold,
  timestampText,
  toggleMarketplace,
} from './channelDetail'

export type { ChannelConnection, ChannelDetail, RecentEvent } from './channelDetail'

// ─── Layout helpers (tokens only) ────────────────────────────────────────

const stack = (gap: string): React.CSSProperties => ({ display: 'grid', gap })
const row = (gap: string): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap,
  flexWrap: 'wrap',
})
const muted: React.CSSProperties = { color: 'var(--nds-text-muted)' }

// ─── Page ────────────────────────────────────────────────────────────────

interface Props {
  channelType: string
  initial: ChannelDetail | null
  initialError: string | null
}

export default function ChannelDetailClient({ channelType, initial, initialError }: Props) {
  const router = useRouter()
  const confirm = useConfirm()
  const label = channelLabel(channelType)

  const [detail, setDetail] = useState<ChannelDetail | null>(initial)
  const [error, setError] = useState<string | null>(initialError)
  const [note, setNote] = useState<ActionNote | null>(null)
  const [busy, setBusy] = useState<'test' | 'reconnect' | 'disconnect' | null>(null)

  const [draftMarkets, setDraftMarkets] = useState<string[]>(initial?.activeMarketplaces ?? [])
  useEffect(() => {
    setDraftMarkets(detail?.activeMarketplaces ?? [])
  }, [detail?.activeMarketplaces])

  const isDirty = useMemo(
    () => !sameSet(detail?.activeMarketplaces ?? [], draftMarkets),
    [detail?.activeMarketplaces, draftMarkets],
  )

  const refetch = useCallback(async () => {
    try {
      setDetail(await fetchDetail(channelType))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [channelType])

  const onSave = useCallback(async () => {
    await patchMarketplaces(channelType, draftMarkets)
    await refetch()
    router.refresh()
  }, [draftMarkets, channelType, refetch, router])

  const onDiscard = useCallback(() => {
    setDraftMarkets(detail?.activeMarketplaces ?? [])
  }, [detail?.activeMarketplaces])

  useSettingsForm({ id: `settings/channels/${channelType}`, isDirty, onSave, onDiscard })

  // The consent popup reports back through postMessage (own origin, or the API origin where the
  // callback page is served) and BroadcastChannel('nexus-oauth'); it waits for our ACK to close.
  useEffect(() => {
    if (typeof window === 'undefined') return
    let apiOrigin: string | null = null
    try {
      apiOrigin = new URL(getBackendUrl()).origin
    } catch {
      apiOrigin = null
    }
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin && e.origin !== apiOrigin) return
      if (!e.data || e.data.type !== 'nexus:channel-connected') return
      try {
        ;(e.source as Window | null)?.postMessage({ type: 'nexus:ack' }, e.origin)
      } catch {
        /* the popup may already be gone */
      }
      void refetch()
    }
    window.addEventListener('message', onMessage)
    let bc: BroadcastChannel | null = null
    try {
      bc = new BroadcastChannel('nexus-oauth')
      bc.onmessage = (e) => {
        if (!e.data || e.data.type !== 'nexus:channel-connected') return
        bc?.postMessage({ type: 'nexus:ack' })
        void refetch()
      }
    } catch {
      bc = null
    }
    return () => {
      window.removeEventListener('message', onMessage)
      bc?.close()
    }
  }, [refetch])

  const connection = detail?.connection ?? null

  const onTest = useCallback(async () => {
    if (!connection) return
    const hold = testHold(channelType, connection)
    if (hold.held) {
      setNote({ tone: 'info', text: hold.reason })
      return
    }
    setBusy('test')
    try {
      setNote(await runHeartbeat(connection.id))
      await refetch()
    } catch (e) {
      setNote({ tone: 'danger', text: `Failed · ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy(null)
    }
  }, [channelType, connection, refetch])

  const onReconnect = useCallback(async () => {
    if (!connection) return
    const hold = reconnectHold(channelType, connection)
    if (hold.held) {
      setNote({ tone: 'info', text: hold.reason })
      return
    }
    // Opened synchronously inside the click so the browser does not block it as a popup.
    const popup = window.open('about:blank', 'nexus-oauth', 'popup,width=600,height=760')
    setBusy('reconnect')
    try {
      const r = await startReconnect(connection.id)
      if ('error' in r) {
        popup?.close()
        setNote({ tone: 'danger', text: `Reconnect failed · ${r.error}` })
        return
      }
      if (popup) popup.location.href = r.authUrl
      else window.location.href = r.authUrl
      setNote({
        tone: 'info',
        text: 'Finish signing in with eBay in the popup — this page updates when it reports back.',
      })
    } catch (e) {
      popup?.close()
      setNote({ tone: 'danger', text: `Reconnect failed · ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy(null)
    }
  }, [channelType, connection])

  const onDisconnect = useCallback(async () => {
    if (!connection) return
    const hold = disconnectHold(channelType, connection)
    if (hold.held) {
      setNote({ tone: 'info', text: hold.reason })
      return
    }
    const ok = await confirm({
      title: `Disconnect ${label}?`,
      description:
        'Revokes the grant at the channel and archives it. Syncs and listings for this account stop until it is reconnected.',
      confirmLabel: 'Disconnect',
      tone: 'danger',
    })
    if (!ok) return
    setBusy('disconnect')
    try {
      const r = await disconnectAccount(connection.id)
      if ('error' in r) {
        setNote({ tone: 'danger', text: `Disconnect failed · ${r.error}` })
        return
      }
      setNote({ tone: 'success', text: 'Disconnected — the grant was revoked at the channel.' })
      await refetch()
      router.refresh()
    } finally {
      setBusy(null)
    }
  }, [channelType, connection, confirm, label, refetch, router])

  if (!detail || !connection) {
    return (
      <div style={{ maxWidth: PAGE_MAX_WIDTH, ...stack('var(--nds-space-16)') }}>
        <BackLink />
        <Banner tone="danger" title="Unable to load channel detail">
          {error ?? 'The detail endpoint returned nothing.'}
        </Banner>
      </div>
    )
  }

  const status = statusPill(connection.authStatus, connection.consecutiveFailures)
  const testH = testHold(channelType, connection)
  const reconnectH = reconnectHold(channelType, connection)
  const disconnectH = disconnectHold(channelType, connection)
  const drift = detail.scopeDrift ?? connection.scopeDrift ?? []

  return (
    <div style={{ maxWidth: PAGE_MAX_WIDTH, ...stack('var(--nds-space-20)') }}>
      <PageHeader
        eyebrow={<BackLink />}
        title={label}
        subtitle={
          <span style={row('var(--nds-space-8)')}>
            <Pill tone={status.tone} dot size="md">
              {status.label}
            </Pill>
            <span>{identityLine(connection)}</span>
            {connection.region && <Tag>{connection.region}</Tag>}
            {connection.isManagedBy === 'env' && <Tag tone="info">env-managed</Tag>}
          </span>
        }
        actions={
          <>
            <Button
              size="sm"
              onClick={onTest}
              aria-disabled={testH.held || busy === 'test'}
              aria-busy={busy === 'test'}
            >
              {busy === 'test' ? 'Testing…' : 'Test'}
            </Button>
            <Button
              size="sm"
              variant={drift.length > 0 ? 'primary' : 'secondary'}
              onClick={onReconnect}
              aria-disabled={reconnectH.held || busy === 'reconnect'}
              aria-busy={busy === 'reconnect'}
            >
              {busy === 'reconnect' ? 'Opening…' : reconnectLabel(drift.length)}
            </Button>
            <Button
              size="sm"
              variant="danger-outline"
              onClick={onDisconnect}
              aria-disabled={disconnectH.held || busy === 'disconnect'}
              aria-busy={busy === 'disconnect'}
            >
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </>
        }
      />

      {note && (
        <Banner tone={note.tone} onDismiss={() => setNote(null)}>
          {note.text}
        </Banner>
      )}
      {error && (
        <Banner tone="danger" title="Could not refresh" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      {/* The two reference cards sit side by side once there is room for both
          (measured: a single 880px column left 502px empty at 1728px). */}
      <div className="nds-cd-pair">
        <ConnectionCard connection={connection} status={status} />
        <PermissionsCard scopes={detail.scopes} drift={drift} />
      </div>
      <MarketplacesCard
        channelType={channelType}
        participation={detail.connectionScopes ?? []}
        draftMarkets={draftMarkets}
        setDraftMarkets={setDraftMarkets}
      />
      <InboundEventsCard events={detail.recentEvents} stats={detail.eventStats} />
      <AdvancedCard meta={detail.meta} />
    </div>
  )
}

function BackLink() {
  return (
    <Button asChild variant="link" inline size="sm">
      <Link href="/settings/channels" style={row('var(--nds-space-4)')}>
        <ArrowLeft size={13} aria-hidden />
        All channels
      </Link>
    </Button>
  )
}

// ─── Cards ───────────────────────────────────────────────────────────────

function When({ cell }: { cell: WhenCell }) {
  return (
    <span title={cell.title} style={cell.title ? undefined : muted}>
      {cell.text}
    </span>
  )
}

function ConnectionCard({
  connection,
  status,
}: {
  connection: ChannelConnection
  status: { tone: Tone; label: string }
}) {
  const now = Date.now()
  const accessExpiry = timestampText(
    connection.accessTokenExpiresAt ?? connection.tokenExpiresAt,
    'expiry',
    now,
  )
  const refreshExpiry = timestampText(connection.refreshTokenExpiresAt, 'expiry', now)
  const identityEntries = Object.entries(connection.identity ?? {}).filter(
    ([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  )

  const items: KeyValueItem[] = [
    {
      label: 'Status',
      value: (
        <Pill tone={status.tone} dot>
          {status.label}
        </Pill>
      ),
    },
    { label: 'Managed by', value: MANAGED_BY[connection.isManagedBy] },
    {
      label: 'Region',
      value: connection.region ? <Tag>{connection.region}</Tag> : <span style={muted}>—</span>,
    },
    {
      label: 'Access token expires',
      value: <When cell={accessExpiry} />,
      hint: accessExpiry.past ? 'expired — the next call refreshes it' : undefined,
    },
    {
      label: 'Refresh token expires',
      value: <When cell={refreshExpiry} />,
      hint: refreshExpiry.past ? 'expired — reconnect to sign in again' : undefined,
    },
    { label: 'Last refresh', value: <When cell={timestampText(connection.lastRefreshAt, 'event', now)} /> },
    { label: 'Last heartbeat', value: <When cell={timestampText(connection.lastHeartbeatAt, 'event', now)} /> },
    {
      label: 'Last inbound',
      value: <When cell={timestampText(connection.lastInboundAt, 'untracked', now)} />,
      hint: connection.lastInboundAt ? undefined : 'no receiver writes this until CX.4',
    },
    {
      label: 'Last outbound',
      value: <When cell={timestampText(connection.lastOutboundAt, 'untracked', now)} />,
      hint: connection.lastOutboundAt ? undefined : 'no sender writes this until CX.4',
    },
    {
      label: 'Last sync',
      value: (
        <span style={row('var(--nds-space-6)')}>
          {connection.lastSyncStatus && (
            <Pill tone={SYNC_TONE[connection.lastSyncStatus] ?? 'neutral'}>
              {connection.lastSyncStatus}
            </Pill>
          )}
          <When cell={timestampText(connection.lastSyncAt, 'event', now)} />
        </span>
      ),
      hint: connection.lastSyncError ?? undefined,
    },
    {
      label: 'Connected since',
      value: (
        <span title={connection.createdAt}>{new Date(connection.createdAt).toLocaleDateString()}</span>
      ),
      hint: timestampText(connection.createdAt, 'event', now).text,
    },
    {
      label: 'Consecutive failures',
      value: connection.consecutiveFailures,
      hint: connection.lastErrorAt ? (
        <>
          last error <When cell={timestampText(connection.lastErrorAt, 'event', now)} />
        </>
      ) : undefined,
    },
  ]
  if (identityEntries.length > 0) {
    items.push({
      label: 'Identity',
      value: (
        <span style={stack('var(--nds-space-2)')}>
          {identityEntries.map(([k, v]) => (
            <span key={k}>
              <span style={muted}>{k}</span> {String(v)}
            </span>
          ))}
        </span>
      ),
    })
  }

  return (
    <Card
      header="Connection"
      description="Sign-in state and the timestamps the heartbeat, refresh and sync jobs write."
    >
      <div style={stack('var(--nds-space-14)')}>
        <KeyValue items={items} columns={3} />
        {showLastError(connection) && (
          <Banner tone="danger" title="Last error">
            {connection.lastError}
          </Banner>
        )}
      </div>
    </Card>
  )
}

function PermissionsCard({ scopes, drift }: { scopes: string[]; drift: string[] }) {
  // Two labelled groups, not one mixed list with "· not granted" repeated on every
  // chip: the state belongs to the group, and the chip shows the scope's distinctive
  // tail with the full value in its title (22 identical 38-char prefixes read as noise).
  return (
    <Card header="Permissions" description={permissionsCopy(scopes.length, drift.length)}>
      {scopes.length === 0 && drift.length === 0 ? null : (
        <div style={stack('var(--nds-space-10)')}>
          {scopes.length > 0 && (
            <div style={stack('var(--nds-space-6)')}>
              <span className="nds-cd-grouplabel">Granted</span>
              <div style={row('var(--nds-space-6)')}>
                {scopes.map((s) => (
                  <Tag key={s}>
                    <span title={s}>{shortScope(s)}</span>
                  </Tag>
                ))}
              </div>
            </div>
          )}
          {drift.length > 0 && (
            <div style={stack('var(--nds-space-6)')}>
              <span className="nds-cd-grouplabel">Not granted — reconnect to grant them</span>
              <div style={row('var(--nds-space-6)')}>
                {drift.map((s) => (
                  <Pill key={`missing:${s}`} tone="warning">
                    <span title={s}>{shortScope(s)}</span>
                  </Pill>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function MarketplacesCard({
  channelType,
  participation,
  draftMarkets,
  setDraftMarkets,
}: {
  channelType: string
  participation: ConnectionScopeRow[]
  draftMarkets: string[]
  setDraftMarkets: (next: string[]) => void
}) {
  const label = channelLabel(channelType)
  const options = marketplaceOptions(channelType)
  const description = marketplacesDescription(channelType, draftMarkets)
  if (options.length === 0 && participation.length === 0) {
    return (
      <Card header="Marketplaces" description={description}>
        {null}
      </Card>
    )
  }
  return (
    <Card header="Marketplaces" description={description}>
      <div style={stack('var(--nds-space-14)')}>
        {participation.length > 0 && (
          <div style={stack('var(--nds-space-6)')}>
            <p style={{ margin: 0 }}>
              Participating in — measured from the channel ({participation.length})
            </p>
            <div style={row('var(--nds-space-6)')}>
              {participation.map((s) => (
                <Tag key={`${s.kind}:${s.externalId}`} tone={s.isActive ? 'success' : 'neutral'}>
                  {s.label ?? s.externalId}
                  {s.isActive ? '' : ' · inactive'}
                </Tag>
              ))}
            </div>
          </div>
        )}
        {options.length > 0 && (
          <div style={stack('var(--nds-space-6)')}>
            <p style={{ margin: 0 }}>
              Markets this account can be scoped to
              <span style={muted}>
                {' '}
                — the set the API accepts for {label}; saved as this connection&apos;s
                active-marketplace scope.
              </span>
            </p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                gap: 'var(--nds-space-8)',
              }}
            >
              {options.map((o) => {
                const on = draftMarkets.includes(o.code)
                return (
                  <CheckboxCard
                    key={o.code}
                    title={o.code}
                    description={o.name}
                    checked={on}
                    selected={on}
                    onChange={() => setDraftMarkets(toggleMarketplace(draftMarkets, o.code))}
                  />
                )
              })}
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

function InboundEventsCard({
  events,
  stats,
}: {
  events: RecentEvent[]
  stats: ChannelDetail['eventStats']
}) {
  return (
    <Card header="Inbound events" description="The last 50 deliveries the channel sent us, newest first.">
      <div style={stack('var(--nds-space-14)')}>
        <MetricStrip
          metrics={[
            { label: 'OK', value: stats.success, accent: 'var(--nds-success)' },
            { label: 'Failed', value: stats.failed, accent: 'var(--nds-danger)' },
            { label: 'Pending', value: stats.pending, accent: 'var(--nds-warning)' },
            { label: 'Total', value: stats.total, hint: 'of the last 50' },
          ]}
        />
        <InboundGrid rows={events} emptyTitle="No inbound events yet" emptyDescription="Nothing this channel sent us has been recorded." />
      </div>
    </Card>
  )
}

function AdvancedCard({ meta }: { meta: Record<string, unknown> | null }) {
  if (!meta || Object.keys(meta).length === 0) return null
  return (
    <Card
      header="Advanced"
      description="The raw connection metadata the adapter stored on this row — for diagnostics."
    >
      <details>
        <summary style={{ cursor: 'pointer', color: 'var(--nds-text-link)' }}>Show JSON</summary>
        <pre
          style={{
            margin: 'var(--nds-space-10) 0 0',
            padding: 'var(--nds-space-10) var(--nds-space-12)',
            background: 'var(--nds-surface-sunken)',
            border: '1px solid var(--nds-border-subtle)',
            borderRadius: 'var(--nds-radius-md)',
            color: 'var(--nds-text-2)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            overflowX: 'auto',
          }}
        >
          {JSON.stringify(meta, null, 2)}
        </pre>
      </details>
    </Card>
  )
}
