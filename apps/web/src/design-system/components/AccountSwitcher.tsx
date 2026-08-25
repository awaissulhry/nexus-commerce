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
 * ── Switching (MAP.4) ─────────────────────────────────────────────────────
 *
 * A row becomes selectable only when `canSwitch` says a channel actually holds
 * more than one account. A dropdown that cannot change anything is worse than no
 * dropdown, so with one account per channel the rows stay informational.
 *
 * Selecting one rewrites `?account=` **on the route you are already on** — the
 * single most copyable detail in the Rithum recording, whose row hrefs carry
 * `SelectAccount?apid=<id>&url=<the page you were on>`. A switcher that dumps you
 * on a dashboard is a switcher people stop using.
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
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { accountIdentity } from '../tokens/colors'
import '../styles/tokens.css'
import '../styles/components.css'

export type AccountHealth = 'ok' | 'warn' | 'error' | 'unknown'

/**
 * The account-identity palette.
 *
 * A FIXED set, not a free colour picker. The plan's §3.2 asks for account colour
 * to be a token so "the switcher, the flat-file header, the orders inbox and the
 * cross-account console all read the same identity" — a hex an operator can type
 * would drift between surfaces and could land unreadable against either theme.
 * These eight are drawn from the DS palette and checked against both grounds.
 *
 * Stored as hex because that is what `ChannelConnection.accountColor` holds and
 * what the API validates; the UI never offers anything outside this list.
 *
 * The values themselves live in `tokens/colors.ts` (`accountIdentity`) — this is
 * the DS's public alias for them, kept so the existing import path still works.
 */
export const ACCOUNT_COLORS: ReadonlyArray<{ name: string; hex: string }> =
  accountIdentity

export interface AccountRow {
  id: string
  channel: string
  managedBy: string
  label: string
  labelSource: 'accountLabel' | 'storeName' | 'displayName' | 'signInName' | 'sellerId' | 'channel'
  labelIsPlaceholder: boolean
  markets: string[]
  health: AccountHealth
  healthReason: string | null
  isPrimary: boolean
  /** MAP.2a additions. Optional so an older API response still types. */
  sortOrder?: number
  externalAccountId?: string | null
  accountColor?: string | null
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
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const activeAccountId = searchParams?.get('account') ?? null

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
        // The channel's identity colour is its primary account's — with two
        // accounts the panel is where you tell them apart, not the pill.
        color: (rows.find((r) => r.isPrimary) ?? rows[0])?.accountColor ?? null,
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

  /**
   * Switch account WITHOUT leaving the page. Every other query param is kept —
   * a market filter, a search, a sort — because they describe what you were
   * looking at, and only the account changed.
   */
  const switchTo = useCallback(
    (id: string) => {
      const next = new URLSearchParams(searchParams?.toString() ?? '')
      next.set('account', id)
      router.push(`${pathname}?${next.toString()}`)
      setOpen(false)
    },
    [pathname, router, searchParams],
  )

  const canSwitch = data?.canSwitch ?? false
  /** The account in view: the URL's, or each channel's primary when unset. */
  const selectedId = useMemo(() => {
    if (activeAccountId && accounts.some((a) => a.id === activeAccountId)) return activeAccountId
    return null
  }, [activeAccountId, accounts])

  if (loading) {
    return (
      <div className={`nds-acct${className ? ` ${className}` : ''}`}>
        <span className="nds-acct-skeleton" aria-hidden />
      </div>
    )
  }

  // A failed load must not blank the chrome. Say so quietly and stay out of the way.
  if (error || accounts.length === 0) {
    return (
      <div className={`nds-acct${className ? ` ${className}` : ''}`}>
        <a className="nds-acct-trigger is-muted" href={manageHref}>
          <span className="nds-acct-dot" data-health={error ? 'error' : 'unknown'} aria-hidden />
          <span className="nds-acct-summary">{error ? 'Accounts unavailable' : 'No accounts connected'}</span>
        </a>
      </div>
    )
  }

  return (
    <div className={`nds-acct${className ? ` ${className}` : ''}`} ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="nds-acct-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Connected accounts: ${summary}`}
        onClick={toggle}
      >
        {channelPills.map((p) => (
          <span
            key={p.channel}
            className="nds-acct-pill"
            data-channel={p.channel}
            // A left edge rather than a fill: the pill's own text contrast is
            // already verified against the panel ground, and tinting the whole
            // pill would put arbitrary text on an arbitrary colour.
            style={p.color ? { boxShadow: `inset 3px 0 0 0 ${p.color}` } : undefined}
          >
            <span className="nds-acct-dot" data-health={p.health} aria-hidden />
            {channelName(p.channel)}
            {p.count > 1 && <span className="nds-acct-pill-n">{p.count}</span>}
          </span>
        ))}
        <svg className="nds-acct-caret" viewBox="0 0 12 12" aria-hidden width="12" height="12">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="nds-acct-panel" role="dialog" aria-label="Connected accounts">
          <div className="nds-acct-panel-head">
            <span>Connected accounts</span>
            <span className="nds-acct-count">{accounts.length}</span>
          </div>

          {grouped.map(([channel, rows]) => (
            <div key={channel} className="nds-acct-group">
              <div className="nds-acct-group-head">{channelName(channel)}</div>
              {rows.map((a) => {
                const isSelected = selectedId ? a.id === selectedId : a.isPrimary
                const RowTag = (canSwitch ? 'button' : 'div') as 'button' | 'div'
                return (
                <RowTag
                  key={a.id}
                  type={canSwitch ? 'button' : undefined}
                  className={`nds-acct-row${canSwitch ? ' is-link' : ''}`}
                  data-primary={a.isPrimary || undefined}
                  data-selected={isSelected || undefined}
                  aria-current={canSwitch && isSelected ? 'true' : undefined}
                  onClick={canSwitch ? () => switchTo(a.id) : undefined}
                >
                  <span className="nds-acct-dot" data-health={a.health} aria-hidden />
                  {a.accountColor && (
                    <span
                      className="nds-acct-swatch"
                      style={{ background: a.accountColor }}
                      aria-hidden
                    />
                  )}
                  <span className="nds-acct-row-main">
                    <span className="nds-acct-row-label">{primaryLabel(a)}</span>
                    <span className="nds-acct-row-sub">
                      {a.labelIsPlaceholder ? (
                        // Naming what we actually hold, rather than dressing it up.
                        <>
                          {a.labelSource === 'sellerId' ? 'Seller ID' : 'No display name'} · <code>{a.label}</code>
                        </>
                      ) : (
                        <>{HEALTH_TEXT[a.health]}</>
                      )}
                      {a.managedBy === 'env' && <span className="nds-acct-tag">env-managed</span>}
                    </span>
                    {a.healthReason && (
                      <span className="nds-acct-row-warn" data-tone={a.health}>
                        {a.healthReason}
                      </span>
                    )}
                    {a.markets.length > 0 && (
                      <span className="nds-acct-markets">
                        {a.markets.map((m) => (
                          <span key={m} className="nds-acct-market">
                            {m}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  {canSwitch && isSelected && (
                    <span className="nds-acct-check" aria-hidden>
                      ✓
                    </span>
                  )}
                </RowTag>
                )
              })}
            </div>
          ))}

          {notConnected.length > 0 && (
            <div className="nds-acct-group">
              <div className="nds-acct-group-head">Not connected</div>
              {notConnected.map((c) => (
                <a key={c} className="nds-acct-row is-link" href={manageHref}>
                  <span className="nds-acct-dot" data-health="off" aria-hidden />
                  <span className="nds-acct-row-main">
                    <span className="nds-acct-row-label">{channelName(c)}</span>
                    <span className="nds-acct-row-sub">Connect →</span>
                  </span>
                </a>
              ))}
            </div>
          )}

          <div className="nds-acct-foot">
            <a href={manageHref}>Manage channels</a>
          </div>
        </div>
      )}
    </div>
  )
}
