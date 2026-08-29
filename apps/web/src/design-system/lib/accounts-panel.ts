/**
 * AccountsPanel row model (CX.2 §2) — every decision the honest row makes, as pure functions.
 *
 * The component (`components/AccountsPanel.tsx`) is thin over these: it places what they return.
 * They live here, not in the .tsx, so the behaviour is testable in apps/web's node-only vitest
 * (no jsdom, no React plugin — vitest.config.ts says why) and so the wording of a status, a
 * timestamp or a permissions line has exactly one home.
 *
 * Input types are STRUCTURAL and minimal on purpose: `AccountRow` satisfies them, and the model
 * never imports a component.
 */
import type { Tone } from '../primitives/tone'

export interface StatusPill {
  tone: Tone
  label: string
}

/**
 * The status pill for an `authStatus` — the §2 table. Any other string the API may grow into
 * renders neutral with the raw value: an unknown status is still a fact, and inventing a
 * friendlier word for it would not be.
 */
export function authStatusPill(authStatus: string, consecutiveFailures = 0): StatusPill {
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
    case 'unknown':
      return { tone: 'info', label: 'Not yet checked' }
    default:
      return { tone: 'neutral', label: authStatus }
  }
}

/** The Reconnect label — names the shortfall when the grant is behind the catalogue. */
export function reconnectLabel(scopeDrift: string[] | undefined): string {
  const n = scopeDrift?.length ?? 0
  return n > 0 ? `Reconnect to grant ${n} permission${n === 1 ? '' : 's'}` : 'Reconnect'
}

export interface PermissionsLine {
  /** `warning` = a pill; `null` = plain text. */
  tone: 'warning' | null
  text: string
}

/**
 * "22 permissions granted", or a warning "N permissions not granted" when the grant is behind
 * the catalogue. `null` when the API sent neither list (pre-CX.1).
 */
export function permissionsLine(
  grantedScopes: string[] | undefined,
  scopeDrift: string[] | undefined,
): PermissionsLine | null {
  const drift = scopeDrift?.length ?? 0
  if (drift > 0) return { tone: 'warning', text: `${drift} permission${drift === 1 ? '' : 's'} not granted` }
  if (!grantedScopes) return null
  const n = grantedScopes.length
  return { tone: null, text: `${n} permission${n === 1 ? '' : 's'} granted` }
}

/**
 * Relative wording for an ISO timestamp. `null` is "never" — the column exists and nothing has
 * written it. A column NOTHING writes yet goes through `timestampText(…, 'untracked')` instead:
 * "never" would be a lie about it.
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const diff = now - t
  const abs = Math.abs(diff)
  const future = diff < 0
  const s = Math.round(abs / 1000)
  if (s < 45) return future ? 'in a moment' : 'just now'
  const m = Math.round(abs / 60_000)
  if (m < 60) return future ? `in ${m} min` : `${m} min ago`
  const h = Math.round(abs / 3_600_000)
  if (h < 24) return future ? `in ${h} h` : `${h} h ago`
  const d = Math.round(abs / 86_400_000)
  return future ? `in ${d} d` : `${d} d ago`
}

/**
 * `tracked` — a column something writes; `null` reads "never".
 * `untracked` — `lastInboundAt` / `lastOutboundAt`, which have NO writer until CX.4; `null`
 * reads "not tracked yet" because nobody is counting, not because nothing happened.
 */
export type StampKind = 'tracked' | 'untracked'

export const NOT_TRACKED_TEXT = 'not tracked yet'
export const NOT_TRACKED_REASON = 'No receiver or sender writes this column until CX.4'

export function timestampText(
  iso: string | null | undefined,
  kind: StampKind = 'tracked',
  now: number = Date.now(),
): string {
  if (!iso && kind === 'untracked') return NOT_TRACKED_TEXT
  return relativeTime(iso, now)
}

/** The `title` behind a stamp: the absolute instant, or the reason there is none. */
export function timestampTitle(label: string, iso: string | null | undefined, kind: StampKind = 'tracked'): string {
  if (iso) return iso
  return kind === 'untracked' ? NOT_TRACKED_REASON : `${label}: never`
}

/** "Last sync 3 h ago (ok)" — the old health dot encoded `lastSyncStatus`; the text keeps it. */
export function lastSyncText(
  lastSyncAt: string | null | undefined,
  lastSyncStatus: string | null | undefined,
  now: number = Date.now(),
): string {
  return `Last sync ${relativeTime(lastSyncAt, now)}${lastSyncStatus ? ` (${lastSyncStatus})` : ''}`
}

export interface ScopeRow {
  kind: string
  externalId: string
  label: string | null
}

/** How many scope chips a row shows before folding the rest behind "+N more". */
export const SCOPE_CHIP_CAP = 12

/** A chip's text: the channel's label when it gave one, else the raw id — never invented. */
export function scopeChipLabel(s: ScopeRow): string {
  return s.label ?? s.externalId
}

export interface VisibleScopes {
  visible: ScopeRow[]
  /** Chips folded away (0 when expanded or under the cap). */
  hidden: number
  /** Whether the row needs a fold toggle at all. */
  foldable: boolean
  /** The toggle's text — "+3 more" / "Show fewer". */
  toggleText: string
}

export function visibleScopes(scopes: ScopeRow[], expanded: boolean, cap: number = SCOPE_CHIP_CAP): VisibleScopes {
  const foldable = scopes.length > cap
  const visible = foldable && !expanded ? scopes.slice(0, cap) : scopes
  const hidden = scopes.length - visible.length
  return { visible, hidden, foldable, toggleText: expanded ? 'Show fewer' : `+${hidden} more` }
}

/** The stored `lastError` shows only while it explains the status. */
export function errorLineVisible(authStatus: string | undefined, lastError: string | null | undefined): boolean {
  return !!lastError && (authStatus === 'degraded' || authStatus === 'needs_reauth')
}

export interface RowActions {
  makePrimary: boolean
  /** Always offered — env-managed rows too (Amazon participations call). */
  test: true
  /** The button label, or `null` when the row has no grant to re-authorise. */
  reconnect: string | null
  disconnect: boolean
  /** The "Set by environment" reason in place of Disconnect. */
  envNote: boolean
}

/** Which actions a row offers, and what Reconnect says. */
export function rowActions(
  a: { isPrimary: boolean; managedBy: string; scopeDrift?: string[] },
  hasReconnect: boolean,
): RowActions {
  const env = a.managedBy === 'env'
  return {
    makePrimary: !a.isPrimary,
    test: true,
    reconnect: hasReconnect && !env ? reconnectLabel(a.scopeDrift) : null,
    disconnect: !env,
    envNote: env,
  }
}

export interface HeartbeatOutcome {
  ok: boolean
  /** The inline text the row prints — "OK · 412 ms" / "Failed · auth_expired · …". */
  text: string
}

/**
 * The Test action: one real call to the purpose-built heartbeat endpoint. The server writes
 * `lastHeartbeatAt` and a ledger row; this only reports what came back, in the server's words.
 */
export async function runHeartbeat(
  apiBase: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HeartbeatOutcome> {
  try {
    const res = await fetchImpl(`${apiBase}/api/cx/connections/${id}/heartbeat`, {
      method: 'POST',
      credentials: 'include',
    })
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      latencyMs?: number
      authStatus?: string
      errorClass?: string
      message?: string
      error?: string
    }
    if (json.ok === true) return { ok: true, text: `OK · ${json.latencyMs ?? 0} ms` }
    const cls = json.errorClass ?? (res.ok ? 'unknown' : `http_${res.status}`)
    const msg = json.message ?? json.error ?? res.statusText ?? ''
    return { ok: false, text: `Failed · ${cls}${msg ? ` · ${msg}` : ''}` }
  } catch (err) {
    return { ok: false, text: `Failed · network · ${err instanceof Error ? err.message : 'unreachable'}` }
  }
}
