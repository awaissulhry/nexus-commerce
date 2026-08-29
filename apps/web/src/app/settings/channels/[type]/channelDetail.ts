/**
 * /settings/channels/[type] — the pure half of the detail page (CX.2 §5).
 *
 * Types mirror `apps/api/src/routes/connections.routes.ts`; every helper here is JSX-free so the
 * node-only web suite (`vitest.config.ts`: no jsdom, no React plugin, `jsx: preserve`) can
 * import it. `ChannelDetailClient.tsx` is thin over these.
 */

import { getBackendUrl } from '@/lib/backend-url'

// ─── Contract ────────────────────────────────────────────────────────────

export type AuthStatus =
  | 'connected'
  | 'degraded'
  | 'needs_reauth'
  | 'revoked'
  | 'disconnected'
  | 'unknown'

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface ChannelConnection {
  id: string
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'
  isActive: boolean
  isManagedBy: 'oauth' | 'env' | 'pending'
  sellerName: string | null
  storeName: string | null
  storeFrontUrl: string | null
  /** Legacy expiry column — `accessTokenExpiresAt` is the CX.1 one; both are real. */
  tokenExpiresAt: string | null
  lastSyncAt: string | null
  lastSyncStatus: string | null
  lastSyncError: string | null
  createdAt: string
  updatedAt: string
  // ── CX.1 — the measured connection core ──
  authStatus: AuthStatus | string
  region: string | null
  grantedScopes: string[]
  scopeDrift: string[]
  accessTokenExpiresAt: string | null
  refreshTokenExpiresAt: string | null
  lastRefreshAt: string | null
  lastHeartbeatAt: string | null
  lastInboundAt: string | null
  lastOutboundAt: string | null
  lastErrorAt: string | null
  lastError: string | null
  consecutiveFailures: number
  identity: Record<string, unknown> | null
}

/** One `ConnectionScope` row — a market the channel says this account participates in. */
export interface ConnectionScopeRow {
  kind: string
  externalId: string
  label: string | null
  isActive: boolean
}

export interface RecentEvent {
  id: string
  eventType: string
  externalId: string
  isProcessed: boolean
  processedAt: string | null
  error: string | null
  createdAt: string
}

export interface ChannelDetail {
  connection: ChannelConnection
  /** CX.1 — what the grant actually carries (captured at consent, re-read by the heartbeat). */
  scopes: string[]
  /** CX.1 — what the catalogue wants that this grant lacks; non-empty ⇒ reconnect to grant them. */
  scopeDrift?: string[]
  /** CX.1 — `ConnectionScope` rows: measured participation, never the allowlist. */
  connectionScopes?: ConnectionScopeRow[]
  activeMarketplaces: string[]
  meta: Record<string, unknown> | null
  recentEvents: RecentEvent[]
  eventStats: {
    total: number
    success: number
    failed: number
    pending: number
  }
}

export const CHANNEL_LABEL: Record<string, string> = {
  amazon: 'Amazon',
  ebay: 'eBay',
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  etsy: 'Etsy',
}

export function channelLabel(channelType: string): string {
  return CHANNEL_LABEL[channelType] ?? channelType
}

/**
 * The codes `PATCH /marketplaces` accepts (its `ALLOWED_MARKETPLACES`). The API does not return
 * this set, so the grid that WRITES through that endpoint has to know it. It is labelled on the
 * page as exactly that — the set the API accepts — and never as what the account participates
 * in; participation is the `connectionScopes` rows.
 */
export const SCOPE_CODES_THE_API_ACCEPTS: Record<string, string[]> = {
  amazon: ['IT', 'DE', 'FR', 'ES', 'UK'],
  ebay: ['IT', 'DE', 'FR', 'ES', 'UK'],
  shopify: [],
  woocommerce: [],
  etsy: [],
}

const COUNTRY_NAMES: Record<string, string> = {
  IT: 'Italy',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  UK: 'United Kingdom',
}

/** Shared with the loading skeleton so the two states do not jump. */
export const PAGE_MAX_WIDTH = 880

// ─── Status ──────────────────────────────────────────────────────────────

/** CX.2 §2 — the one status vocabulary, from `authStatus` and nothing else. */
export function statusPill(
  authStatus: string,
  consecutiveFailures: number,
): { tone: Tone; label: string } {
  switch (authStatus) {
    case 'connected':
      return { tone: 'success', label: 'Connected' }
    case 'degraded':
      return {
        tone: 'warning',
        label: `Degraded — ${consecutiveFailures} failure${consecutiveFailures === 1 ? '' : 's'}`,
      }
    case 'needs_reauth':
      return { tone: 'danger', label: 'Sign-in needed' }
    case 'revoked':
      return { tone: 'danger', label: 'Access revoked' }
    case 'disconnected':
      return { tone: 'neutral', label: 'Disconnected' }
    default:
      return { tone: 'info', label: 'Not yet checked' }
  }
}

export const MANAGED_BY: Record<ChannelConnection['isManagedBy'], string> = {
  oauth: 'OAuth sign-in',
  env: 'Environment credentials',
  pending: 'Nothing connected',
}

export const SYNC_TONE: Record<string, Tone> = {
  SUCCESS: 'success',
  PARTIAL: 'warning',
  FAILED: 'danger',
}

/** The stored `lastError` is shown only while the status says something is wrong. */
export function showLastError(connection: ChannelConnection): boolean {
  return (
    !!connection.lastError &&
    (connection.authStatus === 'degraded' || connection.authStatus === 'needs_reauth')
  )
}

/** The line under the title: who this grant is, or why there is nobody. */
export function identityLine(connection: ChannelConnection): string {
  return (
    connection.sellerName ??
    connection.storeName ??
    (connection.isManagedBy === 'env'
      ? 'Set by environment'
      : connection.isManagedBy === 'pending'
        ? 'No account connected'
        : '—')
  )
}

// ─── Timestamps ──────────────────────────────────────────────────────────

/** "in 3h 12m" / "2d 2h ago" / "just now" — the absolute ISO goes in `title` beside it. */
export function relativeWhen(iso: string, now: number = Date.now()): string {
  const delta = new Date(iso).getTime() - now
  if (Number.isNaN(delta)) return iso
  const abs = Math.abs(delta)
  const min = Math.floor(abs / 60_000)
  const hr = Math.floor(abs / 3_600_000)
  const day = Math.floor(abs / 86_400_000)
  let body: string
  if (min < 1) return delta >= 0 ? 'in under a minute' : 'just now'
  else if (hr < 1) body = `${min}m`
  else if (day < 1) body = `${hr}h ${min % 60}m`
  else if (day < 30) body = `${day}d ${hr % 24}h`
  else body = `${Math.floor(day / 30)}mo`
  return delta >= 0 ? `in ${body}` : `${body} ago`
}

export interface WhenCell {
  text: string
  /** Absolute ISO — present only when there is a real timestamp. */
  title?: string
  /** True when the timestamp is in the past — an expiry that has already lapsed. */
  past?: boolean
}

/**
 * What a null means depends on the column:
 *   event     — nothing has happened yet → "never"
 *   expiry    — no expiry is stored → "not recorded" ("never expires" would be a lie)
 *   untracked — no writer exists until CX.4 (`lastInboundAt` / `lastOutboundAt`) → "not tracked yet"
 */
export type TimestampKind = 'event' | 'expiry' | 'untracked'

export const NULL_TEXT: Record<TimestampKind, string> = {
  event: 'never',
  expiry: 'not recorded',
  untracked: 'not tracked yet',
}

/** A timestamp cell: relative text + absolute title; `null` renders the kind's null text. */
export function timestampText(
  iso: string | null,
  kind: TimestampKind,
  now: number = Date.now(),
): WhenCell {
  if (!iso) return { text: NULL_TEXT[kind] }
  return {
    text: relativeWhen(iso, now),
    title: iso,
    past: new Date(iso).getTime() < now,
  }
}

// ─── Permissions ─────────────────────────────────────────────────────────

/** CX.2 §2 — the permissions description. */
export function permissionsCopy(granted: number, drift: number): string {
  if (granted === 0 && drift === 0) {
    return 'No permissions recorded for this grant — Reconnect to capture what the channel actually granted.'
  }
  if (drift > 0) {
    return `${granted} granted · ${drift} not granted — reconnect to grant them.`
  }
  return `${granted} permission${granted === 1 ? '' : 's'} granted — every permission this channel asks for.`
}

/** §2 — the Reconnect button is relabelled while there is drift. */
export function reconnectLabel(drift: number): string {
  return drift > 0 ? `Reconnect to grant ${drift} permission${drift === 1 ? '' : 's'}` : 'Reconnect'
}

// ─── Holds (U13: a control that refuses must say why) ───────────────────

export type Hold = { held: false } | { held: true; reason: string }

export function reconnectHold(channelType: string, connection: ChannelConnection): Hold {
  const label = channelLabel(channelType)
  if (connection.channel !== 'EBAY') {
    return { held: true, reason: `Reconnect for ${label} arrives with CX.3` }
  }
  if (connection.isManagedBy === 'pending') {
    return {
      held: true,
      reason: `No ${label} account is connected yet — use Channels → Connect to sign in.`,
    }
  }
  return { held: false }
}

export function testHold(channelType: string, connection: ChannelConnection): Hold {
  const label = channelLabel(channelType)
  if (connection.isManagedBy === 'pending') {
    return { held: true, reason: `Nothing to test — no ${label} account is connected.` }
  }
  return { held: false }
}

export function disconnectHold(channelType: string, connection: ChannelConnection): Hold {
  const label = channelLabel(channelType)
  if (connection.isManagedBy === 'pending') {
    return { held: true, reason: `Nothing to disconnect — no ${label} account is connected.` }
  }
  if (connection.isManagedBy === 'env') {
    return {
      held: true,
      reason: `${label} is set by environment — remove its credentials from the API environment to disconnect it.`,
    }
  }
  return { held: false }
}

// ─── Marketplaces ────────────────────────────────────────────────────────

export interface MarketplaceOption {
  code: string
  name: string
}

/** The CheckboxCard grid's options — the codes the PATCH endpoint accepts for this channel. */
export function marketplaceOptions(channelType: string): MarketplaceOption[] {
  return (SCOPE_CODES_THE_API_ACCEPTS[channelType] ?? []).map((code) => ({
    code,
    name: COUNTRY_NAMES[code] ?? code,
  }))
}

/** Toggle one code in the draft; the draft stays sorted so dirtiness compares by set. */
export function toggleMarketplace(draft: string[], code: string): string[] {
  return draft.includes(code) ? draft.filter((x) => x !== code) : [...draft, code].sort()
}

export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((m) => set.has(m))
}

/** The PATCH body — normalised the way the API normalises (upper-cased, deduped, sorted). */
export function marketplacesPatchBody(selected: string[]): { marketplaces: string[] } {
  return {
    marketplaces: Array.from(new Set(selected.map((m) => m.toUpperCase()))).sort(),
  }
}

export function marketplacesDescription(channelType: string, draft: string[]): string {
  if (marketplaceOptions(channelType).length === 0) {
    return `${channelLabel(channelType)} is a single-store channel — there are no marketplaces to scope.`
  }
  if (draft.length === 0) {
    return 'No markets selected — the API treats an empty scope as ALL markets. Pick markets to scope syncs and listings.'
  }
  return `Syncs and listings scoped to ${draft.length} market${draft.length === 1 ? '' : 's'}.`
}

// ─── Events ──────────────────────────────────────────────────────────────

export function eventTone(e: RecentEvent): { tone: Tone; label: string } {
  if (e.error) return { tone: 'danger', label: 'failed' }
  if (e.isProcessed) return { tone: 'success', label: 'ok' }
  return { tone: 'warning', label: 'pending' }
}

// ─── Calls ───────────────────────────────────────────────────────────────

/** What the header shows after an action — a real result, never a guess. */
export interface ActionNote {
  tone: Tone
  text: string
}

interface HeartbeatResponse {
  success?: boolean
  latencyMs?: number
  errorClass?: string
  message?: string
  error?: string
}

/** Test — runs the catalogue heartbeat now; `lastHeartbeatAt` advances on the row. */
export async function runHeartbeat(
  connectionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ActionNote> {
  const res = await fetchImpl(
    `${getBackendUrl()}/api/cx/connections/${connectionId}/heartbeat`,
    { method: 'POST', credentials: 'include' },
  )
  const data = (await res.json().catch(() => null)) as HeartbeatResponse | null
  if (res.ok && data?.success) {
    return { tone: 'success', text: `OK · ${Math.round(data.latencyMs ?? 0)} ms` }
  }
  const cls = data?.errorClass ?? `HTTP ${res.status}`
  const msg = data?.message ?? data?.error ?? 'no detail returned'
  return { tone: 'danger', text: `Failed · ${cls} · ${msg}` }
}

/** Reconnect — asks the API for the eBay consent URL for THIS connection. */
export async function startReconnect(
  connectionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ authUrl: string } | { error: string }> {
  const res = await fetchImpl(`${getBackendUrl()}/api/cx/connect/ebay/start`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent: 'reconnect', targetConnectionId: connectionId }),
  })
  const data = (await res.json().catch(() => null)) as
    | { authUrl?: string; error?: string }
    | null
  if (res.ok && data?.authUrl) return { authUrl: data.authUrl }
  return { error: data?.error ?? `HTTP ${res.status}` }
}

/** Disconnect — the one path; the API revokes at the channel and archives the grant. */
export async function disconnectAccount(
  connectionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { error: string }> {
  const res = await fetchImpl(`${getBackendUrl()}/api/accounts/${connectionId}/disconnect`, {
    method: 'POST',
    credentials: 'include',
  })
  if (res.ok) return { ok: true }
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return { error: data?.error ?? `HTTP ${res.status}` }
}

/** The save bar's write — same endpoint and body as before. */
export async function patchMarketplaces(
  channelType: string,
  marketplaces: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(
    `${getBackendUrl()}/api/settings/channels/${channelType}/marketplaces`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(marketplacesPatchBody(marketplaces)),
    },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${res.status}`)
  }
}

export async function fetchDetail(
  channelType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ChannelDetail> {
  const res = await fetchImpl(`${getBackendUrl()}/api/settings/channels/${channelType}/detail`, {
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as ChannelDetail
}
