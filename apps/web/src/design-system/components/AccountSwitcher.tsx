'use client'

/**
 * AccountSwitcher — the top-right account identity control (MAP.1).
 *
 * Modelled on Rithum's, read frame-by-frame from the operator's 2026-08-12
 * recording (10:49–11:11): identity sits at the far right of the primary bar,
 * one click opens a roster panel, the current account is highlighted, and a
 * selection re-enters the page you were already on. See
 * `docs/2026-08-19-map-multi-account-profiles.md` §1.2.
 *
 * ── What this deliberately does NOT do yet ────────────────────────────────
 *
 * It does not switch accounts. Every channel has at most one active connection
 * today — the partial unique index `ChannelConnection_channelType_marketplace_active_key`
 * guarantees it, and `/api/accounts/diagnostics` proves it live. So the rows are
 * informational, not selectable, and no caret implies a choice that does not
 * exist. MAP.4 flips `canSwitch` and turns the rows into links.
 *
 * What it DOES do is tell the truth about what Nexus is connected to. The two
 * chips it replaces in `components/layout/TopBar.tsx` were hard-coded strings
 * ("Amazon IT", "eBay") with permanently-green dots, reading from nothing.
 *
 * ── Why this file imports its own CSS ─────────────────────────────────────
 *
 * DS components normally leave stylesheet imports to the consuming page. This
 * one mounts in three unrelated shells (`TopBar`, the ads shell, the products
 * rail), and a mount point that forgets the import renders a silently unstyled
 * control — `reference_undefined_css_class_is_silent`. Owning the imports here
 * makes it correct wherever it is placed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '../styles/tokens.css'
import '../styles/components.css'

export type AccountHealth = 'ok' | 'warn' | 'error' | 'unknown'

export interface AccountRow {
  id: string
  channel: string
  managedBy: string
  label: string
  labelSource: 'storeName' | 'displayName' | 'signInName' | 'sellerId' | 'channel'
  labelIsPlaceholder: boolean
  markets: string[]
  health: AccountHealth
  healthReason: string | null
  isPrimary: boolean
  tokenExpiresAt: string | null
  lastSyncAt: string | null
  lastSyncStatus: string | null
  lastSyncError: string | null
}

export interface AccountsPayload {
  success: boolean
  accounts: AccountRow[]
  notConnected: string[]
  canSwitch: boolean
}

export interface AccountSwitcherProps {
  /** Absolute URL of `GET /api/accounts`. */
  endpoint: string
  /** Where "Manage channels" goes. */
  manageHref?: string
  className?: string
  /** Test seam — when provided, no fetch is performed. */
  initialData?: AccountsPayload
}

const CHANNEL_LABEL: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  ETSY: 'Etsy',
}

const HEALTH_TEXT: Record<AccountHealth, string> = {
  ok: 'Healthy',
  warn: 'Degraded',
  error: 'Failing',
  unknown: 'Not yet reported',
}

function channelName(channel: string): string {
  return CHANNEL_LABEL[channel] ?? channel
}

/**
 * The label to show for an account. When the backend flags the label as a
 * placeholder there is no real account name to show — the eBay OAuth scope in
 * use carries no identity claim, and Amazon's is a raw merchant id. Naming the
 * channel and showing the raw value underneath is honest; inventing a friendly
 * name is not. MAP.2's `accountLabel` column is the fix.
 */
function primaryLabel(a: AccountRow): string {
  return a.labelIsPlaceholder ? channelName(a.channel) : a.label
}

export function AccountSwitcher({
  endpoint,
  manageHref = '/settings/channels',
  className,
  initialData,
}: AccountSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<AccountsPayload | null>(initialData ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!initialData)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (initialData) return
    let cancelled = false
    ;(async () => {
      try {
        // no-store: a chip that caches its own health is a chip that lies.
        const res = await fetch(endpoint, { credentials: 'include', cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as AccountsPayload
        if (cancelled) return
        if (!json?.success) throw new Error('Accounts unavailable')
        setData(json)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Accounts unavailable')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [endpoint, initialData])

  // Outside click + Escape, and focus returns to the trigger on close.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const accounts = data?.accounts ?? []
  const notConnected = data?.notConnected ?? []

  const grouped = useMemo(() => {
    const map = new Map<string, AccountRow[]>()
    for (const a of accounts) {
      const list = map.get(a.channel) ?? []
      list.push(a)
      map.set(a.channel, list)
    }
    return [...map.entries()]
  }, [accounts])

  /**
   * The trigger shows one pill per CHANNEL, not per account. With two eBay
   * accounts connected, per-account pills render "eBay eBay" — verified in the
   * browser against the MAP.4 payload shape. A channel's dot takes the worst
   * health among its accounts, so a degraded second store cannot hide behind a
   * healthy first one.
   */
  const channelPills = useMemo(
    () =>
      grouped.map(([channel, rows]) => ({
        channel,
        count: rows.length,
        health: rows.some((r) => r.health === 'error')
          ? ('error' as const)
          : rows.some((r) => r.health === 'warn')
            ? ('warn' as const)
            : rows.some((r) => r.health === 'unknown')
              ? ('unknown' as const)
              : ('ok' as const),
      })),
    [grouped],
  )

  const summary = useMemo(() => {
    if (accounts.length === 0) return 'No accounts'
    const worst: AccountHealth = accounts.some((a) => a.health === 'error')
      ? 'error'
      : accounts.some((a) => a.health === 'warn')
        ? 'warn'
        : accounts.every((a) => a.health === 'ok')
          ? 'ok'
          : 'unknown'
    return `${accounts.length} account${accounts.length === 1 ? '' : 's'} · ${HEALTH_TEXT[worst]}`
  }, [accounts])

  const toggle = useCallback(() => setOpen((o) => !o), [])

  if (loading) {
    return (
      <div className={`h10-ds-acct${className ? ` ${className}` : ''}`}>
        <span className="h10-ds-acct-skeleton" aria-hidden />
      </div>
    )
  }

  // A failed load must not blank the chrome. Say so quietly and stay out of the way.
  if (error || accounts.length === 0) {
    return (
      <div className={`h10-ds-acct${className ? ` ${className}` : ''}`}>
        <a className="h10-ds-acct-trigger is-muted" href={manageHref}>
          <span className="h10-ds-acct-dot" data-health={error ? 'error' : 'unknown'} aria-hidden />
          <span className="h10-ds-acct-summary">{error ? 'Accounts unavailable' : 'No accounts connected'}</span>
        </a>
      </div>
    )
  }

  return (
    <div className={`h10-ds-acct${className ? ` ${className}` : ''}`} ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="h10-ds-acct-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Connected accounts: ${summary}`}
        onClick={toggle}
      >
        {channelPills.map((p) => (
          <span key={p.channel} className="h10-ds-acct-pill" data-channel={p.channel}>
            <span className="h10-ds-acct-dot" data-health={p.health} aria-hidden />
            {channelName(p.channel)}
            {p.count > 1 && <span className="h10-ds-acct-pill-n">{p.count}</span>}
          </span>
        ))}
        <svg className="h10-ds-acct-caret" viewBox="0 0 12 12" aria-hidden width="12" height="12">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="h10-ds-acct-panel" role="dialog" aria-label="Connected accounts">
          <div className="h10-ds-acct-panel-head">
            <span>Connected accounts</span>
            <span className="h10-ds-acct-count">{accounts.length}</span>
          </div>

          {grouped.map(([channel, rows]) => (
            <div key={channel} className="h10-ds-acct-group">
              <div className="h10-ds-acct-group-head">{channelName(channel)}</div>
              {rows.map((a) => (
                <div key={a.id} className="h10-ds-acct-row" data-primary={a.isPrimary || undefined}>
                  <span className="h10-ds-acct-dot" data-health={a.health} aria-hidden />
                  <span className="h10-ds-acct-row-main">
                    <span className="h10-ds-acct-row-label">{primaryLabel(a)}</span>
                    <span className="h10-ds-acct-row-sub">
                      {a.labelIsPlaceholder ? (
                        // Naming what we actually hold, rather than dressing it up.
                        <>
                          {a.labelSource === 'sellerId' ? 'Seller ID' : 'No display name'} · <code>{a.label}</code>
                        </>
                      ) : (
                        <>{HEALTH_TEXT[a.health]}</>
                      )}
                      {a.managedBy === 'env' && <span className="h10-ds-acct-tag">env-managed</span>}
                    </span>
                    {a.healthReason && (
                      <span className="h10-ds-acct-row-warn" data-tone={a.health}>
                        {a.healthReason}
                      </span>
                    )}
                    {a.markets.length > 0 && (
                      <span className="h10-ds-acct-markets">
                        {a.markets.map((m) => (
                          <span key={m} className="h10-ds-acct-market">
                            {m}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ))}

          {notConnected.length > 0 && (
            <div className="h10-ds-acct-group">
              <div className="h10-ds-acct-group-head">Not connected</div>
              {notConnected.map((c) => (
                <a key={c} className="h10-ds-acct-row is-link" href={manageHref}>
                  <span className="h10-ds-acct-dot" data-health="off" aria-hidden />
                  <span className="h10-ds-acct-row-main">
                    <span className="h10-ds-acct-row-label">{channelName(c)}</span>
                    <span className="h10-ds-acct-row-sub">Connect →</span>
                  </span>
                </a>
              ))}
            </div>
          )}

          <div className="h10-ds-acct-foot">
            <a href={manageHref}>Manage channels</a>
          </div>
        </div>
      )}
    </div>
  )
}
