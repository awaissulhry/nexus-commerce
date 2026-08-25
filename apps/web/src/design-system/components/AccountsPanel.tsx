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
 */

import { useCallback, useEffect, useState } from 'react'
import '../styles/tokens.css'
import '../styles/components.css'
import { ACCOUNT_COLORS, type AccountRow, type AccountsPayload } from './AccountSwitcher'

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
}

const CHANNEL_LABEL: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  ETSY: 'Etsy',
}
const channelName = (c: string) => CHANNEL_LABEL[c] ?? c

const HEALTH_TEXT: Record<string, string> = {
  ok: 'Healthy',
  warn: 'Degraded',
  error: 'Failing',
  unknown: 'Not yet reported',
}

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

export function AccountsPanel({ apiBase, onConnect, onReconnect, confirm, className, reloadSignal }: AccountsPanelProps) {
  const [data, setData] = useState<AccountsPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

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

  useEffect(() => {
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

          {rows.map((a) => (
            <div key={a.id} className="nds-acctp-row" data-busy={busyId === a.id || undefined}>
              <span className="nds-acct-dot" data-health={a.health} aria-hidden />
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
                    {a.label}
                    {a.isPrimary && <span className="nds-acctp-badge">Primary</span>}
                    {a.managedBy === 'env' && <span className="nds-acct-tag">env-managed</span>}
                  </span>
                )}
                <span className="nds-acctp-sub">
                  {HEALTH_TEXT[a.health] ?? a.health}
                  {a.healthReason ? ` · ${a.healthReason}` : ''}
                  {a.labelIsPlaceholder && ' · no name from the channel — rename it'}
                  {!a.externalAccountId && (
                    <>
                      {' · '}
                      <span className="nds-acctp-warn">
                        identity unavailable — reconnect to enable multi-account
                      </span>
                    </>
                  )}
                </span>
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
                    disabled={busyId === a.id}
                    onClick={() => void setColor(a, c.hex)}
                  />
                ))}
                {a.accountColor && (
                  <button
                    type="button"
                    className="nds-acctp-swatch is-clear"
                    aria-label="Clear colour"
                    disabled={busyId === a.id}
                    onClick={() => void setColor(a, null)}
                  >
                    ×
                  </button>
                )}
              </div>

              <div className="nds-acctp-actions">
                <button
                  type="button"
                  disabled={busyId === a.id}
                  onClick={() => {
                    setEditing(a.id)
                    setDraftLabel(a.labelIsPlaceholder ? '' : a.label)
                  }}
                >
                  Rename
                </button>
                {!a.isPrimary && (
                  <button type="button" disabled={busyId === a.id} onClick={() => void makePrimary(a)}>
                    Make primary
                  </button>
                )}
                {onReconnect && a.managedBy !== 'env' && (
                  <button
                    type="button"
                    disabled={busyId === a.id}
                    onClick={() => void onReconnect(a)}
                  >
                    Reconnect
                  </button>
                )}
                {/* An env-managed account has no OAuth grant to revoke, so there is
                    nothing here to disconnect. It renders as a REASON, not as a
                    disabled button: a `title` on a disabled control is unreachable
                    (a disabled element fires no pointer events), so the explanation
                    would be written where nobody can read it — and a disabled
                    control's colours are dim enough to fail contrast besides. */}
                {a.managedBy === 'env' ? (
                  <span className="nds-acctp-note">Set by environment — no grant to revoke</span>
                ) : (
                  <button
                    type="button"
                    className="is-danger"
                    disabled={busyId === a.id}
                    onClick={() => void disconnect(a)}
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </div>
          ))}

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
