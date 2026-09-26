import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { FEATURES as F } from '@nexus/shared/permissions'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'
import { withWorkspace } from '../lib/workspace-context.js'

const state = vi.hoisted(() => ({ account: vi.fn(), issues: vi.fn() }))
vi.mock('../db.js', () => ({ default: {
  channelConnection: { findUnique: state.account }, listingIssue: { findMany: state.issues },
} }))
vi.mock('../jobs/cx-heartbeat.job.js', () => ({ runHeartbeatFor: vi.fn() }))
vi.mock('../services/cx/token.service.js', () => ({ refreshNow: vi.fn(), revoke: vi.fn(), RefreshFailed: class extends Error {}, RefreshContended: class extends Error {} }))
vi.mock('../services/cx/ingress/ebay-admission.js', () => ({ listOwnEbayQuarantine: vi.fn(), adoptEbayQuarantine: vi.fn(), EbayAdmissionError: class extends Error {} }))
const { default: routes } = await import('./cx-connections.routes.js')
const app = Fastify(), base = '/api/cx/connections/account-a/listing-issues'
const time = new Date('2026-09-25T00:00:00.000Z')
const row = (id: string) => ({ id, listingId: 'listing-a', code: '90220', severity: 'ERROR', message: 'Size is required.',
  attributeNames: ['size'], categories: ['MISSING_ATTRIBUTE'], source: 'amazon-feed',
  firstSeenAt: time, lastSeenAt: time, occurredAt: null,
  channelListing: { id: 'listing-a', productId: 'product-a', marketplace: 'IT', externalListingId: 'external-a', product: { sku: 'JACKET-A' } },
  credentialsEnc: 'private-extra-field',
})
beforeAll(async () => {
  app.addHook('onRequest', (_request, _reply, done) => withWorkspace({ workspaceId: 'workspace-a', actorUserId: 'user-a', membershipId: 'member-a', roleKeys: ['OWNER'] }, done))
  await app.register(routes, { prefix: '/api' }); await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  vi.resetAllMocks()
  state.account.mockResolvedValue({ id: 'account-a', channelType: 'AMAZON', credentialsEnc: 'private-account' })
  state.issues.mockImplementation(async ({ take }: { take: number }) => [row('issue-a'), row('issue-b')].slice(0, take))
})

it('keeps the stored read behind the integrations permission', () => {
  expect(permissionForRoute('GET', base)).toBe(F.settingsIntegrationsManage)
})
it('returns a bounded public projection and a continuation cursor without credentials', async () => {
  const response = await app.inject(`${base}?take=1&workspaceId=ignored-foreign-workspace`)
  expect(response.statusCode).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.json()).toMatchObject({ connectionId: 'account-a', workspaceId: 'workspace-a', channel: 'AMAZON',
    items: [{ id: 'issue-a', listingId: 'listing-a', productId: 'product-a', productSku: 'JACKET-A', code: '90220', message: 'Size is required.', occurredAt: null }],
    nextCursor: expect.any(String), readAt: expect.any(String),
  })
  expect(response.json().items).toHaveLength(1)
  expect(response.body).not.toMatch(/credentialsEnc|private-extra-field|private-account/)
})
it('returns an honest empty stored result with no healthy verdict', async () => {
  state.issues.mockResolvedValueOnce([])
  const response = await app.inject(base)
  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject({ items: [], nextCursor: null })
  expect(response.json()).not.toHaveProperty('healthy')
})
it.each(['take=0', 'take=-1', 'take=1.5', 'take=51', 'take=no', 'after=not-a-cursor', 'listingId='])
  ('rejects invalid pagination/filter input before reading issue data: %s', async query => {
    const response = await app.inject(`${base}?${query}`)
    expect(response.statusCode).toBe(400)
    expect(state.issues).not.toHaveBeenCalled()
  })
it('does not read issues for a missing or invisible account', async () => {
  state.account.mockResolvedValueOnce(null)
  expect((await app.inject(base)).statusCode).toBe(404)
  expect(state.issues).not.toHaveBeenCalled()
})
it('does not turn a storage failure into empty findings or disclose the exception', async () => {
  state.issues.mockRejectedValueOnce(new Error('private SQL and credentials'))
  const response = await app.inject(base)
  expect(response.statusCode).toBe(503)
  expect(response.json()).toMatchObject({ code: 'listing_issues_unavailable' })
  expect(response.body).not.toMatch(/private|SQL|credentials/)
})
it('exposes no write operation on the listing-issue read endpoint', async () => {
  const response = await app.inject({ method: 'POST', url: base, payload: { resolveAll: true } })
  expect(response.statusCode).toBe(404)
  expect(state.issues).not.toHaveBeenCalled()
})

it.each([
  { v: 2 }, { workspaceId: 'foreign' }, { connectionId: 'foreign' }, { listingId: 'foreign' },
  { id: '' }, { id: ' '.repeat(257) }, { lastSeenAt: 'invalid' }, { lastSeenAt: '2026-09-25' }, { lastSeenAt: 0 },
])('rejects malformed or retargeted cursor metadata %j', async patch => {
  const cursor = Buffer.from(JSON.stringify({ v: 1, workspaceId: 'workspace-a', connectionId: 'account-a', listingId: null, id: 'issue-a', lastSeenAt: time.toISOString(), ...patch })).toString('base64url')
  expect((await app.inject(`${base}?after=${cursor}`)).statusCode).toBe(400)
  expect(state.issues).not.toHaveBeenCalled()
})
it.each(['take=1&take=2', `listingId=${'a'.repeat(257)}`, 'listingId=%20a', `after=${'a'.repeat(2049)}`, 'after=bnVsbA', 'after=e30'])('refuses malformed query values: %s', async query => {
  expect((await app.inject(`${base}?${query}`)).statusCode).toBe(400)
  expect(state.issues).not.toHaveBeenCalled()
})
it('bounds even an otherwise valid cursor carrying excessive metadata', async () => {
  const cursor = Buffer.from(JSON.stringify({ v: 1, workspaceId: 'workspace-a', connectionId: 'account-a', listingId: null, id: 'issue-a', lastSeenAt: time.toISOString(), extra: 'a'.repeat(2048) })).toString('base64url')
  expect((await app.inject(`${base}?after=${cursor}`)).statusCode).toBe(400)
  expect(state.issues).not.toHaveBeenCalled()
})
