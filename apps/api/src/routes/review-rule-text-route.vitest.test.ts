/**
 * Reviews N3 (2026-10-27) — a review-request rule's own e-mail text per language, through the real routes on real SQL
 * (PGlite with the production schema and policies). Nothing is sent: the preview renders only.
 *   - a rule starts with no text of its own (the standard text); a saved text comes back on the rule and the rules list;
 *   - a text the check refuses (an incentive, happy buyers only, 5 stars, a missing button or unsubscribe link) is refused
 *     with the reason in words, and nothing is saved;
 *   - a language equal to the standard text is not stored; null puts the standard text back;
 *   - "Duplicate as A/B" copies the text; export carries it and import checks it again;
 *   - "Preview email" shows the rule's saved text, or the editor's unsaved one (refused in words when the check refuses it).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { STANDARD_REQUEST_TEXT } from '@nexus/shared/review-request-text'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    redis: { connection: null },
  }
})
vi.mock('../lib/auth/request-permission.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertAnyRequestPermission: vi.fn(async () => {}),
  requestUserId: vi.fn(() => 'test-user'),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

const ownEn = { subject: 'How is your {product}?', body: 'Hi {first_name},\n\nTell other riders what you think.\n\n{review_button}\n\nStop these e-mails? {unsubscribe_link}' }
const ownIt = { subject: 'Com’è {product}?', body: 'Ciao {first_name},\n\nRacconta com’è andata.\n\n{review_button}\n\nBasta email? {unsubscribe_link}' }

describe('N3 — a rule’s own e-mail text through the routes', () => {
  let app: FastifyInstance
  const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
    const response = await app.inject({ method, url: `/api${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) })
    return { status: response.statusCode, body: JSON.parse(response.body || '{}') }
  }
  const stored = async (id: string) => (await inside(() => database.client.reviewRule.findUniqueOrThrow({ where: { id } }))).emailText

  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      await database.client.reviewRule.create({ data: { id: 'rule-shop', name: 'Shop', scope: 'SHOPIFY', isActive: true, exclusions: [] } })
      await database.client.brandSettings.create({ data: { websiteUrl: 'https://shop.example.test' } as never })
    })
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { default: ordersReviewsRoutes } = await import('./orders-reviews.routes.js')
    await app.register(ordersReviewsRoutes, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await database?.close()
  })

  it('a rule starts with the standard text; a saved own text comes back on the rule and in the list', async () => {
    expect(await stored('rule-shop')).toBeNull()
    const saved = await call('PATCH', '/review-rules/rule-shop', { emailText: { en: ownEn, it: ownIt } })
    expect(saved.status).toBe(200)
    expect(await stored('rule-shop')).toEqual({ en: ownEn, it: ownIt })
    const list = await call('GET', '/review-rules')
    expect(list.body.items.find((r: { id: string }) => r.id === 'rule-shop').emailText).toEqual({ it: ownIt, en: ownEn })
  })

  it('a text the check refuses is refused in words, and nothing is saved', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ en: { ...ownEn, body: `${ownEn.body}\n\nGet a 10% discount on your next order for your review.` } }, /^English text: It offers something for a review/],
      [{ en: { ...ownEn, subject: 'Happy? Give us 5 stars' } }, /^English subject: It asks for 5 stars or a positive review/],
      [{ it: { ...ownIt, body: `Se sei soddisfatto, lascia una recensione.\n\n${ownIt.body}` } }, /^Italian text: It asks only happy buyers/],
      [{ en: { ...ownEn, body: ownEn.body.replace('{unsubscribe_link}', '') } }, /^English text: The unsubscribe link is missing: put \{unsubscribe_link\} back/],
      [{ en: { ...ownEn, body: ownEn.body.replace('{review_button}', '') } }, /^English text: The review button is missing/],
      [{ de: ownEn }, /only in Italian \(it\) and English \(en\)/],
    ]
    for (const [emailText, words] of cases) {
      const refused = await call('PATCH', '/review-rules/rule-shop', { emailText, notes: 'not saved either' })
      expect(refused.status).toBe(400)
      expect(refused.body.error).toMatch(words)
    }
    expect(await stored('rule-shop')).toEqual({ en: ownEn, it: ownIt })
    expect((await inside(() => database.client.reviewRule.findUniqueOrThrow({ where: { id: 'rule-shop' } }))).notes).toBeNull()
    const created = await call('POST', '/review-rules', { name: 'Refused', scope: 'SHOPIFY', emailText: { en: { ...ownEn, subject: 'A free gift inside' } } })
    expect(created.status).toBe(400)
    expect(await inside(() => database.client.reviewRule.findFirst({ where: { name: 'Refused' } }))).toBeNull()
  })

  it('a language equal to the standard text is not stored; null puts the standard text back', async () => {
    await call('PATCH', '/review-rules/rule-shop', { emailText: { it: STANDARD_REQUEST_TEXT.it, en: ownEn } })
    expect(await stored('rule-shop')).toEqual({ en: ownEn })
    await call('PATCH', '/review-rules/rule-shop', { emailText: null })
    expect(await stored('rule-shop')).toBeNull()
    // A save that does not send the text leaves it as it is.
    await call('PATCH', '/review-rules/rule-shop', { emailText: { en: ownEn } })
    await call('PATCH', '/review-rules/rule-shop', { notes: 'kept' })
    expect(await stored('rule-shop')).toEqual({ en: ownEn })
  })

  it('“Duplicate as A/B” copies the text; export carries it and import checks it again', async () => {
    const copy = await call('POST', '/review-rules/rule-shop/duplicate')
    expect(copy.body.rule).toMatchObject({ name: 'Shop (variant 1)', isActive: false, emailText: { en: ownEn } })
    const exported = await call('GET', '/review-rules/export?ids=rule-shop')
    expect(exported.body.rules[0].emailText).toEqual({ en: ownEn })
    const imported = await call('POST', '/review-rules/import', { rules: [
      { name: 'Imported good', scope: 'SHOPIFY', emailText: { it: ownIt } },
      { name: 'Imported bad', scope: 'SHOPIFY', emailText: { it: { ...ownIt, subject: 'Lasciaci 5 stelle' } } },
    ] })
    expect(imported.body).toMatchObject({ created: 1, skipped: 1 })
    expect(imported.body.errors[0]).toMatch(/^Imported bad: Italian subject: It asks for 5 stars/)
    expect((await inside(() => database.client.reviewRule.findFirstOrThrow({ where: { name: 'Imported good' } }))).emailText).toEqual({ it: ownIt })
  })

  it('Preview email shows the rule’s saved text, or the editor’s unsaved text; a refused draft is refused in words', async () => {
    const saved = await call('GET', '/review-emails/preview?kind=request&ruleId=rule-shop&market=DE&locale=en')
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({ locale: 'en', textWords: 'This rule’s own text in English' })
    expect(saved.body.html).toContain('Tell other riders what you think.')
    expect(saved.body.html).toContain('href="https://shop.example.test/pages/reviews"')
    const italian = await call('GET', '/review-emails/preview?kind=request&ruleId=rule-shop&market=IT&locale=it')
    expect(italian.body.textWords).toBe('The standard text — this rule has no own text in Italian')
    expect(italian.body.subject).toMatch(/Lascia una recensione sincera$/)

    const draft = await call('POST', '/review-emails/preview', { kind: 'request', ruleId: 'rule-shop', market: 'IT', locale: 'it', draft: true, text: ownIt })
    expect(draft.body).toMatchObject({ textWords: 'This rule’s own text (not saved yet) in Italian', englishSubject: null })
    expect(draft.body.html).toContain('Racconta com’è andata.')
    // The draft's standard text for a language (null) shows the standard e-mail, even where a text is saved.
    const standard = await call('POST', '/review-emails/preview', { kind: 'request', ruleId: 'rule-shop', market: 'DE', locale: 'en', draft: true, text: null })
    expect(standard.body.html).not.toContain('Tell other riders what you think.')
    const refused = await call('POST', '/review-emails/preview', { kind: 'request', ruleId: 'rule-shop', market: 'DE', locale: 'en', draft: true, text: { ...ownEn, subject: 'Rate us 5 stars' } })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toBe('The subject cannot be shown: It asks for 5 stars or a positive review. Ask for an honest review only.')
  })
})
