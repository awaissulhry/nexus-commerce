/**
 * Meta connect (step 1): the business's own Meta app id, app secret and system-user token, entered by a person, are
 * checked with Meta (debug_token with the app's token, then /me) before anything is stored; the token, app id and app
 * secret are stored together by the token service and never put in an event. Every refusal is a sentence and stores
 * nothing. Discovery reads ad accounts, Pages and Instagram accounts, each list on its own. No network: metaCall is
 * stubbed. Made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ operation: string; path: string; query?: Record<string, unknown>; auth?: unknown; connectionId: string | null }>,
  answers: new Map<string, () => { ok: boolean; status: number; body: unknown; message?: string }>(),
  stored: [] as Array<{ connectionId: string; grant: Record<string, unknown>; event: string }>,
  events: [] as Array<Record<string, unknown>>,
  health: [] as Array<{ connectionId: string; health: Record<string, unknown> }>,
  placement: { kind: 'new' } as { kind: 'new' } | { kind: 'reconsent'; connectionId: string },
  grantedScopes: ['ads_read', 'business_management', 'pages_show_list', 'instagram_basic'] as string[],
}))

vi.mock('../../../gateway/meta.js', () => ({
  metaCall: vi.fn(async (req: { operation: string; path: string; query?: Record<string, unknown>; auth?: unknown; connectionId: string | null }) => {
    h.calls.push(req)
    const a = h.answers.get(req.operation)?.() ?? { ok: true, status: 200, body: { data: [] } }
    return { ok: a.ok, status: a.status, headers: new Headers(), verdict: a.ok ? null : { errorClass: a.status === 403 ? 'forbidden' : 'validation', channelCode: a.status === 403 ? '10' : '100', channelMessage: a.message ?? 'refused' }, json: () => a.body }
  }),
  metaUrl: (path: string) => `https://graph.facebook.com/v26.0/${path}`,
}))
vi.mock('../../identity.service.js', () => ({
  IdentityRefusal: class IdentityRefusal extends Error {},
  placeGrant: vi.fn(async () => h.placement),
}))
vi.mock('../../token.service.js', () => ({
  storeGrant: vi.fn(async (connectionId: string, grant: Record<string, unknown>, _actor: unknown, event: string) => { h.stored.push({ connectionId, grant, event }) }),
  metaAppIdOf: vi.fn(async () => null),
  handleOf: (row: { id: string }) => ({ id: row.id }),
  getAccessToken: vi.fn(async () => 'stored-token'),
  RefreshFailed: class RefreshFailed extends Error {},
}))
vi.mock('./spec.js', () => ({ saveTokenHealth: vi.fn(async (connectionId: string, health: Record<string, unknown>) => { h.health.push({ connectionId, health }) }) }))
vi.mock('../../events.service.js', () => ({ recordConnectionEvent: vi.fn(async (e: Record<string, unknown>) => { h.events.push(e) }) }))
vi.mock('../../../../lib/database-context.js', () => ({ inDatabaseTransaction: async (_client: unknown, work: () => Promise<unknown>) => work() }))
vi.mock('../../../../db.js', () => ({
  default: {
    channelConnection: {
      create: vi.fn(async () => ({ id: 'conn-new' })),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, grantedScopes: h.grantedScopes })),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
    },
    connectionScope: { upsert: vi.fn(async () => ({})) },
  },
}))

import { connectMeta, MetaConnectError, parseMetaCredentials } from './connect.js'
import { tokenHealthOf } from './token-check.js'
import { discoverMetaChoices, metaAdAccountId, metaScopeRows } from './discovery.js'
import { metaPermissionGaps } from './scopes.js'

const APP_ID = '1234567'
const SECRET = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6'
const TOKEN = 'fixture-system-user-token-000000'
const BODY = { appId: APP_ID, appSecret: SECRET, systemUserToken: TOKEN }
const debug = (data: Record<string, unknown>) => () => ({ ok: true, status: 200, body: { data: { app_id: APP_ID, is_valid: true, expires_at: 0, scopes: ['ads_read', 'ads_management', 'business_management'], user_id: '120000000000001', ...data } } })
const me = (id = '120000000000001') => () => ({ ok: true, status: 200, body: { id, name: 'Nexus system user' } })

beforeEach(() => {
  h.calls.length = 0; h.answers.clear(); h.stored.length = 0; h.events.length = 0; h.health.length = 0
  h.placement = { kind: 'new' }
  h.grantedScopes = ['ads_read', 'business_management', 'pages_show_list', 'instagram_basic']
})

describe('the values as entered', () => {
  it('takes Meta\'s shapes and refuses anything else in words that never repeat a secret', () => {
    expect(parseMetaCredentials(BODY)).toEqual({ appId: APP_ID, appSecret: SECRET, token: TOKEN })
    expect(() => parseMetaCredentials({ ...BODY, appId: 'act_1' })).toThrow(/App ID/)
    expect(() => parseMetaCredentials({ ...BODY, appSecret: 'not hex!' })).toThrow(/App secret/)
    expect(() => parseMetaCredentials({ ...BODY, systemUserToken: 'has a space in it but long enough' })).toThrow(/system-user token/)
    try { parseMetaCredentials({ ...BODY, appSecret: 'zz' }) } catch (err) { expect(String((err as Error).message)).not.toContain('zz') }
  })
})

describe('the token check', () => {
  it('reads debug_token: valid, this app, expiry (0 = never), permissions and what each missing one is for', () => {
    const never = tokenHealthOf({ app_id: APP_ID, is_valid: true, expires_at: 0, scopes: ['ads_read'], user_id: '1', type: 'SYSTEM_USER' }, APP_ID)
    expect(never).toMatchObject({ isValid: true, appMatches: true, neverExpires: true, expiresAt: null, type: 'SYSTEM_USER', userId: '1', problem: null })
    expect(never.missing.map((m) => m.scope)).toContain('ads_management')
    expect(never.missing.every((m) => !m.required)).toBe(true)
    const later = Math.floor(Date.now() / 1000) + 50 * 86_400
    expect(tokenHealthOf({ app_id: APP_ID, is_valid: true, expires_at: later, scopes: [] }, APP_ID)).toMatchObject({ neverExpires: false, expiresAt: new Date(later * 1000).toISOString(), type: null })
    expect(tokenHealthOf({ app_id: '999', is_valid: true }, APP_ID)).toMatchObject({ isValid: false, appMatches: false })
    expect(tokenHealthOf({ is_valid: false, error: { message: 'Session has expired' } }, APP_ID)).toMatchObject({ isValid: false, problem: expect.stringMatching(/Session has expired/) })
    // data_access_expires_at in the past: Meta no longer lets the token read data.
    const past = Math.floor(Date.now() / 1000) - 86_400
    expect(tokenHealthOf({ app_id: APP_ID, is_valid: true, expires_at: 0, data_access_expires_at: past }, APP_ID)).toMatchObject({ isValid: false, neverExpires: true, problem: expect.stringMatching(/access to data/) })
    expect(tokenHealthOf({ app_id: APP_ID, is_valid: true, expires_at: 0, data_access_expires_at: 0 }, APP_ID)).toMatchObject({ isValid: true, dataAccessExpiresAt: null })
    expect(metaPermissionGaps([]).find((g) => g.scope === 'ads_read')).toMatchObject({ required: true })
  })
})

describe('connect', () => {
  it('checks the token with the app\'s own token, asks /me, then stores token + app id + secret together; no secret in an event', async () => {
    h.answers.set('token.debug', debug({}))
    h.answers.set('identity.me', me())
    const result = await connectMeta({ body: BODY, actor: { kind: 'operator', userId: 'u-1' } })
    expect(result).toMatchObject({ connectionId: 'conn-new', placement: 'new', systemUser: { id: '120000000000001', name: 'Nexus system user' } })
    const debugCall = h.calls.find((c) => c.operation === 'token.debug')!
    expect(debugCall).toMatchObject({ connectionId: null, path: 'debug_token', query: { input_token: TOKEN }, auth: { token: `${APP_ID}|${SECRET}`, appSecret: SECRET } })
    expect(h.calls.find((c) => c.operation === 'identity.me')).toMatchObject({ connectionId: null, auth: { token: TOKEN, appSecret: SECRET } })
    expect(h.stored).toEqual([{ connectionId: 'conn-new', event: 'grant', grant: expect.objectContaining({
      accessToken: TOKEN, refreshToken: null, expiresInSec: null, identity: { userId: '120000000000001', username: 'Nexus system user' },
      tokenResponseMetadata: expect.objectContaining({ metaApp: { appId: APP_ID, appSecret: SECRET }, tokenType: null }),
    }) }])
    expect(JSON.stringify(h.events)).not.toContain(SECRET)
    expect(JSON.stringify(h.events)).not.toContain(TOKEN)
    expect(JSON.stringify(h.health)).not.toContain(TOKEN)
    expect(h.events).toEqual([expect.objectContaining({ type: 'app_credentials_set', detail: expect.objectContaining({ appId: APP_ID, first: true }) })])
  })
  it('a 60-day token is stored with its own expiry', async () => {
    const at = Math.floor(Date.now() / 1000) + 59 * 86_400
    h.answers.set('token.debug', debug({ expires_at: at }))
    h.answers.set('identity.me', me())
    await connectMeta({ body: BODY, actor: { kind: 'operator' } })
    const seconds = h.stored[0].grant.expiresInSec as number
    expect(seconds).toBeGreaterThan(58 * 86_400)
    expect(seconds).toBeLessThanOrEqual(59 * 86_400)
  })
  it('a type Meta does not report is accepted and said; another type is accepted with a warning; PAGE and APP are refused', async () => {
    h.answers.set('token.debug', debug({}))
    h.answers.set('identity.me', me())
    await expect(connectMeta({ body: BODY, actor: { kind: 'operator' } })).resolves.toMatchObject({ token: { type: null }, warnings: ['Token type not reported by Meta.'] })
    h.answers.set('token.debug', debug({ type: 'SYSTEM_USER' }))
    await expect(connectMeta({ body: BODY, actor: { kind: 'operator' } })).resolves.toMatchObject({ warnings: [] })
    h.answers.set('token.debug', debug({ type: 'USER' }))
    await expect(connectMeta({ body: BODY, actor: { kind: 'operator' } })).resolves.toMatchObject({ warnings: [expect.stringMatching(/token type user — Nexus expects a system-user token/i)] })
    expect(h.stored.at(-1)!.grant.tokenResponseMetadata).toMatchObject({ tokenType: 'USER' })
    for (const type of ['PAGE', 'APP']) {
      h.answers.set('token.debug', debug({ type }))
      await expect(connectMeta({ body: BODY, actor: { kind: 'operator' } })).rejects.toMatchObject({ code: 'not_system_user' })
    }
  })
  it('ads_management alone is enough to read; debug_token\'s user and /me\'s may differ: kept as a warning, never refused', async () => {
    h.answers.set('token.debug', debug({ scopes: ['ads_management'], user_id: '120000000000009' }))
    h.answers.set('identity.me', me())
    const result = await connectMeta({ body: BODY, actor: { kind: 'operator' } })
    expect(result.systemUser.id).toBe('120000000000001')
    expect(result.warnings).toContainEqual(expect.stringMatching(/one user in the token check and another/))
    expect(h.stored.at(-1)!.grant.tokenResponseMetadata).toMatchObject({ debugUserId: '120000000000009' })
  })
  it('refuses a token of another app, an invalid one, one without ads_read, and two different users — nothing stored', async () => {
    const refuse = async (answer: () => { ok: boolean; status: number; body: unknown }, code: string, meId?: string) => {
      h.stored.length = 0
      h.answers.set('token.debug', answer)
      h.answers.set('identity.me', me(meId))
      const err = await connectMeta({ body: BODY, actor: { kind: 'operator' } }).catch((e) => e)
      expect(err).toBeInstanceOf(MetaConnectError)
      expect(err.code).toBe(code)
      expect(h.stored).toHaveLength(0)
    }
    await refuse(debug({ app_id: '7654321' }), 'wrong_app')
    await refuse(debug({ is_valid: false }), 'token_refused')
    await refuse(debug({ scopes: ['pages_show_list'] }), 'missing_permission')
    await refuse(() => ({ ok: false, status: 400, body: { error: { code: 190 } } }), 'wrong_app')
  })
})

describe('discovery', () => {
  it('lists ad accounts (act_ stripped), Pages and their Instagram accounts; follows cursors, never the next link', async () => {
    let pageCalls = 0
    h.answers.set('identity.me', me())
    h.answers.set('discovery.adAccounts', () => {
      pageCalls++
      return pageCalls === 1
        ? { ok: true, status: 200, body: { data: [{ id: 'act_1234567890', account_id: '1234567890', name: 'Shop A', currency: 'EUR', timezone_name: 'Europe/Rome', account_status: 1, business: { id: '9876543210', name: 'Shop A portfolio' } }], paging: { cursors: { after: 'c1' }, next: 'https://graph.facebook.com/v26.0/me/adaccounts?access_token=X&after=c1' } } }
        : { ok: true, status: 200, body: { data: [{ id: 'act_1234567891', account_id: '1234567891', name: 'Shop B', currency: 'EUR', timezone_name: 'Europe/Rome', account_status: 2 }], paging: { cursors: { after: 'c2' } } } }
    })
    h.answers.set('discovery.pages', () => ({ ok: true, status: 200, body: { data: [{ id: '120000000000010', name: 'Shop A Page', instagram_business_account: { id: '170000000000001', username: 'shop_a' } }] } }))
    const choices = await discoverMetaChoices('conn-1')
    expect(choices.adAccounts.items.map((a) => [a.adAccountId, a.statusText, a.businessId])).toEqual([['1234567890', 'Active', '9876543210'], ['1234567891', 'Disabled', null]])
    expect(h.calls.filter((c) => c.operation === 'discovery.adAccounts').map((c) => [c.query?.after ?? null, c.query?.summary, String(c.query?.fields).includes('business{id,name}')])).toEqual([[null, 'total_count', true], ['c1', 'total_count', true]])
    expect(choices.instagram.items).toEqual([{ instagramId: '170000000000001', username: 'shop_a', pageId: '120000000000010' }])
    expect(metaScopeRows(choices).map((s) => s.kind)).toEqual(['meta_ad_account', 'meta_ad_account', 'meta_page', 'meta_instagram_account'])
  })
  it('a list Meta refuses says so in words; the others still come', async () => {
    h.answers.set('discovery.pages', () => ({ ok: false, status: 500, body: {}, message: 'Service temporarily unavailable' }))
    const choices = await discoverMetaChoices('conn-1')
    expect(choices.pages.error).toMatch(/temporarily unavailable/)
    expect(choices.adAccounts.error).toBeNull()
  })
  it('a nested field needs its permission: not asked without it, and a refusal for it reads the list again without it', async () => {
    h.grantedScopes = ['ads_read', 'pages_show_list']
    h.answers.set('discovery.pages', () => ({ ok: true, status: 200, body: { data: [{ id: '120000000000010', name: 'Shop A Page' }], summary: { total_count: 1 } } }))
    const without = await discoverMetaChoices('conn-1')
    expect(h.calls.filter((c) => c.operation.startsWith('discovery.')).every((c) => !/[{]/.test(String(c.query?.fields)))).toBe(true)
    expect(without.adAccounts.error).toMatch(/business_management/)
    expect(without.pages).toMatchObject({ items: [{ pageId: '120000000000010', instagram: null }], total: 1, error: expect.stringMatching(/instagram_basic/) })
    h.calls.length = 0
    h.grantedScopes = ['ads_read', 'business_management', 'pages_show_list', 'instagram_basic']
    let first = true
    h.answers.set('discovery.pages', () => {
      if (first) { first = false; return { ok: false, status: 403, body: {}, message: 'Requires instagram permission' } }
      return { ok: true, status: 200, body: { data: [{ id: '120000000000010', name: 'Shop A Page' }] } }
    })
    const retried = await discoverMetaChoices('conn-1')
    expect(retried.pages.items).toHaveLength(1)
    expect(retried.pages.error).toMatch(/instagram_basic/)
  })
  it('a list longer than the cap says so plainly, never error: null', async () => {
    h.answers.set('discovery.adAccounts', () => ({ ok: true, status: 200, body: { data: [{ account_id: '1234567890' }], paging: { cursors: { after: 'c' }, next: 'x' }, summary: { total_count: 9999 } } }))
    const capped = await discoverMetaChoices('conn-1')
    expect(capped.adAccounts.error).toMatch(/first 50 of 9,999; the rest were not read/)
  })
  it('an ad account id is digits only, with or without act_', () => {
    expect(metaAdAccountId('act_1234567890')).toBe('1234567890')
    expect(metaAdAccountId('1234567890')).toBe('1234567890')
    expect(metaAdAccountId('act_12a')).toBeNull()
  })
})
