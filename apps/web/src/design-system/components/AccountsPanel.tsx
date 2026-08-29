'use client'

/**
 * AccountsPanel — the accounts of each channel, and what you can do to them (MAP.4).
 *
 * The settings page has always rendered ONE card per channel, keyed by
 * `channelType`. That shape cannot express two eBay accounts, which is why the
 * operator could not add a second one even after the data model and the API both
 * supported it. This is the surface that can.
 *
 * It is deliberately a separate component rather than a rewrite of
 * `ChannelsClient`: those channel cards work, they carry the OAuth kickoff and the
 * diagnostics, and replacing them was not what this phase is for.
 *
 * Channel-agnostic by requirement (operator decision 1, 2026-08-19): nothing here
 * names a channel. `onConnect` is supplied per channel by the page, so adding
 * Amazon multi-account later costs a connect flow and nothing in this file.
 *
 * ── CX.2 — the honest row ──────────────────────────────────────────────────
 *
 * Before CX.2 the row's only health signal was a dot encoding `lastSyncStatus`,
 * while `/api/accounts` already returned `authStatus`, the granted scopes, the
 * drift against the catalogue and every CX.1 timestamp — and no client rendered
 * them. The row now reads `authStatus` for its status pill, prints the measured
 * scopes as chips, says how many permissions are missing and relabels Reconnect
 * accordingly, and carries a real **Test** (`POST …/heartbeat`) whose result
 * lands inline. A row from an older API (no `authStatus`) renders exactly as it
 * did, so nothing regresses.
 */

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Pill, Tag } from '../primitives'
import {
  authStatusPill,
  errorLineVisible,
  lastSyncText,
  permissionsLine,
  rowActions,
  runHeartbeat,
  scopeChipLabel,
  timestampText,
  timestampTitle,
  visibleScopes,
  type HeartbeatOutcome,
  type StampKind,
} from '../lib/accounts-panel'
import '../styles/tokens.css'
import '../styles/components.css'
import { ACCOUNT_COLORS, channelDisplayName, type AccountRow, type AccountsPayload } from './AccountSwitcher'

export interface AccountsPanelProps {
  /** Absolute base URL of the API, e.g. `getBackendUrl()`. */
  apiBase: string
  /** Channels the page can start an OAuth flow for. Absent = no connect button. */
  onConnect?: Partial<Record<string, () => void | Promise<void>>>
  /**
   * Re-authorise ONE named account. Distinct from `onConnect`: it tells the
   * server which connection the incoming grant belongs to, which is what lets a
   * connection that predates the identity permission adopt one instead of being
   * refused as an unmatched identity.
   */
  onReconnect?: (account: AccountRow) => void | Promise<void>
  /**
   * Change this to force a refetch. The host owns the events that mean "an
   * account changed outside this panel" — an OAuth popup reporting back, say —
   * and a DS component should not be listening for app-specific window messages
   * to find that out.
   */
  reloadSignal?: unknown
  /** The host app's confirm dialog. Falls back to a plain one when absent. */
  confirm?: (opts: {
    title: string
    description: string
    confirmLabel: string
    // Matches the app's ConfirmProvider union so the host's own dialog can be
    // passed straight in, rather than the DS inventing a second vocabulary for
    // the same concept.
    tone?: 'danger' | 'warning' | 'info'
  }) => Promise<boolean>
  className?: string
  /**
   * Test seam — when provided, the initial fetch is skipped and the panel renders
   * this payload. Mutations and Test still refetch. Same seam as `AccountSwitcher`.
   */
  initialData?: AccountsPayload
}

// One spelling of the channel names, shared with AccountSwitcher. A second copy here
// is why the Amazon Ads group rendered as the raw "AMAZON_ADS" on prod.
const channelName = (c: string) => channelDisplayName(c)

const HEALTH_TEXT: Record<string, string> = {
  ok: 'Healthy',
  warn: 'Degraded',
  error: 'Failing',
  unknown: 'Not yet reported',
}

/* The row's wording and decisions live in `../lib/accounts-panel` (pure, tested); this file
   only places what they return. */

interface BlastRadius {
  counts: Record<string, number>
  total: number
}

/** Plain-language summary of what a disconnect would leave behind. */
function describeBlastRadius(b: BlastRadius): string {
  const parts: string[] = []
  const label: Record<string, string> = {
    listings: 'listing',
    variantListings: 'variant listing',
    memberships: 'shared-SKU membership',
    orders: 'order',
    policies: 'sync policy',
    campaigns: 'ads campaign',
  }
  for (const [k, n] of Object.entries(b.counts)) {
    if (!n) continue
    parts.push(`${n.toLocaleString()} ${label[k] ?? k}${n === 1 ? '' : 's'}`)
  }
  if (parts.length === 0) return 'Nothing references this account yet.'
  return `${parts.join(', ')} are attributed to it. They are kept — the account is deactivated, never deleted, so history still says which account each row came from.`
}

/** A timestamp segment: relative text, the absolute instant (or the reason) in `title`.
 *  `untracked` is for `lastInboundAt` / `lastOutboundAt`, which have NO writer until CX.4 —
 *  a `null` there is "nobody is counting yet", not "never happened", and the row says so. */
function Stamp({ label, iso, kind = 'tracked' }: { label: string; iso: string | null | undefined; kind?: StampKind }) {
  return (
    <span title={timestampTitle(label, iso, kind)}>
      {label} {timestampText(iso, kind)}
    </span>
  )
}

export function AccountsPanel({
  apiBase,
  onConnect,
  onReconnect,
  confirm,
  className,
  reloadSignal,
  initialData,
}: AccountsPanelProps) {
  const [data, setData] = useState<AccountsPayload | null>(initialData ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!initialData)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [expandedScopes, setExpandedScopes] = useState<Record<string, boolean>>({})
  const [testResult, setTestResult] = useState<Record<string, HeartbeatOutcome>>({})

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/accounts`, { credentials: 'include', cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as AccountsPayload
      if (!json?.success) throw new Error('Accounts unavailable')
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Accounts unavailable')
    } finally {
      setLoading(false)
    }
  }, [apiBase])

  // The seam skips only the FIRST fetch; a later `reloadSignal` still refetches.
  const skipFirstLoad = useRef(Boolean(initialData))
  useEffect(() => {
    if (skipFirstLoad.current) {
      skipFirstLoad.current = false
      return
    }
    void load()
  }, [load, reloadSignal])

  /** Every mutation refetches rather than patching local state: the server owns
   *  which account is primary, and guessing it here is how two surfaces come to
   *  disagree about the same fact. */
  const mutate = useCallback(
    async (id: string, path: string, init: RequestInit, okText: string) => {
      setBusyId(id)
      setNotice(null)
      try {
        const res = await fetch(`${apiBase}/api/accounts/${id}${path}`, {
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          ...init,
        })
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
        await load()
        setNotice({ tone: 'ok', text: okText })
      } catch (err) {
        // The server's own words. A refusal that gets reworded here is a refusal
        // the operator cannot act on.
        setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Failed' })
      } finally {
        setBusyId(null)
      }
    },
    [apiBase, load],
  )

  const setColor = (a: AccountRow, hex: string | null) =>
    mutate(
      a.id,
      '',
      { method: 'PATCH', body: JSON.stringify({ accountColor: hex }) },
      hex ? `Colour set for ${a.label}.` : `Colour cleared for ${a.label}.`,
    )

  const makePrimary = (a: AccountRow) =>
    mutate(a.id, '/primary', { method: 'POST' }, `${a.label} is now the primary ${channelName(a.channel)} account.`)

  const saveLabel = async (a: AccountRow) => {
    const next = draftLabel.trim()
    setEditing(null)
    if (next === (a.labelIsPlaceholder ? '' : a.label)) return
    await mutate(
      a.id,
      '',
      { method: 'PATCH', body: JSON.stringify({ accountLabel: next || null }) },
      next ? `Renamed to ${next}.` : 'Name cleared.',
    )
  }

  const disconnect = async (a: AccountRow) => {
    setBusyId(a.id)
    let radius: BlastRadius | null = null
    try {
      const res = await fetch(`${apiBase}/api/accounts/${a.id}/blast-radius`, {
        credentials: 'include',
        cache: 'no-store',
      })
      if (res.ok) radius = (await res.json()) as BlastRadius
    } catch {
      /* the confirm still runs, just without counts */
    }
    setBusyId(null)

    const description = radius
      ? describeBlastRadius(radius)
      : 'Could not read what references this account; disconnecting anyway keeps every row.'
    const ok = confirm
      ? await confirm({
          title: `Disconnect ${a.label}?`,
          description: `${description} New syncs for this account will fail until it is reconnected.`,
          confirmLabel: 'Disconnect',
          tone: 'danger',
        })
      : globalThis.confirm(`Disconnect ${a.label}?\n\n${description}`)
    if (!ok) return
    await mutate(a.id, '/disconnect', { method: 'POST' }, `${a.label} disconnected.`)
  }

  /** Test — a real heartbeat. On success the list refetches so `lastHeartbeatAt`
   *  on the row is the column, not a guess. */
  const test = async (a: AccountRow) => {
    setBusyId(a.id)
    setNotice(null)
    try {
      const outcome = await runHeartbeat(apiBase, a.id)
      setTestResult((prev) => ({ ...prev, [a.id]: outcome }))
      if (outcome.ok) await load()
    } finally {
      setBusyId(null)
    }
  }

  if (loading) return <div className={`nds-acctp${className ? ` ${className}` : ''}`}><span className="nds-acct-skeleton" aria-hidden /></div>

  if (error) {
    return (
      <div className={`nds-acctp${className ? ` ${className}` : ''}`}>
        <p className="nds-acctp-empty">Accounts unavailable — {error}</p>
      </div>
    )
  }

  const accounts = data?.accounts ?? []
  const byChannel = new Map<string, AccountRow[]>()
  for (const a of accounts) byChannel.set(a.channel, [...(byChannel.get(a.channel) ?? []), a])
  // A channel with a connect handler but no accounts still gets a section, so the
  // button to add the first one has somewhere to live.
  for (const c of Object.keys(onConnect ?? {})) if (!byChannel.has(c)) byChannel.set(c, [])

  return (
    <div className={`nds-acctp${className ? ` ${className}` : ''}`}>
      <div className="nds-acctp-head">
        <h3>Accounts</h3>
        <p>
          Each channel can hold more than one seller account. The primary is the one ambient work uses
          when nothing names an account.
        </p>
      </div>

      {notice && (
        <p className="nds-acctp-notice" data-tone={notice.tone} role="status">
          {notice.text}
        </p>
      )}

      {[...byChannel.entries()].map(([channel, rows]) => (
        <section key={channel} className="nds-acctp-group">
          <header>
            <span className="nds-acctp-ch">{channelName(channel)}</span>
            <span className="nds-acctp-count">{rows.length}</span>
          </header>

          {rows.length === 0 && <p className="nds-acctp-empty">No account connected yet.</p>}

          {rows.map((a) => {
            const busy = busyId === a.id
            // An older API (no `authStatus`) keeps the health dot: the CX.1 fields
            // are all absent together, so there is nothing else to draw.
            const hasCx = a.authStatus !== undefined
            const status = a.authStatus !== undefined ? authStatusPill(a.authStatus, a.consecutiveFailures ?? 0) : null
            const scopesOpen = expandedScopes[a.id] === true
            const chips = visibleScopes(a.scopes ?? [], scopesOpen)
            const permissions = permissionsLine(a.grantedScopes, a.scopeDrift, a.managedBy)
            const showError = errorLineVisible(a.authStatus, a.lastError)
            const actions = rowActions(a, Boolean(onReconnect))
            const result = testResult[a.id]
            // The sub line: health text only for a pre-CX.1 row (the pill carries it
            // otherwise), then whatever the row still needs to say about itself.
            const sub: ReactNode[] = []
            if (!hasCx) sub.push(HEALTH_TEXT[a.health] ?? a.health)
            // `healthReason` is the LAST SYNC's verdict. With a CX.1 row the pill states
            // the auth state and the times line carries the sync outcome and its error,
            // so repeating it here contradicted the pill ("Connected" + "tokens not configured").
            if (!hasCx && a.healthReason) sub.push(a.healthReason)
            if (a.labelIsPlaceholder) sub.push('no name from the channel — rename it')
            if (!a.externalAccountId) {
              sub.push(
                <span className="nds-acctp-warn">identity unavailable — reconnect to enable multi-account</span>,
              )
            }

            return (
              <div key={a.id} className="nds-acctp-row" data-busy={busy || undefined}>
                {!hasCx && <span className="nds-acct-dot" data-health={a.health} aria-hidden />}
                <div className="nds-acctp-main">
                  {editing === a.id ? (
                    <input
                      className="nds-acctp-input"
                      autoFocus
                      value={draftLabel}
                      placeholder={a.label}
                      onChange={(e) => setDraftLabel(e.target.value)}
                      onBlur={() => void saveLabel(a)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveLabel(a)
                        if (e.key === 'Escape') setEditing(null)
                      }}
                      aria-label={`Name for this ${channelName(a.channel)} account`}
                    />
                  ) : (
                    <span className="nds-acctp-name">
                      {status && (
                        <Pill tone={status.tone} dot size="sm" className="nds-acctp-status" data-tone={status.tone}>
                          {status.label}
                        </Pill>
                      )}
                      {a.label}
                      {a.isPrimary && <span className="nds-acctp-badge">Primary</span>}
                      {a.managedBy === 'env' && <span className="nds-acct-tag">env-managed</span>}
                      {a.region && <Tag>{a.region}</Tag>}
                    </span>
                  )}

                  {sub.length > 0 && (
                    <span className="nds-acctp-sub">
                      {sub.map((part, i) => (
                        <Fragment key={i}>
                          {i > 0 && ' · '}
                          {part}
                        </Fragment>
                      ))}
                    </span>
                  )}

                  {/* Measured facts from ConnectionScope — never the marketplace allowlist. */}
                  {hasCx && chips.visible.length > 0 && (
                    <div className="nds-acctp-scopes" aria-label={`Scopes of ${a.label}`}>
                      {chips.visible.map((s) => (
                        <Tag key={`${s.kind}:${s.externalId}`}>{scopeChipLabel(s)}</Tag>
                      ))}
                      {chips.foldable && (
                        <Button
                          variant="link"
                          size="xs"
                          inline
                          aria-expanded={scopesOpen}
                          onClick={() => setExpandedScopes((prev) => ({ ...prev, [a.id]: !scopesOpen }))}
                        >
                          {chips.toggleText}
                        </Button>
                      )}
                    </div>
                  )}

                  {hasCx && (
                    <div className="nds-acctp-times">
                      {permissions?.tone === 'warning' ? (
                        <Pill tone="warning" size="sm" data-tone="warning">
                          {permissions.text}
                        </Pill>
                      ) : permissions ? (
                        <span>{permissions.text}</span>
                      ) : null}
                      <Stamp label="Refreshed" iso={a.lastRefreshAt} kind={a.managedBy === 'env' ? 'na' : 'tracked'} />
                      <Stamp label="Heartbeat" iso={a.lastHeartbeatAt} />
                      <Stamp label="Inbound" iso={a.lastInboundAt} kind="untracked" />
                      <Stamp label="Outbound" iso={a.lastOutboundAt} kind="untracked" />
                      <span title={timestampTitle('Last sync', a.lastSyncAt)}>
                        {lastSyncText(a.lastSyncAt, a.lastSyncStatus, Date.now(), a.lastSyncError)}
                      </span>
                    </div>
                  )}

                  {showError && (
                    <p className="nds-acctp-err" title={a.lastErrorAt ?? undefined}>
                      {a.lastError}
                    </p>
                  )}

                  {result && (
                    <span className="nds-acctp-test" data-tone={result.ok ? 'ok' : 'error'} role="status">
                      {result.text}
                    </span>
                  )}
                </div>

                {/* A fixed palette, not a colour picker: identity has to read the
                    same on every surface, and an arbitrary hex can land unreadable
                    against one of the two themes. */}
                <div className="nds-acctp-swatches" role="group" aria-label={`Identity colour for ${a.label}`}>
                  {ACCOUNT_COLORS.map((c) => (
                    <button
                      key={c.hex}
                      type="button"
                      className="nds-acctp-swatch"
                      style={{ background: c.hex }}
                      aria-label={c.name}
                      aria-pressed={a.accountColor === c.hex}
                      disabled={busy}
                      onClick={() => void setColor(a, c.hex)}
                    />
                  ))}
                  {a.accountColor && (
                    <button
                      type="button"
                      className="nds-acctp-swatch is-clear"
                      aria-label="Clear colour"
                      disabled={busy}
                      onClick={() => void setColor(a, null)}
                    >
                      ×
                    </button>
                  )}
                </div>

                <div className="nds-acctp-actions">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setEditing(a.id)
                      setDraftLabel(a.labelIsPlaceholder ? '' : a.label)
                    }}
                  >
                    Rename
                  </Button>
                  {actions.makePrimary && (
                    <Button size="sm" disabled={busy} onClick={() => void makePrimary(a)}>
                      Make primary
                    </Button>
                  )}
                  {/* A real call, not a status read: the server writes `lastHeartbeatAt`
                      and a ledger row, then the list refetches. Works for env-managed
                      rows too (Amazon participations). */}
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void test(a)}>
                    Test
                  </Button>
                  {actions.reconnect && onReconnect && (
                    <Button size="sm" disabled={busy} onClick={() => void onReconnect(a)}>
                      {actions.reconnect}
                    </Button>
                  )}
                  {/* An env-managed account has no OAuth grant to revoke, so there is
                      nothing here to disconnect. It renders as a REASON, not as a
                      disabled button: a `title` on a disabled control is unreachable
                      (a disabled element fires no pointer events), so the explanation
                      would be written where nobody can read it — and a disabled
                      control's colours are dim enough to fail contrast besides. */}
                  {actions.envNote ? (
                    <span className="nds-acctp-note">Set by environment — no grant to revoke</span>
                  ) : (
                    <Button size="sm" variant="danger-outline" disabled={busy} onClick={() => void disconnect(a)}>
                      Disconnect
                    </Button>
                  )}
                </div>
              </div>
            )
          })}

          {onConnect?.[channel] && (
            <button type="button" className="nds-acctp-add" onClick={() => void onConnect[channel]!()}>
              + Connect {rows.length > 0 ? 'another ' : ''}
              {channelName(channel)} account
            </button>
          )}
        </section>
      ))}
    </div>
  )
}
