/**
 * Meta step 32 — the ONE ownership rule the tools and the gateway ask (signals-rule.ts): only the chosen ad account, its
 * business portfolio (never one another Nexus business shares), a pixel step 11's verdict finds free (taken and unchecked
 * are never changed), the chosen ad account inside a body, custom conversions of the account (deleted only when Nexus
 * made them, claimed only when no portfolio holds them), event source groups of the portfolio, the chosen Page /
 * Instagram account; any read that fails refuses. Partner, server-event and people access are not step 32's. Every read it sends passes the real read gate. Meta and the database
 * are stand-ins; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  asked: (() => {
    /** The stub answers only the top-level fields a read names (so a field dropped from a field list fails a test). */
    const topFields = (fields: unknown): Set<string> => {
      let depth = 0
      let top = ''
      for (const c of String(fields ?? '')) { if (c === '{') depth++; else if (c === '}') depth--; else if (depth === 0) top += c }
      return new Set(top.split(',').map((f) => f.trim()).filter(Boolean))
    }
    const asked = (body: Record<string, unknown>, fields: unknown) => { const keep = topFields(fields); return Object.fromEntries(Object.entries(body).filter(([k]) => k === 'id' || keep.has(k))) }
    return asked
  })(),
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Req[],
  w: {} as {
    portfolio: string | null
    accountPixels: string[]
    owner: Record<string, string>
    accounts: Record<string, Array<Record<string, unknown>>>
    agencies: Record<string, string[]>
    people: string[]
    systemUsers: string[]
    conversions: Record<string, Record<string, unknown>>
    groups: string[]
    group: Record<string, Record<string, unknown>>
    takenPortfolios: Set<string>
    takenAccounts: Set<string>
    nexusMade: Set<string>
    pageLinks: Set<string>
    fail: string | null
  },
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('./read-client.js', async () => {
  const { MetaReadError } = await import('./errors.js')
  const notFound = () => new MetaReadError({ origin: 'meta', httpStatus: 400, code: '100', authLost: false, throttled: false, permissionDenied: false, notFound: true, sentence: 'Meta says it does not exist.' }, 'test')
  const failIf = (req: Req) => { if (h.w.fail && req.path.includes(h.w.fail)) throw new MetaReadError({ origin: 'meta', httpStatus: 400, code: '200', authLost: false, throttled: false, permissionDenied: true, notFound: false, sentence: 'Meta refused the read (200).' }, 'test') }
  return {
    metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
      h.calls.push(req); failIf(req)
      if (req.path.startsWith('act_')) return { body: { business: h.w.portfolio ? { id: h.w.portfolio } : null }, calls: 1 }
      if (req.query?.fields === 'owner_business{id}') return { body: { owner_business: h.w.owner[req.path] ? { id: h.w.owner[req.path] } : null }, calls: 1 }
      if (req.operation === 'signalsRule.conversion') { const c = h.w.conversions[req.path]; if (!c) throw notFound(); return { body: h.asked(c, req.query?.fields), calls: 1 } }
      if (req.operation === 'signalsRule.group') return { body: h.w.group[req.path] ?? {}, calls: 1 }
      return { body: {}, calls: 1 }
    }),
    metaReadAll: vi.fn(async (_t: unknown, req: Req, onRows: (rows: Record<string, unknown>[]) => void) => {
      h.calls.push(req); failIf(req)
      const [head, edge] = req.path.split('/')
      let rows: Array<Record<string, unknown>> = []
      if (edge === 'adspixels') rows = h.w.accountPixels.map((id) => ({ id }))
      else if (edge === 'shared_agencies' || edge === 'agencies') rows = (h.w.agencies[head] ?? []).map((id) => ({ id }))
      else if (edge === 'shared_accounts') rows = h.w.accounts[`${head}:${req.query?.business}`] ?? []
      else if (edge === 'business_users') rows = h.w.people.map((id) => ({ id }))
      else if (edge === 'system_users') rows = h.w.systemUsers.map((id) => ({ id }))
      else if (edge === 'event_source_groups') rows = h.w.groups.map((id) => ({ id }))
      onRows(rows)
      return { rows: rows.length, calls: 1, truncated: false }
    }),
  }
})
vi.mock('../../../db.js', () => ({
  default: {
    $queryRaw: vi.fn(async (_sql: unknown, product: string, ids: string[]) => ids.filter((id) => (product === 'PORTFOLIO' ? h.w.takenPortfolios : product === 'AD_ACCOUNT' ? h.w.takenAccounts : new Set()).has(id)).map((id) => ({ id }))),
    agentChange: { findFirst: vi.fn(async ({ where }: { where: { AND: Array<{ after: { path: string[]; equals: unknown } }> } }) => {
      const id = where.AND.find((c) => c.after.path[0] === 'customConversionId')?.after.equals
      return typeof id === 'string' && h.w.nexusMade.has(id) ? { id: 'chg-1' } : null
    }) },
    metaAccountLink: { findFirst: vi.fn(async ({ where }: { where: { externalId: string } }) => (h.w.pageLinks.has(where.externalId) ? { id: 'link-1' } : null)) },
  },
}))

import { metaSignalsProblem, ownMessagingAccount } from './signals-rule.js'
import { metaChosenAccount } from './live.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const OWN = '1234567890'
const BIZ = '9876543210'
const PIXEL = '120000000000501'
const FOREIGN_PIXEL = '120000000000502'
const CC = '120000000000701'
const GROUP = '120000000000801'
const PAGE = '120000000000010'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok', token: { checkedAt: null, scopes: [], missing: [] },
  adAccount: { adAccountId: OWN, name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: BIZ, statusText: null },
  page: { pageId: PAGE, name: 'Shop A' }, instagram: null, read: {},
}
const ask = (rule: string, objectId: string, kind: Parameters<typeof metaSignalsProblem>[2], body: Record<string, string> = {}) =>
  metaSignalsProblem('conn-1', { rule, objectId, check: false, body: new URLSearchParams(body).toString() }, kind)

beforeEach(() => {
  h.connections = [structuredClone(CHOSEN)]
  h.calls = []
  h.w = {
    portfolio: BIZ, accountPixels: [PIXEL], owner: { [PIXEL]: BIZ, [FOREIGN_PIXEL]: BIZ },
    accounts: { [`${PIXEL}:${BIZ}`]: [{ account_id: OWN }] }, agencies: {}, people: ['700'], systemUsers: ['701'],
    conversions: { [CC]: { account_id: `act_${OWN}`, custom_event_type: 'PURCHASE', pixel: { id: PIXEL } } },
    groups: [GROUP], group: { [GROUP]: { name: 'Group A', event_sources: [{ id: PIXEL }] } },
    takenPortfolios: new Set(), takenAccounts: new Set(), nexusMade: new Set(), pageLinks: new Set([PAGE]), fail: null,
  }
})

describe('the chosen ad account and its portfolio only', () => {
  it('an ad-account create only on act_<chosen>; a custom conversion create only from a free pixel of it', async () => {
    expect(await ask('dataset.create', `act_${OWN}`, 'adaccount', { name: 'Shop A' })).toBeNull()
    // act_<another account> is step 19's check, which the gateway runs first (meta-signals-writes test): not repeated here.
    expect(await ask('dataset.create', 'act_5555555555', 'adaccount', { name: 'Shop A' })).toBeNull()
    // A kind step 32 does not name: refused.
    expect(await ask('dataset.settings', PIXEL, 'campaign', { name: 'Shop A' })).toMatchObject({ sentence: expect.stringMatching(/does not name/) })
    expect(await ask('customConversion.create', `act_${OWN}`, 'adaccount', { event_source_id: PIXEL })).toBeNull()
    expect(await ask('customConversion.create', `act_${OWN}`, 'adaccount', { event_source_id: FOREIGN_PIXEL })).toMatchObject({ sentence: expect.stringMatching(/not on the ad account this business chose/) })
  })
  it('a portfolio change only in the chosen account\'s portfolio, and never in one another Nexus business shares', async () => {
    expect(await ask('dataset.createInBusiness', BIZ, 'datasetportfolio', { name: 'Shop A' })).toBeNull()
    expect(await ask('dataset.createInBusiness', '1111111111', 'datasetportfolio', { name: 'Shop A' })).toMatchObject({ sentence: expect.stringMatching(/not the chosen ad account's/) })
    h.w.takenPortfolios.add(BIZ)
    expect(await ask('dataset.createInBusiness', BIZ, 'datasetportfolio', { name: 'Shop A' })).toMatchObject({ sentence: expect.stringMatching(/Another business in Nexus also has an ad account in this Meta business portfolio/) })
    h.w.takenPortfolios.clear(); h.w.portfolio = null
    expect(await ask('dataset.createInBusiness', BIZ, 'datasetportfolio', { name: 'Shop A' })).toMatchObject({ sentence: expect.stringMatching(/no business portfolio/) })
  })
  it('a group create holds only free pixels of the chosen account; a claim only a custom conversion of it', async () => {
    expect(await ask('eventSourceGroup.create', BIZ, 'datasetportfolio', { event_sources: `["${PIXEL}"]`, name: 'G' })).toBeNull()
    expect(await ask('eventSourceGroup.create', BIZ, 'datasetportfolio', { event_sources: `["${PIXEL}","${FOREIGN_PIXEL}"]`, name: 'G' })).not.toBeNull()
    expect(await ask('customConversion.claim', BIZ, 'datasetportfolio', { custom_conversion_id: CC })).toBeNull()
    // Review B2 — one a portfolio already holds is not claimed (the chosen one's: nothing to claim; another's: refused).
    h.w.conversions[CC].business = { id: BIZ }
    expect(await ask('customConversion.claim', BIZ, 'datasetportfolio', { custom_conversion_id: CC })).toMatchObject({ sentence: expect.stringMatching(/already the chosen portfolio's/) })
    h.w.conversions[CC].business = { id: '1111111111' }
    expect(await ask('customConversion.claim', BIZ, 'datasetportfolio', { custom_conversion_id: CC })).toMatchObject({ sentence: expect.stringMatching(/held by another business portfolio/) })
    delete h.w.conversions[CC].business
    h.w.conversions[CC].account_id = 'act_5555555555'
    expect(await ask('customConversion.claim', BIZ, 'datasetportfolio', { custom_conversion_id: CC })).toMatchObject({ sentence: expect.stringMatching(/not a custom conversion of the chosen ad account/) })
  })
})

describe('a pixel: step 11\'s verdict — only free is changed', () => {
  it('free: its settings go; taken (another business\'s ad account on it): refused; unchecked (owned elsewhere): refused', async () => {
    expect(await ask('dataset.settings', PIXEL, 'dataset', { name: 'Shop A' })).toBeNull()
    h.w.accounts[`${PIXEL}:${BIZ}`].push({ account_id: '5555555555' })
    h.w.takenAccounts.add('5555555555')
    expect(await ask('dataset.settings', PIXEL, 'dataset', { name: 'Shop A' })).toMatchObject({ sentence: expect.stringMatching(/another business in Nexus uses/) })
    expect(JSON.stringify(await ask('dataset.settings', PIXEL, 'dataset', { name: 'Shop A' }))).not.toContain('5555555555')
    h.w.takenAccounts.clear(); h.w.owner[PIXEL] = '1111111111'
    expect(await ask('dataset.settings', PIXEL, 'dataset', { name: 'Shop A' })).toMatchObject({ sentence: expect.stringMatching(/could not check whether another business in Nexus also uses this pixel/) })
  })
  it('connect / disconnect: only the chosen ad account and its portfolio in the body', async () => {
    expect(await ask('dataset.disconnectAccount', PIXEL, 'dataset', { account_id: OWN, business: BIZ })).toBeNull()
    expect(await ask('dataset.disconnectAccount', PIXEL, 'dataset', { account_id: '5555555555', business: BIZ })).toMatchObject({ sentence: expect.stringMatching(/chosen ad account only/) })
    expect(await ask('dataset.disconnectAccount', PIXEL, 'dataset', { account_id: OWN, business: '1111111111' })).toMatchObject({ sentence: expect.stringMatching(/own business portfolio only/) })
    // A CONNECT body too: the chosen ad account and its portfolio only.
    expect(await ask('dataset.connectAccount', FOREIGN_PIXEL, 'dataset', { account_id: '5555555555', business: BIZ })).toMatchObject({ sentence: expect.stringMatching(/chosen ad account only/) })
    expect(await ask('dataset.connectAccount', FOREIGN_PIXEL, 'dataset', { account_id: OWN, business: '1111111111' })).toMatchObject({ sentence: expect.stringMatching(/own business portfolio only/) })
  })
  it('connect a pixel not on the account yet: only one the chosen portfolio owns, none of its accounts or partners another business\'s', async () => {
    expect(await ask('dataset.connectAccount', FOREIGN_PIXEL, 'dataset', { account_id: OWN, business: BIZ })).toBeNull()
    h.w.agencies[FOREIGN_PIXEL] = ['3333333333']
    h.w.takenPortfolios.add('3333333333')
    expect(await ask('dataset.connectAccount', FOREIGN_PIXEL, 'dataset', { account_id: OWN, business: BIZ })).toMatchObject({ sentence: expect.stringMatching(/shared with a business portfolio another business in Nexus uses/) })
    h.w.agencies = {}; h.w.takenPortfolios.clear()
    h.w.accounts[`${FOREIGN_PIXEL}:${BIZ}`] = [{ account_id: '5555555555' }]
    h.w.takenAccounts.add('5555555555')
    expect(await ask('dataset.connectAccount', FOREIGN_PIXEL, 'dataset', { account_id: OWN, business: BIZ })).toMatchObject({ sentence: expect.stringMatching(/connected to an ad account another business in Nexus uses/) })
    h.w.owner[FOREIGN_PIXEL] = '1111111111'
    expect(await ask('dataset.connectAccount', FOREIGN_PIXEL, 'dataset', { account_id: OWN, business: BIZ })).toMatchObject({ sentence: expect.stringMatching(/not owned by its business portfolio/) })
  })
})

describe('custom conversions, groups, the Page', () => {
  it('a custom conversion of the account changes; to delete, only one Nexus made', async () => {
    expect(await ask('customConversion.update', CC, 'datasetconversion', { name: 'X' })).toBeNull()
    expect(await ask('customConversion.delete', CC, 'datasetconversion')).toMatchObject({ sentence: expect.stringMatching(/deletes only a custom conversion it made itself/) })
    h.w.nexusMade.add(CC)
    expect(await ask('customConversion.delete', CC, 'datasetconversion')).toBeNull()
    // Another object of the account (no custom_event_type) is never taken for one.
    h.w.conversions[CC] = { account_id: `act_${OWN}`, pixel: { id: PIXEL } }
    expect(await ask('customConversion.update', CC, 'datasetconversion', { name: 'X' })).toMatchObject({ sentence: expect.stringMatching(/not a custom conversion/) })
    // Its pixel taken: never changed.
    h.w.conversions[CC] = { account_id: `act_${OWN}`, custom_event_type: 'PURCHASE', pixel: { id: FOREIGN_PIXEL } }
    expect(await ask('customConversion.update', CC, 'datasetconversion', { name: 'X' })).not.toBeNull()
  })
  it('a group of the portfolio whose datasets are all free; shared with the chosen ad account only', async () => {
    expect(await ask('eventSourceGroup.update', GROUP, 'eventsourcegroup', { name: 'G' })).toBeNull()
    expect(await ask('eventSourceGroup.share', GROUP, 'eventsourcegroup', { accounts: `["${OWN}"]` })).toBeNull()
    expect(await ask('eventSourceGroup.share', GROUP, 'eventsourcegroup', { accounts: '["5555555555"]' })).toMatchObject({ sentence: expect.stringMatching(/chosen ad account only/) })
    h.w.group[GROUP].event_sources = [{ id: FOREIGN_PIXEL }]
    expect(await ask('eventSourceGroup.update', GROUP, 'eventsourcegroup', { name: 'G' })).not.toBeNull()
    expect(await ask('eventSourceGroup.update', '120000000000899', 'eventsourcegroup', { name: 'G' })).toMatchObject({ sentence: expect.stringMatching(/not an event source group of the chosen/) })
  })
  it('a messaging dataset only for the chosen Page (its link); none for an Instagram account not chosen', async () => {
    // The tools ask ownMessagingAccount; the gateway asks step 28's (Page) and step 31's (Instagram) rule, the same meaning.
    const chosen = await metaChosenAccount('conn-1')
    expect(await ownMessagingAccount(chosen, 'page', PAGE)).toBe(PAGE)
    await expect(ownMessagingAccount(chosen, 'page', '120000000000011')).rejects.toThrow(/not the Facebook Page this business chose/)
    await expect(ownMessagingAccount(chosen, 'instagram', '170000000000001')).rejects.toThrow(/no Instagram account chosen/)
    expect(await ask('dataset.createForMessaging', PAGE, 'page', { dataset_name: 'Chats' })).toBeNull()
  })
})

describe('refusals', () => {
  it('a read Meta refuses, no Meta connection, or Meta\'s check: nothing goes', async () => {
    h.w.fail = 'act_'
    expect(await ask('dataset.createInBusiness', BIZ, 'datasetportfolio', { name: 'Shop A' })).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED', sentence: expect.stringMatching(/could not confirm whose it is/) })
    h.w.fail = null; h.connections = []
    expect(await ask('dataset.create', `act_${OWN}`, 'adaccount', { name: 'Shop A' })).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', sentence: expect.stringMatching(/No Meta connection of this business/) })
    expect(await metaSignalsProblem('conn-1', { rule: 'dataset.settings', objectId: PIXEL, check: true, body: 'name=x' }, 'dataset')).toMatchObject({ sentence: expect.stringMatching(/no check/) })
  })
  it('every read the rule sends passes the real read gate', async () => {
    h.w.agencies[FOREIGN_PIXEL] = ['3333333333']
    await ask('dataset.connectAccount', FOREIGN_PIXEL, 'dataset', { account_id: OWN, business: BIZ })
    await ask('eventSourceGroup.update', GROUP, 'eventsourcegroup', { name: 'G' })
    await ask('customConversion.update', CC, 'datasetconversion', { name: 'X' })
    expect(h.calls.length).toBeGreaterThan(10)
    const refused = h.calls.map((c) => [c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, p]) => p)
    expect(refused).toEqual([])
  })
})
