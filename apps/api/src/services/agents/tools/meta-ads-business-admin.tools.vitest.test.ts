/**
 * Meta ads step 42 — set-meta-business-settings, set-meta-business-people, create-meta-system-user (D1 = A). They are READS:
 * no write of any kind reaches Meta (the read client is the only way out, and every call is a GET the real gateway lets
 * through), only the chosen ad account's business portfolio is read, nothing at all when another business in Nexus uses it,
 * never an e-mail field; a guide asked again reads the result. Meta and the database are stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ operation: string; path: string; query?: Record<string, unknown> }>,
  answer: null as null | ((req: { operation: string; path: string; query?: Record<string, unknown> }) => unknown),
  taken: [] as Array<{ product: string; id: string }>,
  tier: 'development_access' as string | null,
  tierCalls: 0,
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => {
  const answerOf = (req: Req) => {
    h.calls.push(req)
    const out = h.answer?.(req)
    if (out instanceof Error) throw out
    return (out ?? { data: [] }) as Record<string, unknown>
  }
  return {
    metaReadOne: vi.fn(async (_t: unknown, req: Req) => ({ body: answerOf(req), calls: 1 })),
    metaReadAll: vi.fn(async (_t: unknown, req: Req, onRows: (rows: unknown[]) => void) => {
      const body = answerOf(req)
      const rows = Array.isArray(body.data) ? body.data : []
      onRows(rows)
      return { rows: rows.length, calls: 1, truncated: false }
    }),
  }
})
// Step 41's account read (its own test covers its request): here only the tier it names.
vi.mock('../../marketing/meta-ads/live-access-change.js', () => ({ liveAccessState: vi.fn(async () => { h.tierCalls++; return { tier: h.tier } }) }))
vi.mock('../../../db.js', () => ({
  default: {
    // nexus_meta_links_taken(product, ids): the ids of that product another business picked.
    $queryRaw: vi.fn(async (_s: unknown, product: string, ids: string[]) => h.taken.filter((t) => t.product === product && ids.includes(t.id)).map((t) => ({ id: t.id }))),
  },
}))

import { META_ADS_BUSINESS_ADMIN_TOOLS } from './meta-ads-business-admin.tools.js'
import { META_ADS_BUSINESS_TOOLS } from './meta-ads-business.tools.js'
import { MetaReadError, failureOfAnswer } from '../../marketing/meta-ads/errors.js'
import { BUSINESS_SETTINGS_FIELDS } from '../../marketing/meta-ads/live-business.js'
import { ADMIN_SHARED } from '../../marketing/meta-ads/live-business-admin.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const tool = (name: string) => META_ADS_BUSINESS_ADMIN_TOOLS.find((t) => t.name === name)!
const ctx = { can: () => true, via: 'claude' as const }
const run = (name: string, args: Record<string, unknown>) => tool(name).handler(tool(name).input.parse(args), ctx as never)
const refusedByMeta = (words: string, code = '200', errorClass = 'forbidden') => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass, channelCode: code, channelMessage: words } as never }), 'x', 1)
const fieldsOf = (req: Req) => String(req.query?.fields ?? '')
const data = (res: { ok: boolean; data?: unknown; error?: string }) => { if (!res.ok) throw new Error(res.error); return res.data as Record<string, any> }
const errorOf = (res: { ok: boolean; error?: string }) => { if (res.ok) throw new Error('expected a refusal'); return res.error! }

const ACCOUNT = '1234567890'
const PORTFOLIO = '9876543210'
const SYSTEM_USER = '100000000000001'
const ADMIN = '100000000000002'
const EMPLOYEE = '100000000000003'
const PAGE = '120000000000010'
const PAGE_2 = '120000000000011'
const PAGE_TAKEN = '120000000000099'
const INVITE = '200000000000001'
const OTHER_SU = '100000000000009'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok', systemUser: { id: SYSTEM_USER, name: 'Nexus system user' }, appId: '300000000000009',
  adAccount: { adAccountId: ACCOUNT, name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: PORTFOLIO },
  page: { pageId: PAGE }, instagram: null, read: {},
}

let invitations: Array<Record<string, unknown>> = []
let systemUsers: Array<Record<string, unknown>> = []
/** Made-up answers (an e-mail Meta might add is in some, to prove it never comes out). */
function answers(req: Req): unknown {
  const f = fieldsOf(req)
  if (req.path === PORTFOLIO && f === BUSINESS_SETTINGS_FIELDS) return { id: PORTFOLIO, name: 'Shop A', timezone_id: 21, primary_page: { id: PAGE }, vertical: 'RETAIL', two_factor_type: 'none' }
  if (req.path.endsWith('/business_users')) {
    return {
      data: [
        { id: ADMIN, name: 'Person A', role: 'ADMIN', two_fac_status: 'enabled', email: 'a@example.com', tasks: ['MANAGE'] },
        { id: EMPLOYEE, name: 'Person B', role: 'EMPLOYEE', two_fac_status: 'disabled', finance_permission: 'ANALYST', email: 'b@example.com' },
      ],
      summary: { total_count: 2 },
    }
  }
  if (req.path.endsWith('/pending_users')) return { data: invitations, summary: { total_count: invitations.length } }
  if (req.path.endsWith('/system_users')) return { data: systemUsers, summary: { total_count: systemUsers.length } }
  if (req.path.endsWith('/owned_pages')) return { data: [{ id: PAGE, name: 'Shop A page' }, { id: PAGE_2, name: 'Shop A outlet' }, { id: PAGE_TAKEN, name: 'Shop B page' }], summary: { total_count: 3 } }
  if (req.path.endsWith('/owned_apps')) return { data: [{ id: '300000000000009', name: 'Shop A app' }] }
  return { data: [] }
}

beforeEach(() => {
  h.connections = [CHOSEN]; h.calls.length = 0; h.answer = answers; h.taken = []; h.tier = 'development_access'; h.tierCalls = 0
  invitations = [{ id: INVITE, role: 'EMPLOYEE', status: 'PENDING', created_time: '2026-10-25T09:00:00+0000', email: 'new@example.com', invite_link: 'https://business.facebook.com/invitation/?token=x', tasks: ['EMPLOYEE'] }]
  systemUsers = [{ id: SYSTEM_USER, name: 'Nexus system user', role: 'EMPLOYEE', created_time: '2026-01-01T00:00:00+0000' }]
})

/** Every call these tools made: a GET the real gateway lets through, on the chosen portfolio only. */
function callsAreReadsOfThePortfolio() {
  const refused = h.calls.map((c) => [c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, problem]) => problem)
  expect(refused).toEqual([])
  expect([...new Set(h.calls.map((c) => c.path.split('/')[0]))]).toEqual([PORTFOLIO])
  expect(h.calls.map(fieldsOf).join(' ')).not.toMatch(/email|first_name|last_name|title|invite_link|token/)
}

describe('three read-only guides (D1)', () => {
  it('read only, open world, ads.view, no change contract; the descriptions say Nexus sends nothing (registration: the mcp-server open-world list)', () => {
    expect(META_ADS_BUSINESS_ADMIN_TOOLS.map((t) => t.name)).toEqual(['set-meta-business-settings', 'set-meta-business-people', 'create-meta-system-user'])
    for (const t of META_ADS_BUSINESS_ADMIN_TOOLS) {
      expect({ readOnly: t.readOnly, openWorld: t.openWorld, execute: t.execute, undo: t.undo, reversibility: t.reversibility, maxClaudeTrust: t.maxClaudeTrust, alwaysAsk: t.alwaysAsk, riskTier: t.riskTier, category: t.category })
        .toEqual({ readOnly: true, openWorld: true, execute: undefined, undo: undefined, reversibility: undefined, maxClaudeTrust: undefined, alwaysAsk: undefined, riskTier: 'low', category: 'insights' })
      expect(t.requires).toEqual(['ads.view'])
      expect(t.description).toMatch(/Nexus changes NOTHING and sends nothing to Meta with this tool \(Owner decision D1/)
      expect(t.restrictedFields).toBeUndefined()
    }
  })
  it('N5 — a time zone id is one of Meta\'s (0…592)', () => {
    expect(tool('set-meta-business-settings').input.safeParse({ timezoneId: 592 }).success).toBe(true)
    expect(tool('set-meta-business-settings').input.safeParse({ timezoneId: 593 }).success).toBe(false)
  })
  it('S3 — step 4\'s reads say "the Owner\'s own steps" only where it is true: settings and people, never partners or assets', () => {
    const description = (name: string) => META_ADS_BUSINESS_TOOLS.find((t) => t.name === name)!.description
    const owner = /The portfolio's settings, people and system users are the Owner's own steps in Meta's screens \(D1\)/
    expect(description('meta-business')).toMatch(owner)
    expect(description('meta-business-people')).toMatch(owner)
    expect(description('meta-business-partners')).not.toMatch(/Owner's own steps/)
    expect(description('meta-business-assets')).not.toMatch(/Owner's own steps/)
    // Partner access is step 41's change a person approves; asset claims step 43's.
    expect(description('meta-business-partners')).toMatch(/an admin's change a person approves/)
    for (const t of META_ADS_BUSINESS_TOOLS) expect(t.description, t.name).toMatch(/Read only: Meta is never changed here\./)
  })
  it('no argument can name an e-mail address, a business or a Nexus product', () => {
    for (const t of META_ADS_BUSINESS_ADMIN_TOOLS) {
      expect(Object.keys(t.input.shape).filter((k) => /mail|business|workspace|^products?$|^productId$/i.test(k)), t.name).toEqual([])
    }
  })
})

describe('one business at a time', () => {
  it('a portfolio another business in Nexus uses: every action refused before any Meta call', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: PORTFOLIO }]
    const asks: Array<[string, Record<string, unknown>]> = [
      ['set-meta-business-settings', { name: 'X' }], ['set-meta-business-settings', { twoFactorType: 'all_required' }],
      ['set-meta-business-people', { action: 'invite', role: 'employee' }], ['set-meta-business-people', { action: 'remove', personId: EMPLOYEE }],
      ['set-meta-business-people', { action: 'cancel-invitation', invitationId: INVITE }],
      ['create-meta-system-user', { name: 'Reports' }], ['create-meta-system-user', { action: 'rename', systemUserId: OTHER_SU, name: 'X' }],
    ]
    for (const [name, args] of asks) expect(errorOf(await run(name, args)), name).toBe(ADMIN_SHARED)
    expect(h.calls).toEqual([])
    expect(h.tierCalls).toBe(0)
  })
  it('no chosen ad account, or one in no portfolio: refused in words, no call', async () => {
    h.connections = [{ ...CHOSEN, adAccount: null }]
    expect(errorOf(await run('set-meta-business-settings', { name: 'X' }))).toMatch(/No Meta ad account is chosen/)
    h.connections = [{ ...CHOSEN, adAccount: { ...CHOSEN.adAccount, businessId: null } }]
    expect(errorOf(await run('set-meta-business-people', { action: 'invite', role: 'employee' }))).toMatch(/belongs to no Meta business portfolio/)
    expect(h.calls).toEqual([])
  })
})

describe('set-meta-business-settings', () => {
  it('a name and a stricter two-factor rule: the steps, the old values, who it holds; only reads of the portfolio', async () => {
    const out = data(await run('set-meta-business-settings', { name: 'Shop A EU', twoFactorType: 'ALL_REQUIRED' }))
    expect(out).toMatchObject({ portfolioId: PORTFOLIO, nexusSends: 'nothing', state: 'to-do' })
    expect(out.items.map((i: { what: string }) => i.what)).toEqual(['name', 'twoFactor'])
    expect(out.ownerSteps.join(' ')).toMatch(/"Shop A".*to "Shop A EU".*choose "Everyone"/)
    expect(out.warnings.join(' ')).toMatch(/Person B \(100000000000003: Meta reads "disabled"\)/)
    expect(out.putBack.steps.join(' ')).toMatch(/back to "Shop A".*"No one" again/)
    callsAreReadsOfThePortfolio()
    expect(JSON.stringify(out)).not.toMatch(/@example\.com/)
  })
  it('the primary Page: an owned one is offered by name; one another business in Nexus uses, or one not owned, is refused', async () => {
    const ok = data(await run('set-meta-business-settings', { primaryPageId: PAGE_2 }))
    expect(ok.ownerSteps.join(' ')).toMatch(/"Shop A outlet" \(Page id 120000000000011/)
    h.taken = [{ product: 'PAGE', id: PAGE_TAKEN }]
    expect(errorOf(await run('set-meta-business-settings', { primaryPageId: PAGE_TAKEN }))).toMatch(/Another business in Nexus uses Page/)
    expect(errorOf(await run('set-meta-business-settings', { primaryPageId: '120000000000077' }))).toMatch(/not a Page this business portfolio owns/)
    // Its current primary Page another business picked: its id and the flag only.
    h.taken = [{ product: 'PAGE', id: PAGE }]
    const now = data(await run('set-meta-business-settings', { primaryPageId: PAGE_2 }))
    expect(now.items[0].now).toEqual({ pageId: PAGE, takenByAnotherBusiness: true })
    callsAreReadsOfThePortfolio()
  })
  it('a primary Page not among the owned Pages Nexus reads when Meta has more (500): refused, never guessed', async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ id: String(120000000100000 + i), name: `Page ${i}` }))
    h.answer = (req) => (req.path.endsWith('/owned_pages') ? { data: many } : answers(req))
    expect(errorOf(await run('set-meta-business-settings', { primaryPageId: PAGE_2 }))).toMatch(/not among the first 500 Pages this business portfolio owns/)
    expect(data(await run('set-meta-business-settings', { primaryPageId: '120000000100007' })).ownerSteps.join(' ')).toMatch(/"Page 7"/)
  })
  it('asked again after the Owner did it: done, no steps left', async () => {
    h.answer = (req) => (fieldsOf(req) === BUSINESS_SETTINGS_FIELDS ? { id: PORTFOLIO, name: 'Shop A EU', two_factor_type: 'all_required', primary_page: { id: PAGE } } : answers(req))
    const out = data(await run('set-meta-business-settings', { name: 'Shop A EU', twoFactorType: 'all_required' }))
    expect(out).toMatchObject({ state: 'done', ownerSteps: [] })
    // Nothing stricter is asked any more: the people are not read.
    expect(h.calls.some((c) => c.path.endsWith('/business_users'))).toBe(false)
  })
  it('the people read refused: the guide still comes, and says it cannot name who is held', async () => {
    h.answer = (req) => (req.path.endsWith('/business_users') ? refusedByMeta('(#200) Permissions error') : answers(req))
    const out = data(await run('set-meta-business-settings', { twoFactorType: 'admin_required' }))
    expect(out.warnings.join(' ')).toMatch(/could not read the portfolio's people/)
  })
})

describe('set-meta-business-people', () => {
  it('invite: steps without any e-mail; asked again with since, the new invitation is the result', async () => {
    const first = data(await run('set-meta-business-people', { action: 'invite', role: 'employee' }))
    expect(first.state).toBe('to-do')
    expect(JSON.stringify(first)).not.toMatch(/@example\.com|invitation\/\?token/)
    invitations.push({ id: '200000000000002', role: 'EMPLOYEE', status: 'PENDING', created_time: new Date(Date.now() + 60_000).toISOString().replace('Z', '+0000').replace(/\.\d{3}/, ''), email: 'c@example.com' })
    const again = data(await run('set-meta-business-people', { action: 'invite', role: 'employee', since: first.readAt }))
    expect(again.state).toBe('done')
    expect(again.items[0].now).toEqual([expect.objectContaining({ invitationId: '200000000000002', role: 'EMPLOYEE' })])
    expect(JSON.stringify(again)).not.toMatch(/@example\.com/)
    callsAreReadsOfThePortfolio()
  })
  it('remove: the only admin refused; an employee by name; removed, asked again with since: done (S1: without since, refused)', async () => {
    expect(errorOf(await run('set-meta-business-people', { action: 'remove', personId: ADMIN }))).toMatch(/only admin.*3914/)
    const out = data(await run('set-meta-business-people', { action: 'remove', personId: EMPLOYEE }))
    expect(out.ownerSteps.join(' ')).toMatch(/click "Person B" \(Nexus's id 100000000000003\), then Remove/)
    h.answer = (req) => (req.path.endsWith('/business_users') ? { data: [{ id: ADMIN, name: 'Person A', role: 'ADMIN' }], summary: { total_count: 1 } } : answers(req))
    expect(errorOf(await run('set-meta-business-people', { action: 'remove', personId: EMPLOYEE }))).toMatch(/is not a person of this business portfolio/)
    expect(data(await run('set-meta-business-people', { action: 'remove', personId: EMPLOYEE, since: out.readAt })).state).toBe('done')
  })
  it('S6 — each action reads only what it needs; a refused read it does not need never fails it; invite gives its steps with "cannot tell"', async () => {
    h.answer = (req) => (req.path.endsWith('/pending_users') || req.path === PORTFOLIO ? refusedByMeta('(#200) Permissions error') : answers(req))
    const removal = data(await run('set-meta-business-people', { action: 'remove', personId: EMPLOYEE }))
    expect(removal.state).toBe('to-do')
    expect(h.calls.some((c) => c.path.endsWith('/pending_users'))).toBe(false)
    const invite = data(await run('set-meta-business-people', { action: 'invite', role: 'employee', since: removal.readAt }))
    expect(invite).toMatchObject({ state: 'cannot-tell', items: [expect.objectContaining({ sentence: expect.stringMatching(/cannot read the pending invitations/) })] })
    expect(invite.ownerSteps.join(' ')).toMatch(/Invite people/)
    h.calls.length = 0
    h.answer = (req) => (req.path.endsWith('/business_users') ? refusedByMeta('(#200) Permissions error') : answers(req))
    expect(data(await run('set-meta-business-people', { action: 'cancel-invitation', invitationId: INVITE })).state).toBe('to-do')
    expect(h.calls.some((c) => c.path.endsWith('/business_users'))).toBe(false)
    // invite reads the people only for their count: one row.
    h.calls.length = 0
    h.answer = answers
    await run('set-meta-business-people', { action: 'invite', role: 'employee' })
    expect(h.calls.filter((c) => c.path.endsWith('/business_users')).map((c) => c.query?.limit)).toEqual([1])
  })
  it('change-role and the invitation actions find their target by id; an unknown one is refused', async () => {
    expect(data(await run('set-meta-business-people', { action: 'change-role', personId: EMPLOYEE, role: 'admin' })).ownerSteps.join(' ')).toMatch(/Full access \(formerly full control: the Admin role\)/)
    expect(errorOf(await run('set-meta-business-people', { action: 'change-role', personId: '100000000000099', role: 'admin' }))).toMatch(/not a person of this business portfolio/)
    expect(data(await run('set-meta-business-people', { action: 'cancel-invitation', invitationId: INVITE })).ownerSteps.join(' ')).toMatch(/invitation made 2026-10-25T09:00:00\+0000 with role EMPLOYEE/)
    expect(data(await run('set-meta-business-people', { action: 'change-invitation', invitationId: INVITE, role: 'admin' })).state).toBe('to-do')
    expect(errorOf(await run('set-meta-business-people', { action: 'invite' }))).toMatch(/Name the role/)
  })
})

describe('create-meta-system-user', () => {
  it('create: the tier and the owned apps are read; Meta\'s limit warned; the result read again', async () => {
    const out = data(await run('create-meta-system-user', { name: 'Reports' }))
    expect(out).toMatchObject({ action: 'create', state: 'to-do', nexusSends: 'nothing' })
    expect(h.tierCalls).toBe(1)
    expect(out.warnings.join(' ')).toMatch(/3949/)
    expect(out.warnings.join(' ')).not.toMatch(/104001/)
    systemUsers.push({ id: OTHER_SU, name: 'Reports', role: 'EMPLOYEE', created_time: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, '+0000') })
    expect(data(await run('create-meta-system-user', { name: 'Reports', since: out.readAt })).state).toBe('done')
    callsAreReadsOfThePortfolio()
  })
  it('Meta lists system users only to an admin token: create still gives the steps (cannot tell); rename and remove are refused in words', async () => {
    h.answer = (req) => (req.path.endsWith('/system_users') ? refusedByMeta('(#200) Requires an admin token') : answers(req))
    const out = data(await run('create-meta-system-user', { name: 'Reports' }))
    expect(out.state).toBe('cannot-tell')
    expect(out.items[0].sentence).toMatch(/cannot read the portfolio's system users: .*admin user's or an admin system user's token/)
    expect(errorOf(await run('create-meta-system-user', { action: 'rename', systemUserId: OTHER_SU, name: 'X' }))).toMatch(/cannot name the one to rename/)
    expect(errorOf(await run('create-meta-system-user', { action: 'remove', systemUserId: OTHER_SU }))).toMatch(/cannot name the one to remove/)
  })
  it('rename and remove: the tier is not read; Nexus\'s own system user is never removed', async () => {
    systemUsers.push({ id: OTHER_SU, name: 'Old server', role: 'EMPLOYEE' })
    expect(data(await run('create-meta-system-user', { action: 'rename', systemUserId: OTHER_SU, name: 'New server' })).putBack.steps.join(' ')).toMatch(/"Old server"/)
    expect(errorOf(await run('create-meta-system-user', { action: 'remove', systemUserId: SYSTEM_USER }))).toMatch(/cuts Nexus off/)
    expect(data(await run('create-meta-system-user', { action: 'remove', systemUserId: OTHER_SU })).putBack.possible).toBe('no')
    expect(h.tierCalls).toBe(0)
    callsAreReadsOfThePortfolio()
  })
  it('S5 — remove is refused when the connection names no system user (Nexus could not tell its own)', async () => {
    systemUsers.push({ id: OTHER_SU, name: 'Old server', role: 'EMPLOYEE' })
    h.connections = [{ ...CHOSEN, systemUser: null }]
    expect(errorOf(await run('create-meta-system-user', { action: 'remove', systemUserId: OTHER_SU }))).toMatch(/does not know which system user it works as/)
    expect(data(await run('create-meta-system-user', { action: 'rename', systemUserId: OTHER_SU, name: 'New server' })).warnings.join(' ')).toMatch(/another business in Nexus connects to Meta with this one/)
  })
})
