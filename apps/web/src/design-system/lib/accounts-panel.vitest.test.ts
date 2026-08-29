/**
 * The honest row (CX.2 §2), per `authStatus` × drift × managedBy — asserted on the model the
 * component places verbatim. apps/web's vitest is node-only (no jsdom, no React plugin), so the
 * one thing NOT covered here is the click→state→render hop inside AccountsPanel.tsx.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  NOT_TRACKED_REASON,
  authStatusPill,
  errorLineVisible,
  lastSyncText,
  permissionsLine,
  reconnectLabel,
  relativeTime,
  rowActions,
  runHeartbeat,
  scopeChipLabel,
  timestampText,
  timestampTitle,
  visibleScopes,
} from './accounts-panel'

const NOW = Date.parse('2026-08-29T12:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const STATUSES = ['connected', 'degraded', 'needs_reauth', 'revoked', 'disconnected', 'unknown'] as const

describe('authStatusPill — the §2 table', () => {
  it.each([
    ['connected', 'success', 'Connected'],
    ['degraded', 'warning', 'Degraded — 3 failures'],
    ['needs_reauth', 'danger', 'Sign-in needed'],
    ['revoked', 'danger', 'Access revoked'],
    ['disconnected', 'neutral', 'Disconnected'],
    ['unknown', 'info', 'Not yet checked'],
  ] as const)('%s → %s "%s"', (status, tone, label) => {
    expect(authStatusPill(status, 3)).toEqual({ tone, label })
  })

  it('counts one failure in the singular and zero as plural', () => {
    expect(authStatusPill('degraded', 1).label).toBe('Degraded — 1 failure')
    expect(authStatusPill('degraded').label).toBe('Degraded — 0 failures')
  })

  it('renders a status it has never heard of as itself, neutral — never a friendlier word', () => {
    expect(authStatusPill('suspended')).toEqual({ tone: 'neutral', label: 'suspended' })
  })
})

describe('permissions line + Reconnect label — drift 0 / N, per status, env vs oauth', () => {
  const granted = Array.from({ length: 22 }, (_, i) => `scope.${i}`)

  it.each(STATUSES.flatMap((s) => [[s, 'oauth'], [s, 'env']] as const))(
    '%s / %s — drift 0: "22 permissions granted", Reconnect plain, offered only off-env',
    (_status, managedBy) => {
      expect(permissionsLine(granted, [])).toEqual({ tone: null, text: '22 permissions granted' })
      const actions = rowActions({ isPrimary: true, managedBy, scopeDrift: [] }, true)
      expect(actions.test).toBe(true)
      if (managedBy === 'env') {
        expect(actions.reconnect).toBeNull()
        expect(actions.disconnect).toBe(false)
        expect(actions.envNote).toBe(true)
      } else {
        expect(actions.reconnect).toBe('Reconnect')
        expect(actions.disconnect).toBe(true)
        expect(actions.envNote).toBe(false)
      }
    },
  )

  it.each(STATUSES.flatMap((s) => [[s, 'oauth', 3], [s, 'env', 3], [s, 'oauth', 1]] as const))(
    '%s / %s — drift %i: a warning pill and Reconnect names the shortfall',
    (_status, managedBy, n) => {
      const drift = Array.from({ length: n }, (_, i) => `missing.${i}`)
      const word = n === 1 ? 'permission' : 'permissions'
      expect(permissionsLine(granted, drift)).toEqual({ tone: 'warning', text: `${n} ${word} not granted` })
      const actions = rowActions({ isPrimary: false, managedBy, scopeDrift: drift }, true)
      expect(actions.makePrimary).toBe(true)
      if (managedBy === 'env') expect(actions.reconnect).toBeNull()
      else expect(actions.reconnect).toBe(`Reconnect to grant ${n} ${word}`)
    },
  )

  it('says nothing about permissions when the API predates the lists', () => {
    expect(permissionsLine(undefined, undefined)).toBeNull()
  })

  it('offers no Reconnect when the host gave no handler', () => {
    expect(rowActions({ isPrimary: true, managedBy: 'oauth', scopeDrift: ['a'] }, false).reconnect).toBeNull()
  })

  it('reconnectLabel names the shortfall', () => {
    expect(reconnectLabel(undefined)).toBe('Reconnect')
    expect(reconnectLabel([])).toBe('Reconnect')
    expect(reconnectLabel(['a'])).toBe('Reconnect to grant 1 permission')
    expect(reconnectLabel(['a', 'b'])).toBe('Reconnect to grant 2 permissions')
  })
})

describe('timestamps — never vs not tracked yet', () => {
  it('a tracked null is "never"; an untracked null is "not tracked yet" — and never "never"', () => {
    expect(timestampText(null, 'tracked', NOW)).toBe('never')
    expect(timestampText(null, 'untracked', NOW)).toBe('not tracked yet')
    expect(timestampText(undefined, 'untracked', NOW)).not.toBe('never')
  })

  it('an untracked column with a value reads relative like any other', () => {
    expect(timestampText(iso(5 * 60_000), 'untracked', NOW)).toBe('5 min ago')
  })

  it('title carries the absolute instant, or the reason there is none', () => {
    const at = iso(0)
    expect(timestampTitle('Inbound', at, 'untracked')).toBe(at)
    expect(timestampTitle('Inbound', null, 'untracked')).toBe(NOT_TRACKED_REASON)
    expect(timestampTitle('Refreshed', null)).toBe('Refreshed: never')
  })

  it('keeps lastSyncStatus as text — the dot is gone, the fact is not', () => {
    expect(lastSyncText(iso(3 * 3_600_000), 'error', NOW)).toBe('Last sync 3 h ago (error)')
    expect(lastSyncText(null, null, NOW)).toBe('Last sync never')
  })
})

describe('relativeTime', () => {
  it('reads null as never and words the past in s/min/h/d', () => {
    expect(relativeTime(null, NOW)).toBe('never')
    expect(relativeTime(iso(10_000), NOW)).toBe('just now')
    expect(relativeTime(iso(7 * 60_000), NOW)).toBe('7 min ago')
    expect(relativeTime(iso(5 * 3_600_000), NOW)).toBe('5 h ago')
    expect(relativeTime(iso(3 * 86_400_000), NOW)).toBe('3 d ago')
  })
  it('words the future for an expiry', () => {
    expect(relativeTime(iso(-2 * 3_600_000), NOW)).toBe('in 2 h')
  })
  it('returns an unparsable string as itself rather than NaN', () => {
    expect(relativeTime('not-a-date', NOW)).toBe('not-a-date')
  })
})

describe('scope chips', () => {
  const scope = (i: number) => ({ kind: 'marketplace', externalId: `M${i}`, label: `Market ${i}` })

  it('labels a chip with the channel label, else the raw id — never an invented name', () => {
    expect(scopeChipLabel({ kind: 'marketplace', externalId: 'A1PA6795UKMFR9', label: 'Amazon.de' })).toBe('Amazon.de')
    expect(scopeChipLabel({ kind: 'marketplace', externalId: 'APJ6JRA9NG5V4', label: null })).toBe('APJ6JRA9NG5V4')
  })

  it('caps visible chips at 12 and folds the rest behind "+N more"', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => scope(i))
    const folded = visibleScopes(fifteen, false)
    expect(folded.visible).toHaveLength(12)
    expect(folded.hidden).toBe(3)
    expect(folded.foldable).toBe(true)
    expect(folded.toggleText).toBe('+3 more')
  })

  it('expanding shows every chip and offers "Show fewer"', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => scope(i))
    const open = visibleScopes(fifteen, true)
    expect(open.visible).toHaveLength(15)
    expect(open.hidden).toBe(0)
    expect(open.foldable).toBe(true)
    expect(open.toggleText).toBe('Show fewer')
  })

  it('twelve or fewer: no fold at all', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => scope(i))
    expect(visibleScopes(twelve, false)).toMatchObject({ hidden: 0, foldable: false })
    expect(visibleScopes([], false)).toMatchObject({ visible: [], hidden: 0, foldable: false })
  })
})

describe('error line', () => {
  it('shows the stored lastError only while it explains the status', () => {
    for (const s of ['degraded', 'needs_reauth']) expect(errorLineVisible(s, 'invalid_grant')).toBe(true)
    for (const s of ['connected', 'revoked', 'disconnected', 'unknown', undefined]) {
      expect(errorLineVisible(s, 'invalid_grant')).toBe(false)
    }
    expect(errorLineVisible('degraded', null)).toBe(false)
    expect(errorLineVisible('degraded', '')).toBe(false)
  })
})

describe('runHeartbeat — the Test action', () => {
  const res = (status: number, body: unknown) =>
    ({ ok: status < 400, status, statusText: '', json: async () => body }) as unknown as Response

  it('POSTs the heartbeat URL with credentials and prints "OK · 412 ms"', async () => {
    const fetchMock = vi.fn(async () => res(200, { ok: true, latencyMs: 412, authStatus: 'connected' }))
    const out = await runHeartbeat('https://api.test', 'acc_1', fetchMock as unknown as typeof fetch)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.test/api/cx/connections/acc_1/heartbeat')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(out).toEqual({ ok: true, text: 'OK · 412 ms' })
  })

  it("prints the server's error class and message on a failed beat", async () => {
    const fetchMock = vi.fn(async () => res(200, { ok: false, errorClass: 'auth_expired', message: 'refresh token expired' }))
    const out = await runHeartbeat('https://api.test', 'acc_1', fetchMock as unknown as typeof fetch)
    expect(out).toEqual({ ok: false, text: 'Failed · auth_expired · refresh token expired' })
  })

  it('names the HTTP status when the body carries no class', async () => {
    const fetchMock = vi.fn(async () => res(503, {}))
    const out = await runHeartbeat('https://api.test', 'acc_1', fetchMock as unknown as typeof fetch)
    expect(out).toEqual({ ok: false, text: 'Failed · http_503' })
  })

  it('reports a network failure as one', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const out = await runHeartbeat('https://api.test', 'acc_1', fetchMock as unknown as typeof fetch)
    expect(out).toEqual({ ok: false, text: 'Failed · network · ECONNREFUSED' })
  })
})
