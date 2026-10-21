/**
 * Meta step 30 part 2 — set-meta-webhooks, set-meta-alert-subscription and remove-meta-alert-subscription as the approval
 * gate uses them (the account, the live reads and Meta are stand-ins; the gateway rules are proven in
 * gateway/meta-webhook-writes): each a change a person approves, nothing spends, Meta has no check, what is sent is
 * exactly the request the gateway's rule takes, Instagram is the App Dashboard's, a removal needs the person's explicit
 * ask, and undo puts back what each replaced. Made-up ids and names.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  appId: '1234567' as string | null,
  pageId: '120000000000010' as string | null,
  app: [] as Array<{ object: string; fields: string[]; active: boolean | null; nexusCallback: boolean; callbackOrigin: string | null }>,
  adAccount: { connected: false },
  /** The businesses connecting the same Meta app (this one is the legacy workspace when no profile is in context). */
  users: { users: [{ workspaceId: 'nexus_legacy_workspace', connectionId: 'm-1', systemUserId: null }] as Array<Record<string, unknown>>, unsure: false } as { users: Array<Record<string, unknown>>; unsure: boolean } | Error,
  alert: null as null | Record<string, unknown>,
  send: vi.fn(),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../cx/token.service.js', () => ({ metaAppIdOf: vi.fn(async () => h.appId) }))
vi.mock('../../marketing/meta-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ pageId: h.pageId })),
}))
vi.mock('../../marketing/meta-ads/live-webhook-setup.js', () => ({
  liveAppSubscriptions: vi.fn(async () => structuredClone(h.app)),
  liveAdAccountApps: vi.fn(async () => ({ ...h.adAccount })),
  liveAlertSubscription: vi.fn(async () => (h.alert ? structuredClone(h.alert) : null)),
}))
vi.mock('../../marketing/meta-ads/webhook-receiver.js', () => ({
  metaAppUsers: vi.fn(async () => { if (h.users instanceof Error) throw h.users; return structuredClone(h.users) }),
}))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: vi.fn(async () => { throw new Error('Meta has no check for these: never asked') }),
  metaSendChange: h.send,
}))

import { META_ADS_WEBHOOKS_TOOLS } from './meta-ads-webhooks.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import { DASHBOARD_ONLY, PAGE_INSTALL_ROADS, webhooksDraft } from '../../marketing/meta-ads/change-webhooks.js'
import { alertParamsOf, alertSpecOf } from '../../marketing/meta-ads/change-alert-subscriptions.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const tool = (name: string) => META_ADS_WEBHOOKS_TOOLS.find((t) => t.name === name)!
const webhooks = tool('set-meta-webhooks')
const alerts = tool('set-meta-alert-subscription')
const remove = tool('remove-meta-alert-subscription')
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const preview = async (t: AgentTool, args: Record<string, unknown>) => (await t.handler(t.input.parse(args) as Record<string, unknown>, asker)) as ToolResult & { preview: Record<string, any>; error?: string }
async function run(t: AgentTool, args: Record<string, unknown>) {
  const parsed = t.input.parse(args) as Record<string, unknown>
  const first = await preview(t, args)
  expect(first.ok, first.error).toBe(true)
  return (await t.execute!(parsed, approved(first.preview))) as ToolResult & { data: Record<string, any>; change: { before: any; after: any } }
}
const ok = (node: Record<string, unknown> = { success: true }) => async () => ({ node, readBack: 'none', waitedMs: 0 })
const sent = () => h.send.mock.calls.map((c) => c[1])
const ALERT = { subscriptionId: '120000000000040', eventType: 'INSIGHTS_UPDATED', field: 'cpc', value: '200', operator: 'GREATER_THAN', filters: [{ field: 'entity_type', value: 'AD', operator: 'EQUAL' }], status: 'ENABLED' }

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  vi.stubEnv('NEXUS_PUBLIC_API_URL', 'https://api.example.test')
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.appId = '1234567'; h.pageId = '120000000000010'
  h.app = []; h.adAccount = { connected: false }; h.alert = null
  h.users = { users: [{ workspaceId: 'nexus_legacy_workspace', connectionId: 'm-1', systemUserId: null }], unsure: false }
  h.send.mockReset(); h.send.mockImplementation(ok())
})

describe('the tools', () => {
  it('are changes a person always approves; nothing spends; each ends with the Meta rules; all registered for the re-check', () => {
    for (const t of META_ADS_WEBHOOKS_TOOLS) {
      expect(t).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, category: 'advertising' })
      expect(t.undo, t.name).toBeDefined()
      expect(t.description.endsWith(META_CHANGE_RULES)).toBe(true)
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
    }
    expect(webhooks.description).toMatch(/App Dashboard is as good a road/)
    expect(webhooks.description).toMatch(/Nothing here spends money/)
    expect(alerts.requires).toContain('financials.adspend.view')
    expect(() => remove.input.parse({ subscriptionId: '1' })).toThrow()
    expect(() => remove.input.parse({ subscriptionId: '1', confirmDelete: false })).toThrow()
  })
})

describe('set-meta-webhooks', () => {
  it('subscribe-app: the app token, Nexus\'s own callback, include_values, the receiver\'s fields; undo removes only what it added', async () => {
    h.app = [{ object: 'ad_account', fields: ['effective_status'], active: true, nexusCallback: true, callbackOrigin: 'https://api.example.test' }]
    const out = await preview(webhooks, { action: 'subscribe-app', object: 'ad_account', fields: ['effective_status', 'with_issues_ad_objects'] })
    expect(out.preview).toMatchObject({ spendsMoney: false, metaCheck: { checked: 'none' }, requests: [{ step: 1, label: 'Subscribe the app to ad_account: effective_status, with_issues_ad_objects', metaCheck: 'no-check' }] })
    expect(out.preview.changes['App subscription ad_account']).toEqual({ from: 'effective_status', to: 'effective_status, with_issues_ad_objects' })
    expect(out.preview.warnings.join(' ')).toMatch(/verification request .*META_WEBHOOK_VERIFY_TOKEN/)
    const done = await run(webhooks, { action: 'subscribe-app', object: 'ad_account', fields: ['effective_status', 'with_issues_ad_objects'] })
    expect(done.ok).toBe(true)
    expect(sent()[0]).toMatchObject({
      objectId: '1234567', kind: 'app', edge: 'subscriptions', operation: 'webhooks.subscribeApp', via: { auth: 'app' },
      params: { object: 'ad_account', callback_url: 'https://api.example.test/webhooks/meta/1234567', fields: 'effective_status,with_issues_ad_objects', include_values: 'true' },
    })
    expect(sent()[0].params).not.toHaveProperty('verify_token')
    const undo = webhooks.undo!.request(done.change)
    expect(undo).toEqual({ tool: 'set-meta-webhooks', args: { connectionId: 'm-1', action: 'unsubscribe-app', object: 'ad_account', fields: ['with_issues_ad_objects'], why: expect.any(String) } })
    expect(webhooks.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
    expect(await webhooks.undo!.current({ before: done.change.before, after: done.change.after })).toMatchObject({ fields: ['effective_status'] })
  })

  it('subscribe-app: nothing to change when already sent to Nexus; another callback is replaced, said, and never written back', async () => {
    h.app = [{ object: 'page', fields: ['leadgen', 'feed'], active: true, nexusCallback: true, callbackOrigin: 'https://api.example.test' }]
    expect(await preview(webhooks, { action: 'subscribe-app', object: 'page', fields: ['leadgen'] })).toEqual({ ok: false, error: expect.stringMatching(/^Nothing to change: page: leadgen already subscribed/) })
    h.app = [{ object: 'page', fields: ['leadgen'], active: true, nexusCallback: false, callbackOrigin: 'https://other.example' }]
    const out = await preview(webhooks, { action: 'subscribe-app', object: 'page', fields: ['leadgen'] })
    expect(out.preview.warnings.join(' ')).toMatch(/now calls https:\/\/other\.example; this change points it at Nexus's receiver/)
    expect(out.preview.warnings).toContainEqual(expect.stringMatching(/^No undo for: The earlier callback \(https:\/\/other\.example\) is not put back/))
    expect(await preview(webhooks, { action: 'subscribe-app', object: 'instagram' })).toEqual({ ok: false, error: DASHBOARD_ONLY })
    // M22 — the per-account Instagram step Nexus cannot do yet is named.
    expect(DASHBOARD_ONLY).toMatch(/linked Facebook Page's \/subscribed_apps with the Instagram fields — which Nexus cannot do yet/)
    expect(() => webhooks.input.parse({ action: 'subscribe-app', object: 'ad_account', fields: ['photos'] })).toThrow()
    expect(await preview(webhooks, { action: 'subscribe-app', object: 'catalog', fields: ['leadgen'] })).toEqual({ ok: false, error: expect.stringMatching(/does not take leadgen on catalog/) })
    vi.stubEnv('NEXUS_PUBLIC_API_URL', ''); vi.stubEnv('PUBLIC_API_URL', ''); vi.stubEnv('RAILWAY_PUBLIC_DOMAIN', '')
    expect(await preview(webhooks, { action: 'subscribe-app', object: 'catalog' })).toEqual({ ok: false, error: expect.stringMatching(/Nexus has no callback to give Meta/) })
  })

  it('unsubscribe-app: a DELETE that always names its object; the undo subscribes back to Nexus only', async () => {
    h.app = [{ object: 'catalog', fields: ['items_batch', 'product_feed'], active: true, nexusCallback: true, callbackOrigin: 'https://api.example.test' }]
    const done = await run(webhooks, { action: 'unsubscribe-app', object: 'catalog' })
    expect(sent()[0]).toMatchObject({ objectId: '1234567', method: 'DELETE', params: {}, via: { auth: 'app', query: { object: 'catalog' } } })
    expect(webhooks.undo!.request(done.change)).toMatchObject({ tool: 'set-meta-webhooks', args: { action: 'subscribe-app', object: 'catalog', fields: ['items_batch', 'product_feed'] } })
    h.send.mockClear()
    await run(webhooks, { action: 'unsubscribe-app', object: 'catalog', fields: ['product_feed'] })
    expect(sent()[0].via).toEqual({ auth: 'app', query: { object: 'catalog', fields: 'product_feed' } })
    expect(await preview(webhooks, { action: 'unsubscribe-app' })).toEqual({ ok: false, error: expect.stringMatching(/^Name the object/) })
    h.app = [{ object: 'catalog', fields: ['items_batch'], active: true, nexusCallback: false, callbackOrigin: 'https://other.example' }]
    const foreign = await run(webhooks, { action: 'unsubscribe-app', object: 'catalog' })
    expect(webhooks.undo!.request(foreign.change)).toEqual({ refusal: expect.stringMatching(/not Nexus: Nexus cannot subscribe it back there/) })
    expect(() => webhooks.input.parse({ action: 'subscribe-app', object: 'constructor' })).toThrow()
  })

  it('connect / disconnect the CHOSEN ad account (Meta needs an admin: said); each the other\'s undo', async () => {
    const out = await preview(webhooks, { action: 'connect-ad-account' })
    expect(out.preview.warnings.join(' ')).toMatch(/ADMIN of the ad account/)
    const done = await run(webhooks, { action: 'connect-ad-account' })
    expect(sent()[0]).toMatchObject({ objectId: 'act_1234567890', kind: 'adaccount', edge: 'subscribed_apps', params: { app_id: '1234567' } })
    expect(webhooks.undo!.request(done.change)).toMatchObject({ args: { action: 'disconnect-ad-account' } })
    h.adAccount = { connected: true, otherApps: 1 }
    expect(await preview(webhooks, { action: 'connect-ad-account' })).toEqual({ ok: false, error: expect.stringMatching(/already connected/) })
    h.send.mockClear()
    const off = await run(webhooks, { action: 'disconnect-ad-account' })
    expect(sent()[0]).toMatchObject({ objectId: 'act_1234567890', method: 'DELETE', params: {}, via: { query: { app_id: '1234567' } } })
    expect(webhooks.undo!.request(off.change)).toMatchObject({ args: { action: 'connect-ad-account' } })
  })

  it('install-page answers with Meta\'s own roads (a Page token); remove-page goes with the app token, reads nothing, has no undo', async () => {
    expect(await preview(webhooks, { action: 'install-page' })).toEqual({ ok: false, error: PAGE_INSTALL_ROADS })
    expect(PAGE_INSTALL_ROADS).toMatch(/Meta Business Suite › All Tools › Business Apps/)
    expect(PAGE_INSTALL_ROADS).toMatch(/Graph API Explorer with a Page token/)
    const out = await preview(webhooks, { action: 'remove-page' })
    expect(out.preview.warnings.join(' ')).toMatch(/Nexus cannot read which apps are installed on the Page/)
    expect(out.preview.warnings).toContainEqual(expect.stringMatching(/^No undo for: It has no undo: Nexus does not install the app on a Page/))
    const off = await run(webhooks, { action: 'remove-page' })
    expect(sent()[0]).toMatchObject({ objectId: '120000000000010', kind: 'page', method: 'DELETE', via: { auth: 'app' } })
    expect(webhooks.undo!.request(off.change)).toEqual({ refusal: expect.stringMatching(/It has no undo: Nexus does not install the app on a Page/) })
    h.pageId = null
    expect(await preview(webhooks, { action: 'remove-page' })).toEqual({ ok: false, error: expect.stringMatching(/no Facebook Page chosen/) })
  })

  it('review A1 / D-1 — app-wide: another business on the same app is warned on a subscribe (no undo) and blocks an unsubscribe', async () => {
    h.users = { users: [{ workspaceId: 'nexus_legacy_workspace', connectionId: 'm-1' }, { workspaceId: 'ws-other', connectionId: 'm-9' }], unsure: false }
    const out = await preview(webhooks, { action: 'subscribe-app', object: 'ad_account' })
    expect(out.preview.warnings.join(' ')).toMatch(/app-wide: another business in Nexus uses the same Meta app, so this also changes what it receives/)
    expect(JSON.stringify(out.preview)).not.toMatch(/ws-other|m-9/)
    const done = await run(webhooks, { action: 'subscribe-app', object: 'ad_account' })
    expect(webhooks.undo!.request(done.change)).toEqual({ refusal: expect.stringMatching(/once Nexus subscribes, only Meta's App Dashboard can remove it/) })
    // Re-review 1 — and the approver read it before approving.
    expect(out.preview.warnings).toContainEqual(expect.stringMatching(/^No undo for: This subscription: another business in Nexus uses this Meta app, so once Nexus subscribes, only Meta's App Dashboard can remove it/))
    h.app = [{ object: 'ad_account', fields: ['effective_status'], active: true, nexusCallback: true, callbackOrigin: 'https://api.example.test' }]
    expect(await preview(webhooks, { action: 'unsubscribe-app', object: 'ad_account' })).toEqual({ ok: false, error: expect.stringMatching(/Another business in Nexus uses this Meta app.*App Dashboard/) })
    h.users = new Error('database unavailable')
    expect(await preview(webhooks, { action: 'unsubscribe-app', object: 'ad_account' })).toEqual({ ok: false, error: expect.stringMatching(/could not tell whether another business/) })
    // M5b — an app id that could not be read (unsure, no throw) is "could not tell" too.
    h.users = { users: [{ workspaceId: 'nexus_legacy_workspace', connectionId: 'm-1' }], unsure: true }
    expect(await preview(webhooks, { action: 'unsubscribe-app', object: 'ad_account' })).toEqual({ ok: false, error: expect.stringMatching(/could not tell whether another business/) })
  })

  it('M3 / M4 — the count is part of what the change stands on; unknown, a first subscribe has no undo, said before approval', async () => {
    const live = { appId: '1234567', adAccountId: '1234567890', pageId: null, callback: { url: 'https://api.example.test/webhooks/meta/1234567' }, app: [] }
    const one = webhooksDraft({ action: 'subscribe-app', object: 'ad_account' }, { ...live, otherBusinesses: 1 }) as { stands: { otherBusinesses: number | null } }
    const none = webhooksDraft({ action: 'subscribe-app', object: 'ad_account' }, { ...live, otherBusinesses: 0 }) as { stands: { otherBusinesses: number | null } }
    expect([one.stands.otherBusinesses, none.stands.otherBusinesses]).toEqual([1, 0])
    const alone = await preview(webhooks, { action: 'subscribe-app', object: 'ad_account' })
    h.users = { users: [{ workspaceId: 'nexus_legacy_workspace', connectionId: 'm-1' }, { workspaceId: 'ws-other', connectionId: 'm-9' }], unsure: false }
    const shared = await preview(webhooks, { action: 'subscribe-app', object: 'ad_account' })
    expect(shared.preview.basis).not.toBe(alone.preview.basis)
    h.users = { users: [{ workspaceId: 'nexus_legacy_workspace', connectionId: 'm-1' }], unsure: true }
    const unknown = await preview(webhooks, { action: 'subscribe-app', object: 'ad_account' })
    expect(unknown.preview.warnings).toContainEqual(expect.stringMatching(/^No undo for: Nexus could not tell whether another business .*only Meta's App Dashboard can remove it/))
    const done = await run(webhooks, { action: 'subscribe-app', object: 'ad_account' })
    expect(webhooks.undo!.request(done.change)).toEqual({ refusal: expect.stringMatching(/could not tell whether another business/) })
  })

  it('re-review 3 — with another business on the app, an application or catalog subscription is said to reach nobody', async () => {
    h.users = { users: [{ workspaceId: 'nexus_legacy_workspace', connectionId: 'm-1' }, { workspaceId: 'ws-other', connectionId: 'm-9' }], unsure: false }
    expect((await preview(webhooks, { action: 'subscribe-app', object: 'catalog' })).preview.warnings).toContainEqual(expect.stringMatching(/routes no catalog notification .*reaches nobody in Nexus/))
    expect((await preview(webhooks, { action: 'subscribe-app', object: 'application' })).preview.warnings).toContainEqual(expect.stringMatching(/dev_alerts, async_requests name no business/))
    expect((await preview(webhooks, { action: 'subscribe-app', object: 'ad_account' })).preview.warnings.join(' ')).not.toMatch(/reaches nobody|reach nobody/)
  })

  it('review A2 / A3 — fields kept sorted whatever Meta\'s order; an undo subscribes back only fields Nexus takes, naming the rest', async () => {
    h.app = [{ object: 'page', fields: ['photos', 'leadgen', 'feed'], active: true, nexusCallback: true, callbackOrigin: 'https://api.example.test' }]
    const done = await run(webhooks, { action: 'unsubscribe-app', object: 'page' })
    expect(done.change.before.fields).toEqual(['feed', 'leadgen', 'photos'])
    expect(webhooks.undo!.request(done.change)).toMatchObject({ args: { action: 'subscribe-app', object: 'page', fields: ['feed', 'leadgen'] } })
    expect(done.change.before.noUndo).toEqual([expect.stringMatching(/does not take photos/)])
    h.app = [{ object: 'page', fields: ['leadgen', 'feed'], active: true, nexusCallback: true, callbackOrigin: 'https://api.example.test' }]
    h.send.mockClear()
    const added = await run(webhooks, { action: 'subscribe-app', object: 'page', fields: ['mention'] })
    h.app = [{ object: 'page', fields: ['mention', 'leadgen', 'feed'], active: true, nexusCallback: true, callbackOrigin: 'https://api.example.test' }]
    expect(added.change.after.fields).toEqual(['feed', 'leadgen', 'mention'])
    expect(await webhooks.undo!.current({ before: added.change.before, after: added.change.after })).toMatchObject({ fields: ['feed', 'leadgen', 'mention'] })
  })

  it('no app stored for the connection: refused in words', async () => {
    h.appId = null
    expect(await preview(webhooks, { action: 'connect-ad-account' })).toEqual({ ok: false, error: expect.stringMatching(/No Meta app id and secret are stored/) })
  })
})

describe('set-meta-alert-subscription and remove-meta-alert-subscription', () => {
  it('create: the exact form Meta gets; money in minor units; the new id is the record\'s; undo removes exactly that one', async () => {
    const args = { action: 'create', eventType: 'INSIGHTS_UPDATED', entityType: 'AD', field: 'cpc', operator: 'GREATER_THAN', thresholdCents: [200] }
    const out = await preview(alerts, args)
    expect(out.preview).toMatchObject({ spendsMoney: false, requests: [{ label: 'Create an alert subscription (INSIGHTS_UPDATED)', metaCheck: 'no-check' }] })
    expect(out.preview.summary).toMatch(/when an ad's cpc is GREATER_THAN 200 \(minor units\)/)
    expect(out.preview.warnings.join(' ')).toMatch(/only when the app is subscribed to it and the ad account is connected/)
    h.send.mockImplementation(ok({ subscription_id: '120000000000041' }))
    const done = await run(alerts, args)
    expect(sent()[0]).toMatchObject({ objectId: 'act_1234567890', kind: 'adaccount', edge: 'subscriptions', via: {}, params: { event_type: 'INSIGHTS_UPDATED', filters: '[{"field":"entity_type","value":"AD","operator":"EQUAL"}]', field: 'cpc', operator: 'GREATER_THAN', value: '200' } })
    expect(done.data.subscriptionId).toBe('120000000000041')
    const undo = alerts.undo!.request(done.change)
    expect(undo).toEqual({ tool: 'remove-meta-alert-subscription', args: { connectionId: 'm-1', subscriptionId: '120000000000041', confirmDelete: true, why: expect.any(String) } })
    expect(remove.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
  })

  it('create: conditions judged before anything is queued (ranges, milestones, filters)', async () => {
    expect(await preview(alerts, { action: 'create', eventType: 'INSIGHTS_MILESTONE_REACHED', entityType: 'CAMPAIGN', field: 'impressions', threshold: [500] })).toEqual({ ok: false, error: expect.stringMatching(/at least 1000/) })
    expect(await preview(alerts, { action: 'create', eventType: 'INSIGHTS_UPDATED', entityType: 'AD', field: 'ctr', operator: 'IN_RANGE', threshold: [2] })).toEqual({ ok: false, error: expect.stringMatching(/two values: low, then high/) })
    expect(await preview(alerts, { action: 'create', eventType: 'OBJECT_CREATED', entityType: 'CAMPAIGN', field: 'name' })).toEqual({ ok: false, error: expect.stringMatching(/no field or operator/) })
    const filtered = await preview(alerts, { action: 'create', eventType: 'OBJECT_CREATED', entityType: 'CAMPAIGN', filters: [{ field: 'objective', operator: 'IN', values: ['OUTCOME_SALES', 'OUTCOME_LEADS'] }] })
    expect(filtered.ok).toBe(true)
    // Review B2 — the IN filter's values go as a real JSON list inside filters.
    expect(alertParamsOf({ eventType: 'OBJECT_CREATED', entityType: 'CAMPAIGN', filters: [{ field: 'objective', operator: 'IN', values: ['OUTCOME_SALES', 'OUTCOME_LEADS'] }] })).toEqual({ params: { event_type: 'OBJECT_CREATED', filters: '[{"field":"entity_type","value":"CAMPAIGN","operator":"EQUAL"},{"field":"objective","value":["OUTCOME_SALES","OUTCOME_LEADS"],"operator":"IN"}]' } })
    expect(alertParamsOf({ eventType: 'OBJECT_UPDATED', entityType: 'ADSET', field: 'start_time', operator: 'GREATER_THAN', thresholdTime: ['2026-11-01T00:00:00Z'] })).toMatchObject({ params: { value: '1793491200' } })
    // Review B5 — the field's own level; an objective IN on campaigns (the WH-051f probe's second case).
    expect(alertParamsOf({ eventType: 'OBJECT_UPDATED', entityType: 'CAMPAIGN', field: 'daily_budget' })).toEqual({ refusal: expect.stringMatching(/daily_budget is a setting of an ad set/) })
    expect(alertParamsOf({ eventType: 'OBJECT_UPDATED', entityType: 'CAMPAIGN', field: 'objective', operator: 'IN', thresholdList: ['OUTCOME_SALES'] })).toEqual({ params: { event_type: 'OBJECT_UPDATED', filters: '[{"field":"entity_type","value":"CAMPAIGN","operator":"EQUAL"}]', field: 'objective', operator: 'IN', value: '["OUTCOME_SALES"]' } })
    expect(alertParamsOf({ eventType: 'INSIGHTS_MILESTONE_REACHED', entityType: 'AD', field: 'clicks', operator: 'EQUAL', threshold: [10.5] })).toEqual({ refusal: expect.stringMatching(/a whole number/) })
  })

  it('enable / disable one subscription of the chosen account: a PATCH; the undo switches it back; unknown ones refused', async () => {
    h.alert = { ...ALERT }
    expect(await preview(alerts, { action: 'enable', subscriptionId: ALERT.subscriptionId })).toEqual({ ok: false, error: expect.stringMatching(/already ENABLED/) })
    const done = await run(alerts, { action: 'disable', subscriptionId: ALERT.subscriptionId })
    expect(sent()[0]).toMatchObject({ objectId: 'act_1234567890', params: { status: 'DISABLED' }, via: { path: 'act_1234567890/subscriptions/120000000000040', method: 'PATCH' } })
    const undo = alerts.undo!.request(done.change)
    expect(undo).toMatchObject({ tool: 'set-meta-alert-subscription', args: { action: 'enable', subscriptionId: ALERT.subscriptionId } })
    expect(alerts.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
    h.alert = null
    expect(await preview(alerts, { action: 'disable', subscriptionId: '120000000000049' })).toEqual({ ok: false, error: expect.stringMatching(/no alert subscription 120000000000049/) })
  })

  it('remove: only on the explicit ask; a DELETE of that one; the undo makes it again with the same conditions', async () => {
    h.alert = { ...ALERT, value: '["100","250"]', operator: 'IN_RANGE', filters: [{ field: 'entity_type', value: 'CAMPAIGN', operator: 'EQUAL' }, { field: 'objective', value: ['OUTCOME_SALES'], operator: 'IN' }] }
    const done = await run(remove, { subscriptionId: ALERT.subscriptionId, confirmDelete: true })
    expect(sent()[0]).toMatchObject({ objectId: 'act_1234567890', method: 'DELETE', params: {}, via: { path: 'act_1234567890/subscriptions/120000000000040' } })
    const undo = remove.undo!.request(done.change) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'set-meta-alert-subscription', args: { action: 'create', eventType: 'INSIGHTS_UPDATED', entityType: 'CAMPAIGN', field: 'cpc', operator: 'IN_RANGE', thresholdCents: [100, 250], filters: [{ field: 'objective', operator: 'IN', values: ['OUTCOME_SALES'] }] } })
    // Review A7 — that it is made again is said, not listed as something with no way back (M21: said in the preview).
    expect(done.change.before.noUndo).toEqual([])
    h.alert = { ...ALERT }
    expect((await preview(remove, { subscriptionId: ALERT.subscriptionId, confirmDelete: true })).preview.warnings).toContain('Its undo makes it again with the same conditions; Meta gives it a new id.')
    // Re-review 1 — an alert Nexus cannot write the same way: no undo, said before approval.
    h.alert = { ...ALERT, filters: [{ field: 'entity_type', value: 'PAGE', operator: 'EQUAL' }] }
    expect((await preview(remove, { subscriptionId: ALERT.subscriptionId, confirmDelete: true })).preview.warnings).toContainEqual(expect.stringMatching(/^No undo for: Nexus cannot write these conditions again the same way/))
    const parsed = alerts.input.parse(undo.args) as Record<string, unknown>
    // Made again, it is the same request Meta got before.
    expect(alertParamsOf(parsed as never)).toEqual({ params: { event_type: 'INSIGHTS_UPDATED', filters: '[{"field":"entity_type","value":"CAMPAIGN","operator":"EQUAL"},{"field":"objective","value":["OUTCOME_SALES"],"operator":"IN"}]', field: 'cpc', operator: 'IN_RANGE', value: '["100","250"]' } })
    expect(alertSpecOf({ ...ALERT, filters: [{ field: 'entity_type', value: 'PAGE', operator: 'EQUAL' }] } as never)).toBeNull()
  })
})
