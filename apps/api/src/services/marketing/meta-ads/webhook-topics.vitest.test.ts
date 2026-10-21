/**
 * Meta ads step 30 — what a verified Meta delivery is read as: its changes and topics, the business key each is routed
 * by, the allow-listed value kept (never what a person wrote, never an amount), the delivery key that makes Meta's
 * retries no-ops, and the notice each topic raises. Made-up ids (public repo).
 */
import { describe, expect, it } from 'vitest'
import {
  META_HANDLED_TOPICS, META_WEBHOOK_TOPICS, keptValue, messagingFieldOf, metaChangeKey, metaChangeTime, metaRouteOf, metaTopicOf,
  metaSignatureNotice, metaWebhookChanges, metaWebhookNotice, metaWebhookPayload, parseMetaJson, type MetaWebhookChange,
} from './webhook-topics.js'
import { replayableEventTypes } from '../../cx/ingress/handlers.js'

const APP = '1234567890123'
const ACT = '1234567890'
const PAGE = '120000000000001'
const IG = '17840000000000001'

const adAccountBody = (changes: unknown[]) => ({ object: 'ad_account', entry: [{ id: ACT, time: 1782862117, changes }] })

describe('the envelope', () => {
  it('keeps ids JSON.parse cannot hold exactly as their digits (campaign ids are 15–18 digits)', () => {
    const body = parseMetaJson(Buffer.from('{"object":"ad_account","entry":[{"id":"1234567890","time":1782862117,"changes":[{"field":"subscriptions","value":{"subscription_id":1111111111,"object_id":120210000000000001,"account_id":1234567890}}]}]}')) as any
    const value = body.entry[0].changes[0].value
    expect(value.object_id).toBe('120210000000000001')
    expect(value.subscription_id).toBe(1111111111)
    expect(body.entry[0].time).toBe(1782862117)
  })

  it('reads effective status from field_changed + changed_fields, and every ads topic as <object>.<field>', () => {
    const changes = metaWebhookChanges(adAccountBody([
      { field: 'field_changed', value: { object_id: '120000000000301', object_type: 'ad', changed_fields: ['effective_status'] } },
      { field: 'with_issues_ad_objects', value: { id: '120000000000301', level: 'AD', error_code: '567', error_summary: 'Rejected', error_message: 'Your ad was rejected' } },
      { field: 'field_changed', value: { object_id: '120000000000301', object_type: 'ad', changed_fields: ['name'] } },
    ]))!
    expect(changes.map(metaTopicOf)).toEqual(['ad_account.effective_status', 'ad_account.with_issues_ad_objects', 'ad_account.field_changed'])
    expect(changes[0]).toMatchObject({ object: 'ad_account', source: 'changes', entryId: ACT, time: 1782862117 })
  })

  it('reads Messenger and Instagram events by the key that carries them, standby and changed_fields too', () => {
    const page = metaWebhookChanges({ object: 'page', entry: [{ id: PAGE, time: 1458692752478,
      messaging: [
        { sender: { id: '7000000000000001' }, recipient: { id: PAGE }, timestamp: 1, message: { mid: 'm1', text: 'hello, world!' } },
        { sender: { id: PAGE }, recipient: { id: '7000000000000001' }, timestamp: 2, message: { mid: 'm2', is_echo: true, text: 'hi' } },
        { sender: { id: '7000000000000001' }, recipient: { id: PAGE }, timestamp: 3, referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: '120000000000301', ref: 'spring' } },
        { recipient: { id: PAGE }, timestamp: 4, policy_enforcement: { action: 'block', reason: 'spam' } },
        { sender: { id: '7000000000000001' }, recipient: { id: PAGE }, timestamp: 5, read: { watermark: 9 } },
      ],
      standby: [{ sender: { id: '7000000000000001' }, recipient: { id: PAGE }, timestamp: 6, message: { mid: 'm3', text: 'x' } }],
      changed_fields: ['ratings'],
    }] })!
    expect(page.map(metaTopicOf)).toEqual(['page.messages', 'page.message_echoes', 'page.messaging_referrals', 'page.messaging_policy_enforcement', 'page.message_reads', 'page.standby', 'page.ratings'])
    expect(messagingFieldOf('instagram', { read: { mid: 'm' } })).toBe('messaging_seen')
    expect(messagingFieldOf('instagram', { referral: { ad_id: '1' } })).toBe('messaging_referral')
    expect(messagingFieldOf('instagram', { pass_thread_control: {} })).toBe('messaging_handover')
  })

  it('is null for anything that is not Meta\'s envelope; entries without an id are skipped', () => {
    expect(metaWebhookChanges(null)).toBeNull()
    expect(metaWebhookChanges({ entry: [] })).toBeNull()
    expect(metaWebhookChanges({ object: 'page', entry: 'x' })).toBeNull()
    expect(metaWebhookChanges({ object: 'page', entry: [{ changes: [{ field: 'feed', value: {} }] }] })).toEqual([])
  })
})

describe('routing keys', () => {
  const change = (object: string, field: string, value: Record<string, unknown> = {}, entryId = ACT): MetaWebhookChange => ({ object, source: 'changes', entryId, time: 1, field, value })
  it('ad account topics by the entry (act_ dropped); application ones by the account their value names', () => {
    expect(metaRouteOf(change('ad_account', 'with_issues_ad_objects'))).toEqual({ kind: 'AD_ACCOUNT', id: ACT })
    expect(metaRouteOf(change('ad_account', 'creative_fatigue', {}, `act_${ACT}`))).toEqual({ kind: 'AD_ACCOUNT', id: ACT })
    expect(metaRouteOf(change('application', 'ad_account', { id: ACT, account_status: 2 }, APP))).toEqual({ kind: 'AD_ACCOUNT', id: ACT })
    expect(metaRouteOf(change('application', 'ads_rules_engine', { account_id: ACT }, APP))).toEqual({ kind: 'AD_ACCOUNT', id: ACT })
    expect(metaRouteOf(change('application', 'ads_rules_engine', {}, APP))).toEqual({ kind: 'AD_ACCOUNT', id: null })
  })
  it('Pages, Instagram accounts and system users by the entry; app-level and catalog topics by the app; other objects not at all', () => {
    expect(metaRouteOf(change('page', 'leadgen', {}, PAGE))).toEqual({ kind: 'PAGE', id: PAGE })
    expect(metaRouteOf(change('page', 'ratings', {}, PAGE))).toEqual({ kind: 'PAGE', id: PAGE })
    expect(metaRouteOf(change('instagram', 'comments', {}, IG))).toEqual({ kind: 'INSTAGRAM', id: IG })
    expect(metaRouteOf(change('permissions', 'connected', { verb: 'disconnected' }, '120000000000009'))).toEqual({ kind: 'USER', id: '120000000000009' })
    expect(metaRouteOf(change('application', 'dev_alerts', {}, APP))).toEqual({ kind: 'APP', id: null })
    expect(metaRouteOf(change('catalog', 'items_batch', {}, '120000000000777'))).toEqual({ kind: 'APP', id: null })
    expect(metaRouteOf(change('user', 'photos'))).toBeNull()
    expect(metaRouteOf(change('whatsapp_business_account', 'messages'))).toBeNull()
  })
})

describe('what the ledger keeps', () => {
  it('only the topic\'s allow-listed paths: never a message, a name, a username, a PSID or an amount', () => {
    const [message, referral] = metaWebhookChanges({ object: 'page', entry: [{ id: PAGE, time: 1, messaging: [
      { sender: { id: '7000000000000001' }, recipient: { id: PAGE }, timestamp: 1, message: { mid: 'm1', text: 'my address is …', attachments: [{ type: 'image', payload: { url: 'https://example.invalid/x.jpg' } }] } },
      { sender: { id: '7000000000000001' }, recipient: { id: PAGE }, timestamp: 2, referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: '120000000000301', ref: 'spring', ads_context_data: { ad_title: 'Shop A jacket', photo_url: 'https://example.invalid/p.jpg', post_id: '120000000000555' } } },
    ] }] })!
    expect(metaWebhookPayload(APP, message).value).toEqual({ timestamp: 1, message: { mid: 'm1' } })
    expect(metaWebhookPayload(APP, referral).value).toEqual({ timestamp: 2, referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: '120000000000301', ref: 'spring', ads_context_data: { ad_title: 'Shop A jacket', post_id: '120000000000555' } } })
    // Review B1 — Facebook Login for Business: {from{id, username}, comment_id, parent_id, text, media{id, ad_id, ad_title, original_media_id, media_product_type}}.
    const [comment] = metaWebhookChanges({ object: 'instagram', entry: [{ id: IG, time: 1, changes: [{ field: 'comments', value: { from: { id: '1', username: 'someone' }, comment_id: '1790000000000001', parent_id: '1790000000000003', text: 'nice', media: { id: '1790000000000002', ad_id: '120000000000301', ad_title: 'Shop A jacket', original_media_id: '1790000000000004', media_product_type: 'FEED' } } }] }] })!
    expect(metaWebhookPayload(APP, comment).value).toEqual({ comment_id: '1790000000000001', parent_id: '1790000000000003', media: { id: '1790000000000002', ad_id: '120000000000301', original_media_id: '1790000000000004', media_product_type: 'FEED' } })
    // Review B2 / EN-041 — a Click-to-Messenger (or Click-to-Direct) ad click opens the thread with a messages event naming the ad.
    for (const object of ['page', 'instagram']) {
      const [fromAd] = metaWebhookChanges({ object, entry: [{ id: PAGE, time: 1, messaging: [{ sender: { id: '7000000000000001' }, recipient: { id: PAGE }, timestamp: 3, message: { mid: 'm9', text: 'is it in stock?', referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: '120000000000301', ref: 'spring', ads_context_data: { ad_title: 'Shop A jacket', photo_url: 'https://example.invalid/p.jpg', post_id: '120000000000555', product_id: '120000000000666' } } } }] }] })!
      expect(metaWebhookPayload(APP, fromAd).value).toEqual({ timestamp: 3, message: { mid: 'm9', referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: '120000000000301', ref: 'spring', ads_context_data: { ad_title: 'Shop A jacket', post_id: '120000000000555', product_id: '120000000000666' } } } })
    }
    const [fired] = metaWebhookChanges(adAccountBody([{ field: 'subscriptions', value: { subscription_id: '3333333333', account_id: ACT, object_id: '4444444444', object_type: 'adset', field: 'daily_budget', current_value: '1500' } }]))!
    expect(metaWebhookPayload(APP, fired).value).toEqual({ subscription_id: '3333333333', account_id: ACT, object_id: '4444444444', object_type: 'adset', field: 'daily_budget' })
    const [rule] = metaWebhookChanges({ object: 'application', entry: [{ id: APP, time: 1, changes: [{ field: 'ads_rules_engine', value: { rule_id: '1', account_id: ACT, object_id: '2', object_type: 'AD', trigger_type: 'STATS_CHANGE', trigger_field: 'spent', current_value: '{"spent":12345}' } }] }] })!
    expect(metaWebhookPayload(APP, rule).value).not.toHaveProperty('current_value')
    // A field Nexus has no use for keeps nothing of its value.
    const [unknown] = metaWebhookChanges({ object: 'page', entry: [{ id: PAGE, time: 1, changes: [{ field: 'ratings', value: { reviewer_name: 'Someone', review_text: 'x' } }] }] })!
    expect(metaWebhookPayload(APP, unknown)).toEqual({ appId: APP, object: 'page', entryId: PAGE, field: 'ratings', time: 1, value: {} })
  })

  it('caps text and lists, and keeps only scalars (a nested object is never kept wholesale)', () => {
    expect(keptValue({ a: 'x'.repeat(900), b: Array.from({ length: 80 }, (_, i) => i), c: { deep: { secret: 1 } } }, ['a', 'b', 'c'])).toEqual({ a: `${'x'.repeat(499)}…`, b: Array.from({ length: 50 }, (_, i) => i) })
  })

  it('review F4 — event ids key a change whatever entry.time says; Messenger events by message id and their own timestamp; states by time', () => {
    const lead = (time: number, leadgen_id = '120000000000901') => metaWebhookChanges({ object: 'page', entry: [{ id: PAGE, time, changes: [{ field: 'leadgen', value: { leadgen_id, form_id: '1', page_id: PAGE } }] }] })![0]
    expect(metaChangeKey(APP, lead(1))).toBe(metaChangeKey(APP, lead(99)))
    expect(metaChangeKey(APP, lead(1))).not.toBe(metaChangeKey(APP, lead(1, '120000000000902')))
    const message = (entryTime: number, timestamp: number, mid = 'm1') => metaWebhookChanges({ object: 'page', entry: [{ id: PAGE, time: entryTime, messaging: [{ sender: { id: '7' }, recipient: { id: PAGE }, timestamp, message: { mid, text: 'x' } }] }] })![0]
    expect(metaChangeKey(APP, message(1, 5))).toBe(metaChangeKey(APP, message(2, 5)))
    expect(metaChangeKey(APP, message(1, 5))).not.toBe(metaChangeKey(APP, message(1, 5, 'm2')))
    const read = (entryTime: number) => metaWebhookChanges({ object: 'page', entry: [{ id: PAGE, time: entryTime, messaging: [{ sender: { id: '7' }, recipient: { id: PAGE }, timestamp: 6, read: { watermark: 9 } }] }] })![0]
    expect(metaChangeKey(APP, read(1))).toBe(metaChangeKey(APP, read(2)))
    // A state with no event id (fatigue HIGH again next week) is a new change when Meta sends it at another time.
    const fatigue = (time: number) => metaWebhookChanges({ object: 'ad_account', entry: [{ id: ACT, time, changes: [{ field: 'creative_fatigue', value: { adgroup_id: '1', creative_fatigue_level: 'HIGH' } }] }] })![0]
    expect(metaChangeKey(APP, fatigue(1))).not.toBe(metaChangeKey(APP, fatigue(2)))
    // IG comments by their comment id.
    const comment = (time: number) => metaWebhookChanges({ object: 'instagram', entry: [{ id: IG, time, changes: [{ field: 'comments', value: { comment_id: '1790000000000001', text: 'x' } }] }] })![0]
    expect(metaChangeKey(APP, comment(1))).toBe(metaChangeKey(APP, comment(2)))
  })

  it('a change has one delivery key across retries and batches; another change, another key', () => {
    const [a] = metaWebhookChanges(adAccountBody([{ field: 'with_issues_ad_objects', value: { id: '1', level: 'AD' } }]))!
    const [again] = metaWebhookChanges({ object: 'ad_account', entry: [{ id: '999', time: 2, changes: [] }, { id: ACT, time: 1782862117, changes: [{ field: 'with_issues_ad_objects', value: { id: '1', level: 'AD' } }] }] })!
    const [other] = metaWebhookChanges(adAccountBody([{ field: 'with_issues_ad_objects', value: { id: '2', level: 'AD' } }]))!
    expect(metaChangeKey(APP, a)).toBe(metaChangeKey(APP, again))
    expect(metaChangeKey(APP, a)).not.toBe(metaChangeKey(APP, other))
    expect(metaChangeKey(APP, a)).not.toBe(metaChangeKey('9999999999999', a))
    expect(metaChangeKey(APP, a)).toMatch(/^meta:[0-9a-f]{64}$/)
  })

  it('entry.time in seconds or milliseconds', () => {
    expect(metaChangeTime(1782862117)?.toISOString()).toBe(new Date(1782862117000).toISOString())
    expect(metaChangeTime(1458692752478)?.toISOString()).toBe(new Date(1458692752478).toISOString())
    expect(metaChangeTime(null)).toBeNull()
  })
})

describe('the alerts inbox', () => {
  const payload = (object: string, field: string, value: Record<string, unknown>, entryId = ACT) => ({ appId: APP, object, entryId, field, time: 1, value })
  it('an object with issues: a warning naming the object and Meta\'s summary, deduped per object', () => {
    const n = metaWebhookNotice(payload('ad_account', 'with_issues_ad_objects', { id: '120000000000301', level: 'AD', error_code: '567', error_summary: 'Rejected' }))!
    expect(n).toMatchObject({ kind: 'meta-ads-object-issue', severity: 'warn', entityType: 'meta-ad-object', entityId: `${ACT}~120000000000301~issue~567`, href: '/marketing/ads/meta' })
    expect(n.body).toContain('ad 120000000000301')
    expect(n.body).toContain('"Rejected"')
  })
  it('only what needs a look: fatigue LOW, a grant, an approved review, a finished async run raise nothing', () => {
    expect(metaWebhookNotice(payload('ad_account', 'creative_fatigue', { adgroup_id: '1', creative_fatigue_level: 'LOW' }))).toBeNull()
    expect(metaWebhookNotice(payload('ad_account', 'creative_fatigue', { adgroup_id: '1', creative_fatigue_level: 'HIGH' }))?.severity).toBe('warn')
    expect(metaWebhookNotice(payload('permissions', 'social_ads', { verb: 'granted' }, '120000000000009'))).toBeNull()
    expect(metaWebhookNotice(payload('permissions', 'connected', { verb: 'disconnected' }, '120000000000009'))?.kind).toBe('meta-app-notice')
    expect(metaWebhookNotice(payload('page', 'product_review', { product_item_id: '1', status: 'APPROVED' }, PAGE))).toBeNull()
    expect(metaWebhookNotice(payload('page', 'product_review', { product_item_id: '1', status: 'REJECTED', reasons: ['Image'] }, PAGE))?.kind).toBe('meta-product-review')
    expect(metaWebhookNotice(payload('application', 'async_requests', { verb: 'complete' }, APP))).toBeNull()
    expect(metaWebhookNotice(payload('ad_account', 'ads_async_creation_request', { status: 'SUCCESS' }))).toBeNull()
    expect(metaWebhookNotice(payload('ad_account', 'ads_async_creation_request', { status: 'FAILED', result: { error_code: 100 } }))?.severity).toBe('warn')
  })
  it('the account status in Meta\'s words; disabled is danger, active again info', () => {
    expect(metaWebhookNotice(payload('application', 'ad_account', { id: ACT, account_status: 2, disable_reason: 1 }, APP))).toMatchObject({ kind: 'meta-ads-account-status', severity: 'danger', entityId: `${ACT}~status~2`, title: 'Meta: the ad account is now disabled' })
    expect(metaWebhookNotice(payload('application', 'ad_account', { id: ACT, account_status: 1 }, APP))?.severity).toBe('info')
  })
  it('a fired alert subscription names the field, never an amount', () => {
    const n = metaWebhookNotice(payload('ad_account', 'subscriptions', { subscription_id: '3333333333', object_id: '4444444444', object_type: 'adset', field: 'daily_budget' }))!
    expect(n.kind).toBe('meta-ads-alert-fired')
    expect(n.body).toContain('daily_budget')
    expect(n.body).not.toMatch(/1500|15\.00/)
  })
  it('review F1 — a state is in the subject, so opposite states never hide each other', () => {
    const fatigue = (level: string) => metaWebhookNotice(payload('ad_account', 'creative_fatigue', { adgroup_id: '1', creative_fatigue_level: level }))!.entityId
    expect(fatigue('MEDIUM')).not.toBe(fatigue('HIGH'))
    const feed = (status: string) => metaWebhookNotice(payload('catalog', 'product_feed', { product_feed_id: '9', status }, '120000000000777'))!.entityId
    expect(feed('Finished')).not.toBe(feed('Failed'))
    expect(metaWebhookNotice(payload('application', 'ad_account', { id: ACT, account_status: 1 }, APP))!.entityId).not.toBe(metaWebhookNotice(payload('application', 'ad_account', { id: ACT, account_status: 2 }, APP))!.entityId)
  })
  it('review B5 — messaging policy: block is danger, warning is warn, unblock is info; on the Page or Instagram account; a lead names its form and ad', () => {
    expect(metaWebhookNotice(payload('page', 'messaging_policy_enforcement', { policy_enforcement: { action: 'block', reason: 'spam' } }, PAGE))).toMatchObject({ kind: 'meta-messaging-policy', severity: 'danger', entityType: 'meta-page', entityId: `${PAGE}~policy~block` })
    expect(metaWebhookNotice(payload('page', 'messaging_policy_enforcement', { policy_enforcement: { action: 'warning', reason: 'spam' } }, PAGE))?.severity).toBe('warn')
    expect(metaWebhookNotice(payload('page', 'messaging_policy_enforcement', { policy_enforcement: { action: 'unblock' } }, PAGE))).toMatchObject({ severity: 'info', entityId: `${PAGE}~policy~unblock` })
    expect(metaWebhookNotice(payload('instagram', 'messaging_policy_enforcement', {}, IG))?.entityType).toBe('meta-instagram')
    expect(metaSignatureNotice(APP)).toMatchObject({ kind: 'meta-webhook-signature', severity: 'danger', entityId: `${APP}~signature` })
    expect(metaWebhookNotice(payload('page', 'leadgen', { form_id: '120000000000888', ad_id: '120000000000301' }, PAGE))?.body).toMatch(/form 120000000000888 from ad 120000000000301/)
  })
  it('a catalog batch says that requests with errors were not saved', () => {
    expect(metaWebhookNotice(payload('catalog', 'items_batch', { catalog_id: '120000000000777', handle: 'h1', status: 'Finished' }, '120000000000777'))?.body).toMatch(/NOT saved/)
  })
})

describe('the topic table', () => {
  it('the inbound replay registry lists exactly the topics a handler acts on', () => {
    const registered = replayableEventTypes().filter((e) => e.channel === 'META').map((e) => e.eventType).sort()
    expect(registered).toEqual([...META_HANDLED_TOPICS].sort())
  })

  it('every receiver row of step 30 is a topic (WH-001…004, CT-165/166 are the route and the catalog notes)', () => {
    const covered = new Set(Object.values(META_WEBHOOK_TOPICS).flatMap((t) => t.rows))
    const rows = ['LD-036', 'LD-050', 'EN-041', 'WH-016', 'WH-017', 'WH-018', 'WH-019', 'WH-020', 'WH-021', 'WH-022', 'WH-023', 'WH-024', 'WH-025', 'WH-026', 'WH-027',
      'WH-029', 'WH-030', 'WH-031', 'WH-033', 'WH-034', 'WH-035', 'WH-040', 'WH-041', 'WH-042', 'WH-043', 'WH-044', 'WH-046', 'WH-047', 'WH-048', 'WH-049', 'WH-050', 'CT-165']
    expect(rows.filter((r) => !covered.has(r))).toEqual([])
  })

  it('no topic keeps what a person wrote', () => {
    const forbidden = /(^|\.)(text|message|from|username|name|sender|recipient|current_value|email|phone|photo_url|video_url)$/
    const kept = Object.entries(META_WEBHOOK_TOPICS).flatMap(([topic, t]) => t.keep.filter((k) => forbidden.test(k)).map((k) => `${topic}:${k}`))
    expect(kept).toEqual([])
  })
})
