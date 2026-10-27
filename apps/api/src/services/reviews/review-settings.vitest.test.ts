/**
 * Reviews › Settings — the defaults (today's behaviour), what a save may hold, the voice in an AI reply, templates and
 * their limits, the Sources rows and the pipeline jobs in words. The pure parts run without a database; the last block
 * runs the readers and writers against real SQL (PGlite with the production schema and policies): one settings row
 * per business, a template name taken once, a review automation switched and any other rule refused.
 *
 * Every word a person reads is checked for setting names: no variable name ever reaches the screen.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import {
  DEFAULT_ALERTS, DEFAULT_VOICE, alertsFromJson, replyLocale, splitFrom, templateProblem, validateSettingsInput, validateTemplateInput,
  voiceFromRow, voicePromptLines, withSignOff, type AlertSetting, type VoiceSettings,
} from './review-settings.service.js'
import {
  everyWords, freshnessProblems, nextCronRun, pipelineJobDefs, pipelineJobs, scrubCode, sellerFeedbackRow, settingsSourceRows, withTopicReads, type CronRunFact,
} from './review-settings-health.js'
import type { SellerFeedbackState } from './amazon-seller-feedback.service.js'
import type { SourceFacts } from './review-sources.service.js'
import { etsySource } from './review-shop-channel-math.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const SETTING_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/
const NOW = new Date('2026-10-26T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)
const daysAgo = (d: number) => hoursAgo(d * 24)

const voice = (over: Partial<VoiceSettings> = {}): VoiceSettings => ({ ...DEFAULT_VOICE, languages: ['buyer'], ...over })
const alerts = (): AlertSetting[] => alertsFromJson(null)
const team = new Set(['u1', 'u2'])
const ctx = { voice: voice(), alerts: alerts(), teamIds: team }

describe('defaults are today’s behaviour', () => {
  it('no row: neutral, the buyer’s language, no sign-off; negative alert in Nexus to the owners; the digest on', () => {
    expect(voiceFromRow(null)).toEqual({ tone: 'NEUTRAL', languages: ['buyer'], signOff: null, avoidWords: [] })
    expect(alertsFromJson(undefined)).toEqual(DEFAULT_ALERTS)
  })

  it('an odd row reads as its defaults, never throws', () => {
    expect(voiceFromRow({ tone: 'LOUD', languages: ['xx'], signOff: '  ', avoidWords: [' cheap ', ''] }))
      .toEqual({ tone: 'NEUTRAL', languages: ['buyer'], signOff: null, avoidWords: ['cheap'] })
    const read = alertsFromJson([{ key: 'digest', on: false, recipients: ['u1', 'u1'], via: ['app'] }, { key: 'other' }])
    expect(read.find((a) => a.key === 'digest')).toEqual({ key: 'digest', on: false, recipients: ['u1'], via: ['email'] })
    expect(read.find((a) => a.key === 'negative')).toEqual(DEFAULT_ALERTS[0])
  })
})

describe('what a save may hold', () => {
  it('nothing to save', () => {
    expect(validateSettingsInput({}, ctx)).toEqual({ ok: false, words: 'There is nothing to save.' })
  })

  it('a partial voice keeps the rest', () => {
    const r = validateSettingsInput({ voice: { tone: 'WARM' } }, ctx)
    expect(r.ok && r.voice).toEqual({ ...voice(), tone: 'WARM' })
    expect(r.ok && r.changed).toEqual({ voice: true, alerts: false })
  })

  it('refuses in words', () => {
    const words = (body: unknown) => {
      const r = validateSettingsInput(body, ctx)
      return r.ok ? null : r.words
    }
    expect(words({ voice: { tone: 'LOUD' } })).toBe('Pick a tone: Warm, Neutral or Formal.')
    expect(words({ voice: { languages: [] } })).toBe('Pick at least one reply language.')
    expect(words({ voice: { languages: ['pt'] } })).toMatch(/Italian, German, French, Spanish and English only/)
    expect(words({ voice: { signOff: 'x'.repeat(81) } })).toBe('Keep the sign-off to 80 characters (it has 81).')
    expect(words({ voice: { avoidWords: ['y'.repeat(41)] } })).toMatch(/at most 40 characters/)
    expect(words({ voice: { avoidWords: Array.from({ length: 31 }, (_, i) => `w${i}`) } })).toMatch(/30 words to avoid/)
    expect(words({ alerts: [{ key: 'negative', recipients: ['gone'] }] })).toMatch(/no longer a member of this business/)
    expect(words({ alerts: [{ key: 'negative', via: [] }] })).toBe('Choose how “New negative review” arrives: in Nexus, by e-mail or both.')
    expect(words({ alerts: [{ key: 'spike', on: true }] })).toMatch(/no such review alert/)
  })

  it('cleans words to avoid: trimmed, once each whatever the case', () => {
    const r = validateSettingsInput({ voice: { avoidWords: [' Cheap', 'cheap', 'refund ', ''] } }, ctx)
    expect(r.ok && r.voice.avoidWords).toEqual(['Cheap', 'refund'])
  })

  it('the digest always arrives by e-mail; a negative alert switched off needs no way to arrive', () => {
    const r = validateSettingsInput({ alerts: [{ key: 'digest', via: ['app'], recipients: ['u2'] }, { key: 'negative', on: false, via: [] }] }, ctx)
    expect(r.ok && r.alerts).toEqual([
      { key: 'negative', on: false, recipients: [], via: [] },
      { key: 'digest', on: true, recipients: ['u2'], via: ['email'] },
      { key: 'ratingDrop', on: false, recipients: [], via: ['app'] },
    ])
  })

  it('"Rating drop" is off until switched on, and arrives in Nexus, by e-mail or both', () => {
    expect(alertsFromJson(null).find((a) => a.key === 'ratingDrop')).toEqual({ key: 'ratingDrop', on: false, recipients: [], via: ['app'] })
    const on = validateSettingsInput({ alerts: [{ key: 'ratingDrop', on: true, via: ['app', 'email'], recipients: ['u2'] }] }, ctx)
    expect(on.ok && on.alerts.find((a) => a.key === 'ratingDrop')).toEqual({ key: 'ratingDrop', on: true, recipients: ['u2'], via: ['app', 'email'] })
    const words = (body: unknown) => {
      const r = validateSettingsInput(body, ctx)
      return r.ok ? null : r.words
    }
    expect(words({ alerts: [{ key: 'ratingDrop', on: true, via: [] }] })).toBe('Choose how “Rating drop” arrives: in Nexus, by e-mail or both.')
  })
})

describe('the voice in an AI reply', () => {
  it('replies in the buyer’s language unless the business replies in others only', () => {
    expect(replyLocale(['buyer'], 'de')).toBe('de')
    expect(replyLocale(['it', 'de'], 'de')).toBe('de')
    expect(replyLocale(['en', 'it'], 'fr')).toBe('en')
    expect(replyLocale([], 'es')).toBe('es')
  })

  it('tone, words to avoid, the sign-off and up to five saved replies in the reply’s language', () => {
    const templates = Array.from({ length: 7 }, (_, i) => ({ name: `T${i}`, bodies: i === 0 ? { de: 'Danke', en: 'Thanks' } : { en: `Reply ${i}` } }))
    const lines = voicePromptLines(voice({ tone: 'FORMAL', avoidWords: ['cheap'], signOff: 'The care team' }), templates, 'de')
    expect(lines[0]).toMatch(/formal/i)
    expect(lines).toContain('Never use these words: "cheap".')
    expect(lines).toContain('End with this sign-off on its own line: The care team')
    expect(lines).toContain('- T0: Danke')
    expect(lines.filter((l) => l.startsWith('- T'))).toHaveLength(5)
  })

  it('the sign-off only when it fits the channel’s limit', () => {
    expect(withSignOff('Thanks!', 'The team', null)).toBe('Thanks!\nThe team')
    expect(withSignOff('Thanks!\nThe team', 'The team', null)).toBe('Thanks!\nThe team')
    expect(withSignOff('x'.repeat(495), 'The team', 500)).toBe('x'.repeat(495))
    expect(withSignOff('Thanks!', null, 500)).toBe('Thanks!')
  })
})

describe('templates', () => {
  it('a whole template needs a name and one text; a partial one only what it changes', () => {
    expect(validateTemplateInput({ channel: 'EBAY', bodies: { en: 'Hi' } }, { partial: false })).toEqual({ ok: false, words: 'Give the template a name.' })
    expect(validateTemplateInput({ name: 'A', bodies: { en: '  ' } }, { partial: false })).toEqual({ ok: false, words: 'Write the reply in at least one language.' })
    expect(validateTemplateInput({ name: 'A', channel: 'WALMART', bodies: { en: 'x' } }, { partial: false })).toMatchObject({ ok: false })
    expect(validateTemplateInput({ name: 'A', channel: 'all', bodies: { en: ' Hi ', it: '' } }, { partial: false }))
      .toEqual({ ok: true, value: { name: 'A', channel: null, bodies: { en: 'Hi' } } })
    expect(validateTemplateInput({ bodies: { de: 'Hallo' } }, { partial: true })).toEqual({ ok: true, value: { bodies: { de: 'Hallo' } } })
  })

  it('eBay takes replies of up to 500 characters', () => {
    expect(templateProblem({ channel: 'EBAY', bodies: { de: 'x'.repeat(538) } })).toBe('eBay takes replies of up to 500 characters: shorten the German text by 38.')
    expect(templateProblem({ channel: null, bodies: { de: 'x'.repeat(538) } })).toBeNull()
  })
})

describe('the sender is read from the business identity', () => {
  it('splits a From header', () => {
    expect(splitFrom('"Care" <care@example.test>')).toEqual({ name: 'Care', address: 'care@example.test' })
    expect(splitFrom('Shop <ship@example.test>')).toEqual({ name: 'Shop', address: 'ship@example.test' })
    expect(splitFrom('ship@example.test')).toEqual({ name: null, address: 'ship@example.test' })
  })
})

describe('pipeline jobs', () => {
  it('schedules in words and the next run', () => {
    expect(everyWords('*/30 * * * *')).toBe('Every 30 min')
    expect(everyWords('17 * * * *')).toBe('Every hour')
    expect(everyWords('0 */6 * * *')).toBe('Every 6 hours')
    expect(everyWords('30 3 * * *')).toBe('Daily 03:30 UTC')
    expect(everyWords('0 6 * * 1')).toBe('Mondays 06:00 UTC')
    expect(nextCronRun('*/30 * * * *', NOW)?.toISOString()).toBe('2026-10-26T12:30:00.000Z')
    expect(nextCronRun('0 6 * * 1', NOW)?.toISOString()).toBe('2026-11-02T06:00:00.000Z')
    expect(nextCronRun('nonsense', NOW)).toBeNull()
  })

  it('takes setting names out of a failure code', () => {
    expect(scrubCode('RESEND_API_KEY not set')).toBe('a setting not set')
    expect(scrubCode('')).toBeNull()
  })

  it('each state from the latest run', () => {
    const run = (jobName: string, status: string, startedAt: Date, errorMessage: string | null = null): CronRunFact => ({ jobName, status, startedAt, finishedAt: null, errorMessage })
    const jobs = pipelineJobs(pipelineJobDefs({}), [
      run('review-ingest', 'SUCCESS', hoursAgo(0.2)),
      run('review-spike-detector', 'RUNNING', hoursAgo(3)),
      run('amazon-review-insights', 'FAILED', hoursAgo(6), 'HTTP 403 Unauthorized getItemReviewTopics NEXUS_ENABLE_AMAZON_REVIEW_INSIGHTS'),
      run('review-request-mailer', 'SUCCESS', hoursAgo(5)),
      run('review-attribution', 'SUCCESS', hoursAgo(1), null),
      run('review-rule-evaluator', 'RUNNING', hoursAgo(0.1)),
    ], { now: NOW, digestOff: true })
    const by = (key: string) => jobs.find((j) => j.key === key)!
    expect(by('review-ingest')).toMatchObject({ state: 'healthy', every: 'Every 30 min', nextRunAt: '2026-10-26T12:30:00.000Z' })
    expect(by('review-spike-detector')).toMatchObject({ state: 'stuck', tone: 'danger' })
    expect(by('amazon-review-insights')).toMatchObject({ state: 'failed', words: 'Amazon refused: the Selling Partner Insights role is missing. Fix it under Sources.' })
    expect(by('amazon-review-insights').code).toBe('HTTP 403 Unauthorized getItemReviewTopics a setting')
    expect(by('review-request-mailer')).toMatchObject({ state: 'late', tone: 'warning' })
    expect(by('review-rule-evaluator')).toMatchObject({ state: 'running' })
    expect(by('orders-delivered-backfill')).toMatchObject({ state: 'never', stateWords: 'Not run yet' })
    expect(by('review-digest')).toMatchObject({ state: 'off', words: 'Turned off under Alerts.', nextRunAt: null })
    expect(by('amazon-seller-feedback')).toMatchObject({ every: 'Daily 06:00 UTC', state: 'never' })
    for (const j of jobs) expect(`${j.words} ${j.stateWords} ${j.every} ${j.code ?? ''}`).not.toMatch(SETTING_NAME)
  })

  it('Amazon topics: the job row says what Sources says — refused for the missing role, or off with the last read (live audit B06)', () => {
    const topics = [
      { marketplace: 'DE', accessStatus: 'NEEDS_BRAND_ANALYTICS_ROLE', fetchedAt: hoursAgo(30) },
      { marketplace: 'IT', accessStatus: 'NEEDS_BRAND_ANALYTICS_ROLE', fetchedAt: hoursAgo(30) },
    ]
    const job = (state: 'never' | 'off') => pipelineJobs(pipelineJobDefs({}), [], { now: NOW, digestOff: false, offKeys: new Set(state === 'off' ? ['amazon-review-insights'] : []) }).find((j) => j.key === 'amazon-review-insights')!
    const never = withTopicReads(job('never'), topics)
    expect(never).toMatchObject({ state: 'failed', stateWords: 'Failed', tone: 'danger' })
    expect(never.words).toMatch(/was refused for Germany and Italy: the Selling Partner Insights role is missing/)
    const off = withTopicReads(job('off'), topics)
    expect(off).toMatchObject({ state: 'off', stateWords: 'Off' })
    expect(off.words).toMatch(/^Off in this setup \(see Sources\)\. The last read, on .*, was refused for Germany and Italy/)
    // No topic read at all: the job row is left as it is.
    expect(withTopicReads(job('never'), [])).toMatchObject({ state: 'never', stateWords: 'Not run yet' })
  })

  it('what the freshness guard found, never a setting name', () => {
    const words = freshnessProblems({ deliveryStale: true, overdueUndelivered: 12, schedulingStalled: true, schedulingBacklog: 20 })
    expect(words).toHaveLength(2)
    for (const w of words) expect(w).not.toMatch(SETTING_NAME)
  })
})

describe('sources', () => {
  const ETSY_OFF = etsySource({ connections: [{ id: 'e1', isActive: true, authStatus: 'connected', shopName: 'Shop' }], readOn: false, lastRun: null, lastOkAt: null, reviews: 0 })
  const facts = (over: Partial<SourceFacts> = {}): SourceFacts => ({
    connections: [], topics: [], reviewGroups: [], lastReadAt: hoursAgo(0.3), ebayListingMarkets: [], ebayFeedbackOn: true, amazonTopicsOn: true, ...over,
  })
  const conn = (channelType: string, marketplace: string, authStatus = 'connected') =>
    ({ id: `${channelType}-${marketplace}`, channelType, marketplace, isActive: true, authStatus, lastErrorAt: hoursAgo(3), isPrimary: true })

  it('the role missing, an eBay sign-in expired, later sources labelled; problems counted', () => {
    const { rows, problems } = settingsSourceRows(facts({
      connections: [conn('AMAZON', 'IT'), conn('EBAY', 'IT'), conn('EBAY', 'DE', 'needs_reauth')],
      topics: [{ marketplace: 'IT', accessStatus: 'OK', fetchedAt: daysAgo(13) }, { marketplace: 'IT', accessStatus: 'NEEDS_BRAND_ANALYTICS_ROLE', fetchedAt: daysAgo(6) }],
    }), { amazonSent30: [{ marketplace: 'IT', count: 40 }, { marketplace: 'DE', count: 12 }], amazonLastSentAt: hoursAgo(1), mailerPaused: null, etsy: ETSY_OFF, judgeme: null }, NOW)
    const by = (key: string) => rows.find((r) => r.key === key)!
    expect(by('amazon-requests')).toMatchObject({ stateWords: 'On', words: 'Sending in 2 markets · 52 in 30 days', action: { kind: 'rules' } })
    expect(by('amazon-topics')).toMatchObject({ stateWords: 'Needs a fix', tone: 'warning', lastWords: 'Last worked Tue 13 Oct', action: { kind: 'reconnect', href: '/settings/channels/amazon' } })
    expect(by('amazon-topics').words).toMatch(/Selling Partner Insights role is missing/)
    expect(by('amazon-topics').words).toMatch(/not on Amazon\.nl/)
    expect(by('ebay-feedback')).toMatchObject({ stateWords: 'Needs a fix', action: { kind: 'reconnect', label: 'Reconnect eBay Germany' } })
    expect(by('ebay-feedback').words).toMatch(/eBay Italy is fine\./)
    expect(by('amazon-seller-feedback')).toMatchObject({ later: null, action: { kind: 'fetch', label: 'Fetch now' } })
    // PR I: Etsy and the Shopify review app are real rows now; only the apps not built yet say "coming later".
    expect(by('etsy-reviews')).toMatchObject({ later: null, stateWords: 'Connected · not read yet', action: { kind: 'page', href: '/marketing/reviews/etsy' } })
    expect(by('shopify-app')).toMatchObject({ stateWords: 'Not connected', later: 'Okendo, Yotpo, Loox: coming later', action: { kind: 'app', label: 'Connect Judge.me…' } })
    expect(by('amazon-review-text')).toMatchObject({ stateWords: 'Not available', action: { kind: 'import' } })
    expect(by('amazon-review-text').words).toMatch(/no review text and no star rating by API/)
    expect(problems).toBe(2)
    for (const r of rows) expect(`${r.words} ${r.what} ${r.stateWords} ${r.later ?? ''}`).not.toMatch(SETTING_NAME)
  })

  it('Amazon seller feedback: off, on and fetched, a market refused, a sign-in to fix — in words, never a setting name', () => {
    const state = (over: Partial<SellerFeedbackState> = {}): SellerFeedbackState => ({
      on: true, every: 'Daily 06:00 UTC', markets: [], canFetch: true, held: null, fixHref: null, fetching: false, lastFetchAt: null, lastOkAt: null, ...over,
    })
    const market = (m: string, s: 'ok' | 'failed' | 'never' | 'fetching', rows: number | null, words = ''): SellerFeedbackState['markets'][number] =>
      ({ market: m, state: s, lastFetchAt: null, lastOkAt: s === 'ok' ? hoursAgo(5).toISOString() : null, rows, words })
    const off = sellerFeedbackRow(state({ on: false, canFetch: false, held: 'Nexus does not fetch Amazon seller feedback in this setup yet.' }))
    expect(off).toMatchObject({ stateWords: 'Off', tone: 'neutral', later: null, action: { kind: 'fetch', held: 'Nexus does not fetch Amazon seller feedback in this setup yet.' } })
    expect(off.words).toMatch(/^Off in this setup\. When it is on, Nexus asks Amazon for it daily at 06:00 UTC, and “Fetch now” asks at once\./)
    expect(off.words).toMatch(/only feedback of 1 to 3 stars/)
    const on = sellerFeedbackRow(state({ markets: [market('IT', 'ok', 7), market('DE', 'ok', 2)], lastOkAt: hoursAgo(5).toISOString() }))
    expect(on).toMatchObject({ stateWords: 'On', tone: 'success', words: 'Fetched daily at 06:00 UTC for Italy and Germany · 9 feedback of 1–3 stars in the last 90 days.', action: { kind: 'fetch', held: null } })
    const refused = sellerFeedbackRow(state({ markets: [market('IT', 'ok', 7), market('ES', 'failed', null, 'Amazon refused: the Amazon connection needs the Selling Partner Insights or Amazon Fulfillment role.')] }))
    expect(refused).toMatchObject({ stateWords: 'Needs a fix', tone: 'warning' })
    expect(refused.words).toMatch(/^Spain: Amazon refused/)
    expect(refused.words).toMatch(/Italy is fine\.$/)
    const signIn = sellerFeedbackRow(state({ markets: [market('IT', 'never', null)], canFetch: false, held: 'Sign-in expired. Nexus cannot ask Amazon for the report until someone connects Amazon again.', fixHref: '/settings/channels/amazon' }))
    expect(signIn).toMatchObject({ stateWords: 'Needs a fix', tone: 'danger', action: { kind: 'reconnect', href: '/settings/channels/amazon' } })
    expect(sellerFeedbackRow(state({ markets: [market('IT', 'never', null)] }))).toMatchObject({ stateWords: 'Waiting', tone: 'info' })
    expect(sellerFeedbackRow(state({ markets: [market('IT', 'fetching', null)], fetching: true }))).toMatchObject({ stateWords: 'Fetching', tone: 'info' })
    for (const r of [off, on, refused, signIn]) expect(`${r.words} ${r.stateWords} ${r.action?.held ?? ''}`).not.toMatch(SETTING_NAME)
  })

  it('a paused mailer and no eBay account', () => {
    const { rows } = settingsSourceRows(facts(), { amazonSent30: [], amazonLastSentAt: null, mailerPaused: { at: daysAgo(2) }, etsy: ETSY_OFF, judgeme: null }, NOW)
    expect(rows.find((r) => r.key === 'amazon-requests')).toMatchObject({ stateWords: 'Paused', tone: 'warning' })
    expect(rows.find((r) => r.key === 'ebay-feedback')).toMatchObject({ stateWords: 'Not connected', action: { kind: 'connect' } })
  })
})

describe('against real SQL', () => {
  let svc: typeof import('./review-settings.service.js')
  const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, work)

  beforeAll(async () => {
    database = await formulaDatabase()
    svc = await import('./review-settings.service.js')
  })
  afterAll(async () => { await database?.close() })

  it('no row reads the defaults; a save makes the one row and a second save updates it', async () => {
    const first = await inside(() => svc.readReviewSettings())
    expect(first.voice).toEqual(DEFAULT_VOICE)
    expect(first.alerts.map((a) => [a.key, a.on])).toEqual([['negative', true], ['digest', true], ['ratingDrop', false]])
    expect(first.ratingDropRule).toEqual({ recentDays: 7, beforeDays: 28, minRated: 5, dropAtLeast: 0.3, reopenAfterDays: 7 })
    expect(first.sender.editHref).toBe('/settings/company')
    expect(first.automationTemplates).toEqual({ total: 3, missing: 3 })

    const saved = await inside(() => svc.saveReviewSettings({ voice: { tone: 'WARM', signOff: 'The care team' } }, 'actor-1'))
    expect(saved.ok && saved.settings.voice).toMatchObject({ tone: 'WARM', signOff: 'The care team', languages: ['buyer'] })
    const again = await inside(() => svc.saveReviewSettings({ alerts: [{ key: 'digest', on: false }] }, 'actor-1'))
    expect(again.ok && again.settings.alerts.find((a) => a.key === 'digest')?.on).toBe(false)
    expect(again.ok && again.settings.voice.tone).toBe('WARM')
    expect(await inside(() => database.client.reviewSettings.count())).toBe(1)

    const refused = await inside(() => svc.saveReviewSettings({ voice: { languages: [] } }, 'actor-1'))
    expect(refused).toEqual({ ok: false, words: 'Pick at least one reply language.' })
  })

  it('templates: made once per name, edited within eBay’s limit, picked, deleted', async () => {
    const made = await inside(() => svc.createReplyTemplate({ name: 'Size advice', channel: 'EBAY', bodies: { it: 'Grazie', en: 'Thanks' } }, 'actor-1'))
    expect(made.ok && made.template).toMatchObject({ name: 'Size advice', channel: 'EBAY', languages: ['it', 'en'], usedCount: 0 })
    const id = made.ok ? made.template.id : ''
    expect(await inside(() => svc.createReplyTemplate({ name: 'Size advice', bodies: { en: 'x' } }, null))).toMatchObject({ ok: false, code: 409 })
    expect(await inside(() => svc.updateReplyTemplate(id, { bodies: { de: 'x'.repeat(501) } }))).toMatchObject({ ok: false, code: 400 })
    expect(await inside(() => svc.updateReplyTemplate(id, { channel: null, bodies: { de: 'x'.repeat(501) } }))).toMatchObject({ ok: true })
    await inside(() => svc.createReplyTemplate({ name: 'Late delivery', channel: 'AMAZON', bodies: { en: 'Sorry' } }, null))
    expect((await inside(() => svc.listReplyTemplates({ channel: 'EBAY' }))).map((t) => t.name)).toEqual(['Size advice'])
    expect(await inside(() => svc.markReplyTemplateUsed(id))).toEqual({ ok: true, usedCount: 1 })
    expect(await inside(() => svc.deleteReplyTemplate(id))).toEqual({ ok: true, name: 'Size advice' })
    expect(await inside(() => svc.deleteReplyTemplate(id))).toMatchObject({ ok: false, code: 404 })
  })

  it('switches review automations only', async () => {
    const [review, ads] = await inside(() => Promise.all([
      database.client.automationRule.create({ data: { name: 'Tag size complaints', domain: 'reviews', trigger: 'REVIEW_INGESTED' } }),
      database.client.automationRule.create({ data: { name: 'Bid rule', domain: 'advertising', trigger: 'SCHEDULE' } }),
    ]))
    expect(await inside(() => svc.setReviewAutomationEnabled(review.id, true))).toMatchObject({ ok: true, rule: { enabled: true } })
    expect(await inside(() => svc.setReviewAutomationEnabled(ads.id, true))).toMatchObject({ ok: false, code: 404 })
    expect(await inside(() => svc.setReviewAutomationEnabled(review.id, 'yes'))).toMatchObject({ ok: false, code: 400 })
  })
})
