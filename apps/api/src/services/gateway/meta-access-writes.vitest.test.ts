/**
 * Meta step 41 on the gateway: people and partner access reach Meta only on their EXACT allow-list entries — one rule per
 * kind of change and asset, named with step 41's own kinds (never another tool's call on the same edge), keys exact, task
 * lists in Nexus's one spelling — and only when the gateway's OWN reads confirm the leader's hard floors: the chosen ad
 * account, Page (owned by the portfolio) or Instagram business asset; never Nexus's own system user; a person of the
 * portfolio; never the last admin removed or lowered; never the portfolio itself or a portfolio another Nexus business
 * uses; no partner taken off and no relationship ended unless Nexus's system user is the portfolio's own. Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, routes: {} as Record<string, unknown>, taken: new Set<string>(), pixelRefusal: null as string | null }))
// Owner option 1 — a dataset's own check (step 11 / 32's, live-access-change.ts liveAccessPixel) stands in here: its own
// test is the tool's; the gateway must call it and refuse on its refusal.
vi.mock('../marketing/meta-ads/live-access-change.js', async (importActual) => {
  const live = await import('../marketing/meta-ads/live.js')
  return {
    ...(await importActual<typeof import('../marketing/meta-ads/live-access-change.js')>()),
    liveAccessPixel: vi.fn(async (_a: unknown, id: string) => { if (h.pixelRefusal) throw new live.MetaLiveRefusal(h.pixelRefusal); return { asset: 'pixel', nodeId: id, label: `dataset ${id}` } }),
  }
})
vi.mock('../marketing/meta-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../marketing/meta-ads/live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ connectionId: 'm-1', adAccountId: '1234567890', businessId: '9876543210', pageId: null, instagramId: null, connection: {} })),
}))
vi.mock('../marketing/meta-ads/taken.js', () => ({ takenIds: vi.fn(async (_p: string, ids: string[]) => new Set(ids.filter((id) => h.taken.has(id)))) }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({
  getAccessToken: vi.fn(async () => 'meta-system-user-token'),
  metaAppAccessToken: vi.fn(async () => '1234567|app-secret-for-tests'),
  metaAppIdOf: vi.fn(async () => '1234567'),
  metaRenewalToken: vi.fn(async () => 'stored-meta-token'),
  metaRequestProof: vi.fn(async () => ({ appsecret_proof: 'proof', appsecret_time: '1760000000' })),
}))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))
vi.mock('../cx/connectors/meta/token-check.js', () => ({ forgetMetaTokenCheck: vi.fn(async () => undefined) }))

import { gatewayLedger, gatewayMetaChosen, gatewayMetaInstagram, gatewayMetaPage } from '../../test-support/gateway-stubs.js'
import { __rateTest, registerRateRedis, type RedisLike } from './rate.js'
import { metaWriteCall } from './meta.js'
import { metaWriteVerdict, type MetaJudgedWrite } from './meta-calls.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { __metaAccessLockTest, metaAccessLock, metaAccessOwnerProblem } from './meta-access-owner.js'
import { META_ACCESS_WRITE_RULES } from './meta-access-rules.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'
import { metaLastAdminProblem, metaPermissionIds, metaTaskListProblem } from '../meta/meta-access-lists.js'
import type { MetaOwnerIo } from './meta-optimize-owner.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const PORTFOLIO = '9876543210'
const PAGE = '120000000000080'
const IG = '17840000000000001'
const IG_ASSET = '120000000000090'
const ME = '120000000000001'
const PERSON = '120000000000002'
const OWNER = '120000000000003'
const OTHER_SYSTEM_USER = '120000000000004'
const PARTNER = '120000000000070'
const PIXEL = '120000000000050'
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const verdict = (input: { body?: unknown; objectKind?: string; url: string; method?: string; kind?: string }) =>
  metaWriteVerdict({ method: input.method ?? 'POST', url: input.url, kind: input.kind ?? 'write', body: input.body, objectKind: input.objectKind })
const problem = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const ruleOf = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'write' in v ? v.write.rule : null }

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  __metaAccessLockTest.useMemory()
  h.calls = []; h.routes = {}; h.taken = new Set(); h.pixelRefusal = null; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaPage)) delete gatewayMetaPage[key]
  for (const key of Object.keys(gatewayMetaInstagram)) delete gatewayMetaInstagram[key]
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    const u = new URL(String(url))
    const path = u.pathname.replace(/^\/v\d+\.\d+\//, '')
    const answer = h.routes[`${init.method ?? 'GET'} ${path}`]
    return new Response(JSON.stringify(answer ?? { success: true }), { status: answer === undefined && (init.method ?? 'GET') === 'GET' ? 400 : 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset(); __metaAccessLockTest.reset() })

describe('the allow-list: one rule per change and asset, step 41\'s own kinds, exact keys', () => {
  it('people: POST / DELETE <asset>/assigned_users, the Page and Instagram asset naming their owner', () => {
    expect(ruleOf({ url: `${BASE}/${ACT}/assigned_users`, objectKind: 'accessadaccount', body: form({ user: PERSON, tasks: '["ADVERTISE","ANALYZE"]' }) })).toBe('access.accessadaccount.user.set')
    expect(ruleOf({ url: `${BASE}/${ACT}/assigned_users`, method: 'DELETE', objectKind: 'accessadaccount', body: form({ user: PERSON }) })).toBe('access.accessadaccount.user.remove')
    expect(ruleOf({ url: `${BASE}/${PAGE}/assigned_users`, objectKind: 'accesspage', body: form({ user: PERSON, tasks: '["ADVERTISE","ANALYZE"]', business: PORTFOLIO }) })).toBe('access.accesspage.user.set')
    expect(ruleOf({ url: `${BASE}/${IG_ASSET}/assigned_users`, objectKind: 'accessinstagram', body: form({ user: PERSON, tasks: '["ANALYZE","CONTENT"]', business: PORTFOLIO }) })).toBe('access.accessinstagram.user.set')
    // The Page's and Instagram's sets name their owner; the ad account's does not take one.
    expect(problem({ url: `${BASE}/${PAGE}/assigned_users`, objectKind: 'accesspage', body: form({ user: PERSON, tasks: '["ANALYZE"]' }) })).toMatch(/only Meta change Nexus sends for people or partner access/)
    expect(problem({ url: `${BASE}/${ACT}/assigned_users`, objectKind: 'accessadaccount', body: form({ user: PERSON, tasks: '["ANALYZE"]', business: PORTFOLIO }) })).toMatch(/only Meta change Nexus sends for people or partner access/)
  })
  it('task lists: each asset\'s own enum, distinct and sorted, as JSON — any other spelling is refused', () => {
    const set = (tasks: string, url = `${BASE}/${ACT}/assigned_users`, objectKind = 'accessadaccount') => problem({ url, objectKind, body: form({ user: PERSON, tasks }) })
    expect(set('["ADVERTISE","ANALYZE"]')).toBeNull()
    // Review B-F4 — an ad account takes only Meta's three combinations (100 / 1752129 for any other).
    expect(set('["ADVERTISE","ANALYZE","MANAGE"]')).toBeNull()
    expect(set('["ANALYZE"]')).toBeNull()
    expect(set('["ANALYZE","DRAFT"]')).toMatch(/one of Meta's combinations/)
    expect(set('["MANAGE"]')).toMatch(/one of Meta's combinations/)
    expect(set('["ANALYZE","ADVERTISE"]')).toMatch(/sorted/)
    expect(set('["ANALYZE","ANALYZE"]')).toMatch(/sorted/)
    expect(set('[]')).toMatch(/1 to 5 tasks/)
    expect(set('["CONTENT"]')).toMatch(/holds only MANAGE, ADVERTISE/)
    expect(set("['ANALYZE']")).toMatch(/JSON list/)
    expect(set('ANALYZE')).toMatch(/JSON list/)
    expect(set('["ANALYZE"] ')).toMatch(/sorted|JSON/)
    expect(metaTaskListProblem('["PROFILE_PLUS_FULL_CONTROL"]', 'page', 'tasks')).toBeNull()
    expect(metaTaskListProblem('["CASHIER_ROLE"]', 'page', 'tasks')).toMatch(/holds only/)
    expect(metaTaskListProblem('["MANAGE"]', 'instagram', 'tasks')).toMatch(/holds only CONTENT/)
  })
  it('partners: POST / DELETE <asset>/agencies with business (+ permitted_tasks on a share); a relationship\'s end on the portfolio', () => {
    expect(ruleOf({ url: `${BASE}/${ACT}/agencies`, objectKind: 'accessadaccount', body: form({ business: PARTNER, permitted_tasks: '["ADVERTISE","ANALYZE"]' }) })).toBe('access.accessadaccount.partner.share')
    expect(ruleOf({ url: `${BASE}/${ACT}/agencies`, method: 'DELETE', objectKind: 'accessadaccount', body: form({ business: PARTNER }) })).toBe('access.accessadaccount.partner.remove')
    expect(ruleOf({ url: `${BASE}/${PAGE}/agencies`, objectKind: 'accesspage', body: form({ business: PARTNER, permitted_tasks: '["ADVERTISE"]' }) })).toBe('access.accesspage.partner.share')
    expect(ruleOf({ url: `${BASE}/${IG_ASSET}/agencies`, method: 'DELETE', objectKind: 'accessinstagram', body: form({ business: PARTNER }) })).toBe('access.accessinstagram.partner.remove')
    expect(ruleOf({ url: `${BASE}/${PORTFOLIO}/agencies`, method: 'DELETE', objectKind: 'accessportfolio', body: form({ business: PARTNER }) })).toBe('access.portfolio.agency.end')
    expect(ruleOf({ url: `${BASE}/${PORTFOLIO}/clients`, method: 'DELETE', objectKind: 'accessportfolio', body: form({ business: PARTNER }) })).toBe('access.portfolio.client.end')
    // A share always names the partner's tasks; a removal names nothing else.
    expect(problem({ url: `${BASE}/${ACT}/agencies`, objectKind: 'accessadaccount', body: form({ business: PARTNER }) })).toMatch(/only Meta change Nexus sends for people or partner access/)
    expect(problem({ url: `${BASE}/${ACT}/agencies`, method: 'DELETE', objectKind: 'accessadaccount', body: form({ business: PARTNER, permitted_tasks: '["ANALYZE"]' }) })).toMatch(/only Meta change Nexus sends for people or partner access/)
    expect(problem({ url: `${BASE}/${ACT}/agencies`, objectKind: 'accessadaccount', body: form({ business: '0123', permitted_tasks: '["ANALYZE"]' }) })).toMatch(/digits, no leading zero/)
    // Review A-SF1 (M37) — the share's tasks are judged like a person's: the asset's own list, one spelling, Meta's combinations.
    const share = (tasks: string, url = `${BASE}/${ACT}/agencies`, objectKind = 'accessadaccount') => problem({ url, objectKind, body: form({ business: PARTNER, permitted_tasks: tasks }) })
    expect(share('["ANALYZE","ADVERTISE"]')).toMatch(/permitted_tasks names each task once, sorted/)
    expect(share('["ANALYZE","DRAFT"]')).toMatch(/permitted_tasks on an ad account is one of Meta's combinations/)
    expect(share('["CONTENT"]', `${BASE}/${IG_ASSET}/agencies`, 'accessinstagram')).toBeNull()
    expect(share('["MANAGE"]', `${BASE}/${IG_ASSET}/agencies`, 'accessinstagram')).toMatch(/permitted_tasks holds only CONTENT/)
    // Never a POST on a relationship (Meta has no create there), never a removal of the portfolio's clients by another kind.
    expect(problem({ url: `${BASE}/${PORTFOLIO}/clients`, objectKind: 'accessportfolio', body: form({ business: PARTNER }) })).toMatch(/only Meta change Nexus sends for people or partner access/)
  })
  it('the kinds are step 41\'s own: the same body named a catalog, a block list, an ad account (step 19) or nothing goes by no step-41 rule', () => {
    const body = form({ user: PERSON, tasks: '["ADVERTISE","ANALYZE"]' })
    for (const objectKind of [undefined, 'adaccount', 'campaign']) expect(ruleOf({ url: `${BASE}/${ACT}/assigned_users`, objectKind, body }), String(objectKind)).toBeNull()
    // Step 34's catalog rule keeps its own (its catalog tasks): an access body never matches it, nor the reverse.
    expect(ruleOf({ url: `${BASE}/${PAGE}/assigned_users`, objectKind: 'catalog', body: form({ user: PERSON, tasks: '["ADVERTISE"]' }) })).toBe('catalog.users.assign')
    expect(ruleOf({ url: `${BASE}/${PAGE}/assigned_users`, objectKind: 'catalog', body })).toBeNull()
    expect(ruleOf({ url: `${BASE}/${PAGE}/assigned_users`, objectKind: 'accessadaccount', body })).toBeNull()
    expect(ruleOf({ url: `${BASE}/act_01234/assigned_users`, objectKind: 'accessadaccount', body })).toBeNull()
    // Meta's check is never asked of an access change.
    expect(problem({ url: `${BASE}/${ACT}/assigned_users`, objectKind: 'accessadaccount', body: form({ user: PERSON, tasks: '["ANALYZE"]', execution_options: '["validate_only"]' }) })).toMatch(/only Meta change Nexus sends for people or partner access/)
    expect(META_ACCESS_WRITE_RULES.every((r) => !r.optional.includes('execution_options'))).toBe(true)
  })
})

describe('Owner option 1 — a dataset (pixel) on the allow-list', () => {
  it('people: POST <pixel>/assigned_users user + tasks (its five, no business); never a removal (Meta has none)', () => {
    const url = `${BASE}/${PIXEL}/assigned_users`
    expect(ruleOf({ url, objectKind: 'accesspixel', body: form({ user: PERSON, tasks: '["ADVERTISE","ANALYZE","EDIT"]' }) })).toBe('access.accesspixel.user.set')
    expect(problem({ url, objectKind: 'accesspixel', body: form({ user: PERSON, tasks: '["ANALYZE"]', business: PORTFOLIO }) })).toMatch(/people or partner access/)
    expect(problem({ url, objectKind: 'accesspixel', body: form({ user: PERSON, tasks: '["MANAGE"]' }) })).toMatch(/tasks holds only AA_ANALYZE, ADVERTISE, ANALYZE, EDIT, UPLOAD/)
    expect(problem({ url, method: 'DELETE', objectKind: 'accesspixel', body: form({ user: PERSON }) })).not.toBeNull()
    expect(META_ACCESS_WRITE_RULES.some((r) => r.name === 'access.accesspixel.user.remove')).toBe(false)
  })
  it('partners: share with the partner list (no AA_ANALYZE); removal on the QUERY only, never with a body', () => {
    const url = `${BASE}/${PIXEL}/agencies`
    expect(ruleOf({ url, objectKind: 'accesspixel', body: form({ business: PARTNER, permitted_tasks: '["ADVERTISE","ANALYZE","UPLOAD"]' }) })).toBe('access.accesspixel.partner.share')
    expect(problem({ url, objectKind: 'accesspixel', body: form({ business: PARTNER, permitted_tasks: '["AA_ANALYZE"]' }) })).toMatch(/permitted_tasks holds only ADVERTISE, ANALYZE, EDIT, UPLOAD/)
    expect(ruleOf({ url: `${url}?business=${PARTNER}`, method: 'DELETE', objectKind: 'accesspixel' })).toBe('access.accesspixel.partner.remove')
    expect(problem({ url, method: 'DELETE', objectKind: 'accesspixel', body: form({ business: PARTNER }) })).not.toBeNull()
    expect(problem({ url: `${url}?business=${PARTNER}&extra=1`, method: 'DELETE', objectKind: 'accesspixel' })).toMatch(/takes business/)
    expect(problem({ url: `${url}?business=0123`, method: 'DELETE', objectKind: 'accesspixel' })).toMatch(/digits, no leading zero/)
  })
  it('server events: POST <pixel> server_events_business_ids — the WHOLE list in one spelling; [] clears it', () => {
    const url = `${BASE}/${PIXEL}`
    const ev = (ids: string) => problem({ url, objectKind: 'accesspixel', body: form({ server_events_business_ids: ids }) })
    expect(ruleOf({ url, objectKind: 'accesspixel', body: form({ server_events_business_ids: '["120000000000071","120000000000072"]' }) })).toBe('access.accesspixel.server_events')
    expect(ev('[]')).toBeNull()
    expect(ev('["120000000000072","120000000000071"]')).toMatch(/sorted/)
    expect(ev('[120000000000071]')).toMatch(/as strings/)
    expect(ev('"120000000000071"')).toMatch(/JSON list/)
    // Never with another key, never named another kind (step 32's dataset settings keep their own rule).
    expect(problem({ url, objectKind: 'accesspixel', body: form({ server_events_business_ids: '[]', name: 'Dataset A' }) })).not.toBeNull()
    expect(ruleOf({ url, objectKind: 'pixel', body: form({ server_events_business_ids: '[]' }) })).toBeNull()
  })
})

describe('a relationship\'s permission lists (metaPermissionIds, re-review R-2)', () => {
  it('reads each entry\'s one id; a list that goes on, an entry with no id or two different ids: null (nothing ends)', () => {
    expect(metaPermissionIds([{ id: '1234567891' }, { account_id: 'act_1234567892' }])).toEqual(['1234567891', '1234567892'])
    expect(metaPermissionIds({ data: [{ id: '1234567891' }] })).toEqual(['1234567891'])
    expect(metaPermissionIds([{ id: 'act_1234567891', account_id: '1234567891' }])).toEqual(['1234567891'])
    expect(metaPermissionIds({ data: [{ id: '1234567891' }], paging: { next: 'https://graph.example/next' } })).toBeNull()
    expect(metaPermissionIds([{ id: '1234567891', page_id: '120000000000082' }])).toBeNull()
    expect(metaPermissionIds([{ name: 'no id' }])).toBeNull()
    expect(metaPermissionIds(undefined)).toBeNull()
  })
})

describe('the access lock (metaAccessLock, review A-SF2, re-review R-3 / R-4)', () => {
  it('memory: one per asset (another asset is its own), released only by its own holder, confirmed only while it is still its own', async () => {
    const a = await metaAccessLock('m-1', ACT)
    expect(await metaAccessLock('m-1', ACT)).toBeNull()
    // L8 — another asset's lock is taken WHILE the first is held.
    const b = await metaAccessLock('m-1', PAGE)
    expect(b).not.toBeNull()
    expect(await a!.confirm()).toBe(true)
    // L4 / R-4 — once lapsed and taken by another change, the first holder neither confirms nor releases it.
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 301_000)
    const c = await metaAccessLock('m-1', ACT)
    expect(c).not.toBeNull()
    expect(await a!.confirm()).toBe(false)
    await a!.release()
    expect(await metaAccessLock('m-1', ACT)).toBeNull()
    expect(await c!.confirm()).toBe(true)
    await c!.release()
    expect(await metaAccessLock('m-1', ACT)).not.toBeNull()
    clock.mockRestore()
    await b!.release()
  })
  it('L2 — Redis configured but not ready: no lock (fail closed), never a quiet one in memory', async () => {
    __metaAccessLockTest.reset()
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6399')
    expect(await metaAccessLock('m-1', ACT)).toBeNull()
  })
  it('L3 — on Redis: SET NX decides (a second change is refused), a release or confirm only with its own token', async () => {
    __metaAccessLockTest.reset()
    const store = new Map<string, string>()
    const fake: RedisLike = {
      status: 'ready',
      eval: async (script: string, _n: number, key: string | number, token: string | number) => {
        const k = String(key); const t = String(token)
        if (script.includes("'SET'")) { if (store.has(k)) return 0; store.set(k, t); return 1 }
        if (script.includes("'PEXPIRE'")) return store.get(k) === t ? 1 : 0
        if (script.includes("'DEL'")) { if (store.get(k) === t) { store.delete(k); return 1 } return 0 }
        return 0
      },
      hset: async () => 0, hgetall: async () => ({}), pexpire: async () => 1,
    }
    registerRateRedis(() => fake)
    try {
      const a = await metaAccessLock('m-1', ACT)
      expect(a).not.toBeNull()
      expect(await metaAccessLock('m-1', ACT)).toBeNull()
      expect(await a!.confirm()).toBe(true)
      store.set('gw:metaaccess:m-1:act_1234567890', 'someone-else')
      expect(await a!.confirm()).toBe(false)
      await a!.release()
      expect(store.get('gw:metaaccess:m-1:act_1234567890')).toBe('someone-else')
    } finally {
      registerRateRedis(() => null)
    }
  })
})

describe('the last-admin floor (meta/meta-access-lists.ts)', () => {
  const persons = new Set([PERSON, OWNER])
  it('refuses removing or lowering the last PERSON who is an admin; another person admin, or a system user\'s, decides', () => {
    const assigned = [{ id: OWNER, tasks: ['ADVERTISE', 'ANALYZE', 'MANAGE'] }, { id: PERSON, tasks: ['ANALYZE'] }, { id: ME, tasks: ['ADVERTISE', 'ANALYZE', 'MANAGE'] }]
    expect(metaLastAdminProblem('ad-account', assigned, persons, OWNER, null)).toMatch(/last person who is an admin/)
    expect(metaLastAdminProblem('ad-account', assigned, persons, OWNER, ['ADVERTISE', 'ANALYZE'])).toMatch(/never removes or lowers the last admin/)
    expect(metaLastAdminProblem('ad-account', assigned, persons, OWNER, ['ANALYZE', 'MANAGE'])).toBeNull()
    expect(metaLastAdminProblem('ad-account', assigned, persons, PERSON, null)).toBeNull()
    const two = [...assigned, { id: PERSON, tasks: ['MANAGE'] }].filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i).map((a) => (a.id === PERSON ? { id: PERSON, tasks: ['MANAGE'] } : a))
    expect(metaLastAdminProblem('ad-account', two, persons, OWNER, null)).toBeNull()
  })
  it('review A-MF2 — one-sided: a TARGET whose tasks Nexus cannot judge counts as an admin; another person only by the known rule', () => {
    // The target lists no task, or a task Nexus does not know: it may be the admin — lowering or removing it needs another.
    for (const tasks of [[], ['FULL_CONTROL'], ['ANALYZE', 'SOMETHING_NEW']]) {
      expect(metaLastAdminProblem('instagram', [{ id: OWNER, tasks }, { id: PERSON, tasks: ['ANALYZE'] }], persons, OWNER, null), JSON.stringify(tasks)).toMatch(/last person who is an admin/)
      expect(metaLastAdminProblem('ad-account', [{ id: OWNER, tasks }, { id: PERSON, tasks: ['ANALYZE'] }], persons, OWNER, ['ANALYZE']), JSON.stringify(tasks)).toMatch(/last admin/)
    }
    // Another person whose tasks Nexus cannot judge never stands in for an admin.
    expect(metaLastAdminProblem('ad-account', [{ id: OWNER, tasks: ['ADVERTISE', 'ANALYZE', 'MANAGE'] }, { id: PERSON, tasks: ['FULL_CONTROL'] }], persons, OWNER, null)).toMatch(/last person/)
    expect(metaLastAdminProblem('ad-account', [{ id: OWNER, tasks: [] }, { id: PERSON, tasks: ['MANAGE'] }], persons, OWNER, null)).toBeNull()
    // A known non-admin target is not held back.
    expect(metaLastAdminProblem('ad-account', [{ id: PERSON, tasks: ['ADVERTISE', 'ANALYZE', 'DRAFT'] }], persons, PERSON, null)).toBeNull()
  })
  it('the Page: MANAGE or full control; Instagram: every one of its five tasks', () => {
    expect(metaLastAdminProblem('page', [{ id: OWNER, tasks: ['PROFILE_PLUS_FULL_CONTROL'] }], persons, OWNER, ['ANALYZE'])).toMatch(/MANAGE or full control/)
    const ig = ['ADVERTISE', 'ANALYZE', 'COMMUNITY_ACTIVITY', 'CONTENT', 'MESSAGES']
    expect(metaLastAdminProblem('instagram', [{ id: OWNER, tasks: ig }], persons, OWNER, ig.slice(1))).toMatch(/every Instagram task/)
    expect(metaLastAdminProblem('instagram', [{ id: OWNER, tasks: ig.slice(1) }], persons, OWNER, null)).toBeNull()
  })
})

// ── the owner check, with the gateway's own reads stood in ─────────────────────────────────────────────────────────

type Reads = Record<string, unknown>
function io(reads: Reads): MetaOwnerIo & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    chosenAdAccount: async () => '1234567890',
    // Re-review R-3 (G13) — the stand-in answers only the fields asked, as Meta does: a read that asks fewer gets less.
    read: async (path, query) => {
      asked.push(`${path}?${new URLSearchParams(query).toString()}`)
      const body = (reads[path] ?? null) as Record<string, unknown> | null
      const names = query.fields ? new Set(query.fields.split(',').map((f) => f.replace(/[{.(].*$/, ''))) : null
      if (!body || !names) return body
      const keep = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([k]) => names.has(k)))
      return Array.isArray(body.data) ? { ...body, data: (body.data as Record<string, unknown>[]).map(keep) } : keep(body)
    },
    objectProblem: async () => null,
  }
}
const list = (...ids: string[]) => ({ data: ids.map((id) => ({ id })) })
const BASE_READS: Reads = {
  [ACT]: { business: { id: PORTFOLIO } },
  me: { id: ME },
  [`${PORTFOLIO}/business_users`]: list(PERSON, OWNER),
  [`${PORTFOLIO}/system_users`]: list(ME, OTHER_SYSTEM_USER),
  [`${ACT}/assigned_users`]: { data: [{ id: OWNER, tasks: ['ADVERTISE', 'ANALYZE', 'MANAGE'] }, { id: PERSON, tasks: ['ANALYZE'] }, { id: ME, tasks: ['ADVERTISE', 'ANALYZE', 'MANAGE'] }] },
  [`${PORTFOLIO}/owned_pages`]: list(PAGE),
  [`${PORTFOLIO}/owned_instagram_assets`]: { data: [{ id: IG_ASSET, ig_user_id: IG }] },
  [`${ACT}/agencies`]: list(PARTNER),
  [`${PORTFOLIO}/agencies`]: { data: [{ id: PARTNER, adaccount_permissions: [{ id: '1234567891' }], page_permissions: [] }] },
  [`${PORTFOLIO}/clients`]: { data: [{ id: PARTNER, adaccount_permissions: [], page_permissions: [{ id: '120000000000082' }] }] },
  [`${PORTFOLIO}/owned_ad_accounts`]: { data: [{ account_id: '1234567890' }] },
  [`${PORTFOLIO}/client_instagram_assets`]: { data: [{ id: '120000000000091', ig_user_id: '17840000000000002' }] },
}
const judgedOf = (input: Parameters<typeof verdict>[0]): MetaJudgedWrite => {
  const v = verdict(input)
  if (!('write' in v)) throw new Error(v.problem)
  return v.write
}
const owner = (input: Parameters<typeof verdict>[0], reads: Reads = BASE_READS) => metaAccessOwnerProblem('m-1', judgedOf(input), input.objectKind, io(reads))
const userSet = (user: string, tasks = '["ADVERTISE","ANALYZE"]') => ({ url: `${BASE}/${ACT}/assigned_users`, objectKind: 'accessadaccount', body: form({ user, tasks }) })
const userRemove = (user: string) => ({ url: `${BASE}/${ACT}/assigned_users`, method: 'DELETE', objectKind: 'accessadaccount', body: form({ user }) })

describe('the owner check (meta-access-owner.ts)', () => {
  it('a person of the portfolio gets tasks on the chosen ad account; never Nexus\'s own system user; never someone outside it', async () => {
    expect(await owner(userSet(PERSON))).toBeNull()
    expect(await owner(userSet(ME))).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', sentence: expect.stringMatching(/Nexus's own system user/) })
    expect(await owner(userRemove(ME))).toMatchObject({ sentence: expect.stringMatching(/Nexus's own system user/) })
    expect(await owner(userSet('120000000000099'))).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', sentence: expect.stringMatching(/not a person or system user of the chosen business portfolio/) })
    // `me` unreadable: nothing is sent.
    expect(await owner(userSet(PERSON), { ...BASE_READS, me: null })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
  })
  it('the last admin is never removed or lowered (the gateway reads who holds what itself)', async () => {
    expect(await owner(userRemove(OWNER))).toMatchObject({ sentence: expect.stringMatching(/last person who is an admin/) })
    expect(await owner(userSet(OWNER, '["ANALYZE"]'))).toMatchObject({ sentence: expect.stringMatching(/last admin/) })
    expect(await owner(userSet(OWNER, '["ADVERTISE","ANALYZE","MANAGE"]'))).toBeNull()
    // Review A-MF2 — a target whose tasks the gateway's own read cannot judge counts as an admin there too.
    const unknown = { ...BASE_READS, [`${ACT}/assigned_users`]: { data: [{ id: OWNER, tasks: [] }, { id: PERSON, tasks: ['ANALYZE'] }] } }
    expect(await owner(userRemove(OWNER), unknown)).toMatchObject({ sentence: expect.stringMatching(/last person who is an admin/) })
    const unspelled = { ...BASE_READS, [`${ACT}/assigned_users`]: { data: [{ id: OWNER }, { id: PERSON, tasks: ['FULL_CONTROL'] }] } }
    expect(await owner(userRemove(OWNER), unspelled)).toMatchObject({ sentence: expect.stringMatching(/last person who is an admin/) })
    expect(await owner(userRemove(PERSON))).toBeNull()
    // A person not on the account is not taken off; a list Meta does not answer in full refuses.
    expect(await owner(userRemove(OTHER_SYSTEM_USER))).toMatchObject({ sentence: expect.stringMatching(/holds no task/) })
    expect(await owner(userRemove(PERSON), { ...BASE_READS, [`${ACT}/assigned_users`]: { data: [{ id: PERSON, tasks: ['ANALYZE'] }], paging: { next: 'x', cursors: { after: 'a' } } } })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
    // Review A-N1 — a next page with no cursor to read it is a list cut short, never its end.
    expect(await owner(userSet(OWNER, '["ANALYZE"]'), { ...BASE_READS, [`${ACT}/assigned_users`]: { data: [{ id: PERSON, tasks: ['ANALYZE'] }], paging: { next: 'x' } } })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
  })
  it('only the chosen ad account; the Page only when chosen AND owned; the Instagram business asset of the chosen account', async () => {
    expect(await owner({ url: `${BASE}/act_5555555555/assigned_users`, objectKind: 'accessadaccount', body: form({ user: PERSON, tasks: '["ANALYZE"]' }) })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    const pageSet = { url: `${BASE}/${PAGE}/assigned_users`, objectKind: 'accesspage', body: form({ user: PERSON, tasks: '["ANALYZE"]', business: PORTFOLIO }) }
    const pageReads = { ...BASE_READS, [`${PAGE}/assigned_users`]: { data: [{ id: OWNER, tasks: ['MANAGE'] }] } }
    expect(await owner(pageSet, pageReads)).toMatchObject({ sentence: expect.stringMatching(/not the Facebook Page this business chose/) })
    gatewayMetaPage['m-1'] = PAGE
    expect(await owner(pageSet, pageReads)).toBeNull()
    // Review A-SF1 (M18) — the chosen Page set, the request names another Page: refused (the owned check reads the chosen one).
    expect(await owner({ ...pageSet, url: `${BASE}/120000000000081/assigned_users` }, { ...pageReads, [`${PORTFOLIO}/owned_pages`]: list(PAGE, '120000000000081') })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', sentence: expect.stringMatching(/120000000000081 is not the Facebook Page this business chose/) })
    expect(await owner(pageSet, { ...pageReads, [`${PORTFOLIO}/owned_pages`]: list('120000000000081') })).toMatchObject({ sentence: expect.stringMatching(/not one of the business portfolio's own Pages/) })
    expect(await owner({ ...pageSet, body: form({ user: PERSON, tasks: '["ANALYZE"]', business: '5555555555' }) }, pageReads)).toMatchObject({ sentence: expect.stringMatching(/portfolio that owns it/) })
    const igSet = { url: `${BASE}/${IG_ASSET}/assigned_users`, objectKind: 'accessinstagram', body: form({ user: PERSON, tasks: '["ANALYZE"]', business: PORTFOLIO }) }
    const igReads = { ...BASE_READS, [`${IG_ASSET}/assigned_users`]: { data: [] } }
    expect(await owner(igSet, igReads)).toMatchObject({ sentence: expect.stringMatching(/chosen no Instagram account/) })
    gatewayMetaInstagram['m-1'] = IG
    expect(await owner(igSet, igReads)).toBeNull()
    // The IG user id itself is never the object: the business asset is.
    expect(await owner({ ...igSet, url: `${BASE}/${IG}/assigned_users` }, igReads)).toMatchObject({ sentence: expect.stringMatching(/not the business asset/) })
  })
  it('a portfolio another Nexus business uses: no system user gets access through it (people may)', async () => {
    expect(await owner(userSet(OTHER_SYSTEM_USER))).toBeNull()
    h.taken.add(PORTFOLIO)
    expect(await owner(userSet(OTHER_SYSTEM_USER))).toMatchObject({ sentence: expect.stringMatching(/cannot tell whose system user/) })
    expect(await owner(userSet(PERSON))).toBeNull()
    h.taken.clear()
    // Review A-N3 — another business chose one of the portfolio's OWN ad accounts (its link names no portfolio): shared too;
    // and when the portfolio's ad accounts cannot be read, it counts as shared.
    const ownTwo = { ...BASE_READS, [`${PORTFOLIO}/owned_ad_accounts`]: { data: [{ account_id: '1234567890' }, { account_id: '1234567892' }] } }
    h.taken.add('1234567892')
    expect(await owner(userSet(OTHER_SYSTEM_USER), ownTwo)).toMatchObject({ sentence: expect.stringMatching(/cannot tell whose system user/) })
    h.taken.clear()
    expect(await owner(userSet(OTHER_SYSTEM_USER), { ...BASE_READS, [`${PORTFOLIO}/owned_ad_accounts`]: null })).toMatchObject({ sentence: expect.stringMatching(/could not tell that none does/) })
  })
  it('review A-N2 — a system user is changed only when Nexus\'s own is one of the portfolio\'s system users', async () => {
    const outside = { ...BASE_READS, [`${PORTFOLIO}/system_users`]: list(OTHER_SYSTEM_USER) }
    expect(await owner(userSet(OTHER_SYSTEM_USER), outside)).toMatchObject({ sentence: expect.stringMatching(/cannot be sure 120000000000004 is not itself/) })
    expect(await owner(userSet(PERSON), outside)).toBeNull()
  })
  it('partners: never the portfolio itself, never another Nexus business\'s; a removal only of a partner listed, and only when Nexus\'s system user is the portfolio\'s own', async () => {
    const share = (business: string) => ({ url: `${BASE}/${ACT}/agencies`, objectKind: 'accessadaccount', body: form({ business, permitted_tasks: '["ANALYZE"]' }) })
    const remove = (business: string) => ({ url: `${BASE}/${ACT}/agencies`, method: 'DELETE', objectKind: 'accessadaccount', body: form({ business }) })
    expect(await owner(share(PARTNER))).toBeNull()
    expect(await owner(share(PORTFOLIO))).toMatchObject({ sentence: expect.stringMatching(/own business portfolio/) })
    h.taken.add(PARTNER)
    expect(await owner(share(PARTNER))).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', sentence: expect.stringMatching(/another business in Nexus/) })
    expect(await owner(remove(PARTNER))).toMatchObject({ sentence: expect.stringMatching(/another business in Nexus/) })
    h.taken.clear()
    expect(await owner(remove(PARTNER))).toBeNull()
    expect(await owner(remove('120000000000071'))).toMatchObject({ sentence: expect.stringMatching(/not shared with business portfolio/) })
    expect(await owner(remove(PARTNER), { ...BASE_READS, [`${PORTFOLIO}/system_users`]: list(OTHER_SYSTEM_USER) })).toMatchObject({ sentence: expect.stringMatching(/may come through a partner/) })
  })
  it('a relationship\'s end: the portfolio itself, unshared in Nexus, the partner listed; a client\'s only when the chosen Page and Instagram are the portfolio\'s own', async () => {
    const end = (edge: 'agencies' | 'clients', object = PORTFOLIO) => ({ url: `${BASE}/${object}/${edge}`, method: 'DELETE', objectKind: 'accessportfolio', body: form({ business: PARTNER }) })
    expect(await owner(end('agencies'))).toBeNull()
    expect(await owner(end('agencies', '5555555555'))).toMatchObject({ sentence: expect.stringMatching(/not the business portfolio/) })
    expect(await owner(end('agencies'), { ...BASE_READS, [`${PORTFOLIO}/agencies`]: list() })).toMatchObject({ sentence: expect.stringMatching(/not an agency/) })
    // Review A-MF1 — fail closed on what the relationship holds: lists Meta did not answer or Nexus cannot read refuse; an ad
    // account or Page another Nexus business chose refuses.
    expect(await owner(end('agencies'), { ...BASE_READS, [`${PORTFOLIO}/agencies`]: list(PARTNER) })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED', sentence: expect.stringMatching(/did not list the ad accounts and Pages/) })
    expect(await owner(end('agencies'), { ...BASE_READS, [`${PORTFOLIO}/agencies`]: { data: [{ id: PARTNER, adaccount_permissions: [{ name: 'no id' }], page_permissions: [] }] } })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
    h.taken.add('1234567891')
    expect(await owner(end('agencies'))).toMatchObject({ sentence: expect.stringMatching(/holds an ad account or Page another business in Nexus uses/) })
    h.taken.clear()
    gatewayMetaPage['m-1'] = PAGE
    gatewayMetaInstagram['m-1'] = IG
    expect(await owner(end('clients'))).toBeNull()
    h.taken.add('120000000000082')
    expect(await owner(end('clients'))).toMatchObject({ sentence: expect.stringMatching(/holds an ad account or Page another business in Nexus uses/) })
    h.taken.clear()
    // Meta names no Instagram account for a relationship: one the portfolio holds as a client that another business uses
    // refuses a client end, and so does a list Nexus cannot read.
    h.taken.add('17840000000000002')
    expect(await owner(end('clients'))).toMatchObject({ sentence: expect.stringMatching(/holds, as a client, an Instagram account/) })
    h.taken.clear()
    expect(await owner(end('clients'), { ...BASE_READS, [`${PORTFOLIO}/client_instagram_assets`]: null })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
    expect(await owner(end('clients'), { ...BASE_READS, [`${PORTFOLIO}/owned_pages`]: list() })).toMatchObject({ sentence: expect.stringMatching(/chosen Facebook Page is not the business portfolio's own/) })
    expect(await owner(end('clients'), { ...BASE_READS, [`${PORTFOLIO}/owned_instagram_assets`]: { data: [] } })).toMatchObject({ sentence: expect.stringMatching(/chosen Instagram account is not the business portfolio's own/) })
    h.taken.add(PORTFOLIO)
    expect(await owner(end('agencies'))).toMatchObject({ sentence: expect.stringMatching(/ends none/) })
    h.taken.clear()
    // Re-review R-1 — another business chose one of the portfolio's OWN Pages or Instagram accounts (it may reach it through
    // this agency): an agency end is refused too; a list of them Nexus cannot read counts as shared.
    h.taken.add(IG)
    expect(await owner(end('agencies'))).toMatchObject({ sentence: expect.stringMatching(/ends none/) })
    h.taken.clear()
    h.taken.add(PAGE)
    expect(await owner(end('agencies'))).toMatchObject({ sentence: expect.stringMatching(/ends none/) })
    h.taken.clear()
    expect(await owner(end('agencies'), { ...BASE_READS, [`${PORTFOLIO}/owned_instagram_assets`]: null })).toMatchObject({ sentence: expect.stringMatching(/could not tell that none does/) })
    expect(await owner(end('agencies'), { ...BASE_READS, [`${PORTFOLIO}/owned_pages`]: { data: [{ id: PAGE }], paging: { next: 'x' } } })).toMatchObject({ sentence: expect.stringMatching(/could not tell that none does/) })
    expect(await owner(end('agencies'), { ...BASE_READS, [`${PORTFOLIO}/owned_ad_accounts`]: null })).toMatchObject({ sentence: expect.stringMatching(/could not tell that none does/) })
  })
})

describe('the owner check: a dataset (Owner option 1)', () => {
  const pixelReads: Reads = { ...BASE_READS, [`${PIXEL}/assigned_users`]: { data: [{ id: OWNER, tasks: ['ADVERTISE', 'ANALYZE', 'EDIT'] }, { id: PERSON, tasks: ['ANALYZE'] }] }, [`${PIXEL}/agencies`]: list(PARTNER), [`${PIXEL}/server_events_permitted_business`]: list('120000000000071') }
  const pixelSet = (user: string, tasks = '["ANALYZE"]') => ({ url: `${BASE}/${PIXEL}/assigned_users`, objectKind: 'accesspixel', body: form({ user, tasks }) })
  const pixelRemove = (business: string) => ({ url: `${BASE}/${PIXEL}/agencies?business=${business}`, method: 'DELETE', objectKind: 'accesspixel' })
  const ownerQ = (input: Parameters<typeof verdict>[0], reads: Reads = pixelReads, expected: string[] | undefined = ['120000000000071']) => metaAccessOwnerProblem('m-1', judgedOf(input), input.objectKind, io(reads), new URL(input.url).searchParams, expected)
  it('the dataset must pass its own check (on the chosen ad account, free, owned by the portfolio); the floors hold there too', async () => {
    expect(await ownerQ(pixelSet(PERSON, '["ADVERTISE","ANALYZE"]'))).toBeNull()
    h.pixelRefusal = 'Dataset 120000000000050 is not owned by the chosen ad account\'s business portfolio.'
    expect(await ownerQ(pixelSet(PERSON))).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', sentence: expect.stringMatching(/not owned by the chosen ad account's business portfolio/) })
    h.pixelRefusal = null
    expect(await ownerQ(pixelSet(ME))).toMatchObject({ sentence: expect.stringMatching(/Nexus's own system user/) })
    expect(await ownerQ(pixelSet('120000000000099'))).toMatchObject({ sentence: expect.stringMatching(/not a person or system user/) })
    // EDIT is a dataset's admin: the last person with it is never lowered.
    expect(await ownerQ(pixelSet(OWNER, '["ANALYZE"]'))).toMatchObject({ sentence: expect.stringMatching(/last person who is an admin of the dataset \(EDIT\)/) })
  })
  it('a partner off a dataset: its business read from the QUERY; listed, never another Nexus business\'s, Nexus\'s system user the portfolio\'s', async () => {
    expect(await ownerQ(pixelRemove(PARTNER))).toBeNull()
    expect(await ownerQ(pixelRemove('120000000000071'))).toMatchObject({ sentence: expect.stringMatching(/not shared with business portfolio 120000000000071/) })
    expect(await ownerQ(pixelRemove(PORTFOLIO))).toMatchObject({ sentence: expect.stringMatching(/own business portfolio/) })
    h.taken.add(PARTNER)
    expect(await ownerQ(pixelRemove(PARTNER))).toMatchObject({ sentence: expect.stringMatching(/another business in Nexus/) })
    h.taken.clear()
    expect(await ownerQ(pixelRemove(PARTNER), { ...pixelReads, [`${PORTFOLIO}/system_users`]: list(OTHER_SYSTEM_USER) })).toMatchObject({ sentence: expect.stringMatching(/may come through a partner/) })
  })
  it('server events: never the portfolio itself or another Nexus business\'s, and only with Nexus\'s system user the portfolio\'s', async () => {
    const ev = (ids: string[]) => ({ url: `${BASE}/${PIXEL}`, objectKind: 'accesspixel', body: form({ server_events_business_ids: JSON.stringify([...ids].sort()) }) })
    expect(await ownerQ(ev(['120000000000071']))).toBeNull()
    expect(await ownerQ(ev([]))).toBeNull()
    expect(await ownerQ(ev([PORTFOLIO]))).toMatchObject({ sentence: expect.stringMatching(/own business portfolio is not one of the businesses/) })
    h.taken.add('120000000000071')
    expect(await ownerQ(ev(['120000000000071']))).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', sentence: expect.stringMatching(/another business in Nexus uses/) })
    h.taken.clear()
    expect(await ownerQ(ev(['120000000000071']), { ...pixelReads, [`${PORTFOLIO}/system_users`]: list(OTHER_SYSTEM_USER) })).toMatchObject({ sentence: expect.stringMatching(/its server events may come through/) })
    h.pixelRefusal = 'not this business\'s dataset'
    expect(await ownerQ(ev(['120000000000071']))).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
  })
  it('option-1 review SF1 / SF2 / N3 — the list Meta holds NOW, read under the lock: never with the portfolio or another Nexus business on it, never moved since the change was built', async () => {
    const ev = (ids: string[]) => ({ url: `${BASE}/${PIXEL}`, objectKind: 'accesspixel', body: form({ server_events_business_ids: JSON.stringify([...ids].sort()) }) })
    // P-G1 — a caller that skipped the tool cannot take another Nexus business's portfolio off the list.
    h.taken.add('120000000000071')
    expect(await ownerQ(ev([]))).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', sentence: expect.stringMatching(/may be sent now by a business portfolio another business in Nexus uses/) })
    h.taken.clear()
    expect(await ownerQ(ev([]), { ...pixelReads, [`${PIXEL}/server_events_permitted_business`]: list(PORTFOLIO) }, [PORTFOLIO])).toMatchObject({ sentence: expect.stringMatching(/own business portfolio among its server-event businesses/) })
    expect(await ownerQ(ev([]), { ...pixelReads, [`${PIXEL}/server_events_permitted_business`]: null })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
    expect(await ownerQ(ev([]), { ...pixelReads, [`${PIXEL}/server_events_permitted_business`]: { data: [{ id: '120000000000071' }], paging: { next: 'x', cursors: { after: 'a' } } } })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
    // N3 — built on another list than Meta's now (a business added in Meta meanwhile), or on no list at all: nothing is sent.
    expect(await ownerQ(ev(['120000000000072']), pixelReads, [])).toMatchObject({ sentence: expect.stringMatching(/changed in Meta since this change was built/) })
    const bare = ev(['120000000000072'])
    expect(await metaAccessOwnerProblem('m-1', judgedOf(bare), bare.objectKind, io(pixelReads), new URL(bare.url).searchParams)).toMatchObject({ sentence: expect.stringMatching(/names the list it was built on/) })
    expect(await ownerQ(ev(['120000000000071', '120000000000072']))).toBeNull()
  })
})

describe('through the gateway (metaWriteCall)', () => {
  const routes = () => {
    h.routes = {
      [`GET ${ACT}`]: { business: { id: PORTFOLIO } },
      'GET me': { id: ME },
      [`GET ${PORTFOLIO}/business_users`]: list(PERSON, OWNER),
      [`GET ${PORTFOLIO}/system_users`]: list(ME),
      [`GET ${ACT}/assigned_users`]: { data: [{ id: OWNER, tasks: ['ADVERTISE', 'ANALYZE', 'MANAGE'] }, { id: ME, tasks: ['MANAGE'] }] },
    }
  }
  it('a person of the portfolio: sent as the judged form body; Nexus\'s own system user or the last admin: nothing sent', async () => {
    routes()
    const ok = await metaWriteCall({ connectionId: 'm-1', operation: 'access.accessadaccount.user.set', objectId: ACT, objectKind: 'accessadaccount', edge: 'assigned_users', params: { user: PERSON, tasks: '["ADVERTISE","ANALYZE"]' }, check: false })
    expect(ok.ok).toBe(true)
    const post = h.calls.find((c) => c.init.method === 'POST')!
    expect(new URL(post.url).pathname).toBe(`/${META_DEFAULT_GRAPH_API_VERSION}/${ACT}/assigned_users`)
    expect(String(post.init.body)).toBe(form({ user: PERSON, tasks: '["ADVERTISE","ANALYZE"]' }))
    h.calls = []
    __metaObjectLimitsTest.reset(); __metaObjectLimitsTest.useMemory()
    const own = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'accessadaccount', edge: 'assigned_users', method: 'DELETE', params: { user: ME }, check: false }).catch((e) => e)
    expect(own).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/Nexus's own system user/) })
    const last = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'accessadaccount', edge: 'assigned_users', method: 'DELETE', params: { user: OWNER }, check: false }).catch((e) => e)
    expect(last).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/last person who is an admin/) })
    expect(h.calls.filter((c) => c.init.method !== 'GET')).toEqual([])
  })
  it('review A-SF2 — one access change of an asset at a time: while another holds its lock, nothing is sent; the lock goes after the call', async () => {
    routes()
    const held = await metaAccessLock('m-1', ACT)
    expect(held).not.toBeNull()
    const busy = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'accessadaccount', edge: 'assigned_users', params: { user: PERSON, tasks: '["ANALYZE"]' }, check: false }).catch((e) => e)
    expect(busy).toMatchObject({ outcome: 'held', code: 'META_ACCESS_BUSY' })
    expect(h.calls.filter((c) => c.init.method !== 'GET')).toEqual([])
    await held!.release()
    const ok = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'accessadaccount', edge: 'assigned_users', params: { user: PERSON, tasks: '["ANALYZE"]' }, check: false })
    expect(ok.ok).toBe(true)
    // Let go after the call: the next one takes it again.
    const again = await metaAccessLock('m-1', ACT)
    expect(again).not.toBeNull()
    await again!.release()
  })
  it('re-review R-4 — a lock lost during the owner check (it outlasted it): nothing is sent', async () => {
    routes()
    // The stand-in "loses" every lock while the gateway reads `me` (as a lock that lapsed and was taken by another change).
    const fetchMock = vi.mocked(globalThis.fetch)
    const real = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(url)).pathname.endsWith('/me')) __metaAccessLockTest.useMemory()
      return real(url as string, init as RequestInit)
    })
    const out = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'accessadaccount', edge: 'assigned_users', params: { user: PERSON, tasks: '["ANALYZE"]' }, check: false }).catch((e) => e)
    expect(out).toMatchObject({ outcome: 'held', code: 'META_ACCESS_BUSY', message: expect.stringMatching(/took longer than its lock/) })
    expect(h.calls.filter((c) => c.init.method !== 'GET')).toEqual([])
  })
  it('Owner option 1 — a dataset\'s partner goes off as Meta\'s guide sends it: DELETE <pixel>/agencies?business=…, no body', async () => {
    routes()
    h.routes[`GET ${PIXEL}/agencies`] = list(PARTNER)
    const ok = await metaWriteCall({ connectionId: 'm-1', operation: 'access.accesspixel.partner.remove', objectId: PIXEL, objectKind: 'accesspixel', edge: 'agencies', method: 'DELETE', params: {}, query: { business: PARTNER }, check: false })
    expect(ok.ok).toBe(true)
    const del = h.calls.find((c) => c.init.method === 'DELETE')!
    expect(new URL(del.url).pathname).toBe(`/${META_DEFAULT_GRAPH_API_VERSION}/${PIXEL}/agencies`)
    expect(new URL(del.url).searchParams.get('business')).toBe(PARTNER)
    // No body content (the gateway sends a query DELETE's judged body, which is empty — step 30's DELETEs go the same way).
    expect(del.init.body || undefined).toBeUndefined()
  })
  it('the brake: with Meta changes switched off nothing is sent', async () => {
    routes()
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    const out = await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'accessadaccount', edge: 'assigned_users', params: { user: PERSON, tasks: '["ANALYZE"]' }, check: false }).catch((e) => e)
    expect(out).toMatchObject({ outcome: 'gated' })
    expect(h.calls.filter((c) => c.init.method !== 'GET')).toEqual([])
  })
})
