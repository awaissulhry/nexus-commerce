/**
 * RPT.15 — share link security properties.
 *
 * These were originally verified by a throwaway script against prod, which
 * proved the behaviour once and then protected nothing. A share link is the only
 * unauthenticated path into the reporting engine, so its guarantees have to be
 * enforced on every push, not confirmed once by hand.
 *
 * The properties under test are the ones whose failure is a data leak rather
 * than a bug: no raw token at rest, no export mode, no oracle in the denial
 * message, and expiry/revocation honoured per request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let shareCreate = vi.fn()
let shareFindUnique = vi.fn()
let shareUpdate = vi.fn()
let ranQueries: Array<Record<string, unknown>> = []

vi.mock('../../db.js', () => ({
  default: {
    reportShareLink: {
      get create() { return shareCreate },
      get findUnique() { return shareFindUnique },
      get update() { return shareUpdate },
      findMany: vi.fn(async () => []),
    },
  },
}))

vi.mock('./ads-report-runner.service.js', () => ({
  getSpec: (id: string) => {
    if (id !== 'campaign') throw new Error(`Unknown report "${id}"`)
    return { id, title: 'Campaign performance' }
  },
  runReport: vi.fn(async (q: Record<string, unknown>) => {
    ranQueries.push(q)
    return { rows: [], total: 0, elapsedMs: 1 }
  }),
}))

const svc = await import('./ads-report-shares.service.js')

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'l1', reportId: 'campaign', label: null,
  query: { reportId: 'campaign', page: 1, pageSize: 50 },
  expiresAt: new Date(Date.now() + 86_400_000),
  revokedAt: null, viewCount: 0, lastViewedAt: null, createdAt: new Date(),
  tokenHash: 'unused', ...over,
})

beforeEach(() => {
  ranQueries = []
  shareCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data))
  shareFindUnique = vi.fn(async () => null)
  shareUpdate = vi.fn(async () => row())
})

describe('token handling', () => {
  it('never stores the raw token — only a sha256 hash', async () => {
    const { token } = await svc.createShareLink({
      reportId: 'campaign', query: { reportId: 'campaign' } as never,
    })
    const stored = shareCreate.mock.calls[0][0].data
    expect(JSON.stringify(stored)).not.toContain(token)
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('mints high-entropy, non-repeating tokens', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 25; i++) {
      const { token } = await svc.createShareLink({ reportId: 'campaign', query: { reportId: 'campaign' } as never })
      expect(token.length).toBeGreaterThanOrEqual(40)
      seen.add(token)
    }
    expect(seen.size).toBe(25)
  })
})

describe('the frozen query can never reach export mode', () => {
  // runReport treats `page == null` as EXPORT and streams the whole result set.
  // A public link that hit that path would be a full-table dump.
  it('forces a page at creation even when none was supplied', async () => {
    await svc.createShareLink({ reportId: 'campaign', query: { reportId: 'campaign' } as never })
    const stored = shareCreate.mock.calls[0][0].data.query as Record<string, unknown>
    expect(stored.page).toBe(1)
    expect(stored.pageSize).toBeLessThanOrEqual(200)
  })

  it('re-forces a page at read time for rows stored without one', async () => {
    const { token } = await svc.createShareLink({ reportId: 'campaign', query: { reportId: 'campaign' } as never })
    // A row predating the clamp, or written by any future path.
    shareFindUnique = vi.fn(async () => row({ query: { reportId: 'campaign' } }))
    await svc.resolveShareLink(token)
    expect(ranQueries[0].page).toBe(1)
    expect(ranQueries[0].page).not.toBeNull()
  })

  it('caps an oversized page size', async () => {
    await svc.createShareLink({ reportId: 'campaign', query: { reportId: 'campaign', pageSize: 100000 } as never })
    const stored = shareCreate.mock.calls[0][0].data.query as Record<string, unknown>
    expect(stored.pageSize).toBe(200)
  })
})

describe('denial is uniform and gives away nothing', () => {
  const messages: string[] = []
  const capture = async (fn: () => Promise<unknown>) => {
    try { await fn(); return 'RESOLVED' } catch (e) { const m = (e as Error).message; messages.push(m); return m }
  }

  it('returns an identical message for unknown, revoked and expired', async () => {
    const { token } = await svc.createShareLink({ reportId: 'campaign', query: { reportId: 'campaign' } as never })

    shareFindUnique = vi.fn(async () => null)
    const unknown = await capture(() => svc.resolveShareLink(token))

    shareFindUnique = vi.fn(async () => row({ revokedAt: new Date() }))
    const revoked = await capture(() => svc.resolveShareLink(token))

    shareFindUnique = vi.fn(async () => row({ expiresAt: new Date(Date.now() - 1000) }))
    const expired = await capture(() => svc.resolveShareLink(token))

    expect(unknown).not.toBe('RESOLVED')
    expect(revoked).toBe(unknown)
    expect(expired).toBe(unknown)
  })

  it('rejects a malformed token without touching the database', async () => {
    const r = await capture(() => svc.resolveShareLink('abc'))
    expect(r).not.toBe('RESOLVED')
    expect(shareFindUnique).not.toHaveBeenCalled()
  })
})

describe('creation validation', () => {
  it('refuses an unknown report before minting anything', async () => {
    await expect(svc.createShareLink({ reportId: 'nope', query: {} as never })).rejects.toThrow()
    expect(shareCreate).not.toHaveBeenCalled()
  })

  it.each([0, -1, 91, 100000, Number.NaN])('refuses ttlDays=%s', async (ttl) => {
    await expect(
      svc.createShareLink({ reportId: 'campaign', query: { reportId: 'campaign' } as never, ttlDays: ttl }),
    ).rejects.toThrow()
  })

  it('accepts the documented bounds', async () => {
    await expect(
      svc.createShareLink({ reportId: 'campaign', query: { reportId: 'campaign' } as never, ttlDays: 90 }),
    ).resolves.toBeTruthy()
  })
})

describe('a resolved link exposes only the report', () => {
  it('returns no owner, user id or token', async () => {
    const { token } = await svc.createShareLink({ reportId: 'campaign', query: { reportId: 'campaign' } as never })
    shareFindUnique = vi.fn(async () => row())
    const out = await svc.resolveShareLink(token)
    const serialised = JSON.stringify(out)
    expect(serialised).not.toContain('createdBy')
    expect(serialised).not.toContain('tokenHash')
    expect(serialised).not.toContain(token)
    expect(Object.keys(out).sort()).toEqual(['expiresAt', 'label', 'reportId', 'result', 'title'])
  })
})
