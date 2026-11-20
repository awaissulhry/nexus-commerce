import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { order } from '../../_demo/fixtures'
import { ORDER_STATUSES, type OrderStatus } from '../../api' // F-OO-101
import { BRAND_STAGES, type BrandStage, type Headline } from './api' // F-OO-101
import { CONFIRMED_READ, HEADLINE, PRODUCTION_READ } from './fixtures'
import { exFactoryOf, headlineOf, inWorkOf, preparingNote, stageStripOf, stagesNoteShown } from './where'
import { bandHealthOf, healthInputOf, waitingOf, whoActsNextOf } from './model'

/**
 * F-OO-100 (order overview lane: one file per section) — "Where it is now"'s rules, moved with where.ts out of overview.vitest.test.ts
 * unchanged (F-SA-232: the headline sentence per state, the five stages, who acts next, the health only from the reads).
 */

// ---- F-OO-101 (order overview §1.2; review F8): the headline is the status AND the stage — rewritten from "one sentence per state" ----
describe('F-OO-101: the headline is the status and the stage, one sentence the dots agree with', () => {
  const at = (code: BrandStage): Headline => ({ ...HEADLINE, stage: { ...HEADLINE.stage!, code } })
  const shipment = (id: string, shippedAt: string | null, deliveredAt: string | null) => ({ id, number: `SH-${id}`, status: deliveredAt ? 'DELIVERED' : 'SHIPPED', shippedAt, deliveredAt })
  const shippedAs = (status: OrderStatus, shipments: ReturnType<typeof shipment>[]) => ({ ...order(status), chain: { ...order(status).chain, shipments } })
  const SHIPMENTS = [shipment('1', '2026-11-12T10:00:00Z', '2026-11-14T11:00:00Z'), shipment('2', '2026-11-20T10:00:00Z', null)]

  it('every status × stage of the table: the status word, then the stage word — and never "· 1 line ahead"', () => {
    // Waiting for a yes: the status alone, and its quiet line (whatever the read says of the stage).
    expect(headlineOf(order('PENDING_APPROVAL'), HEADLINE)).toEqual({ state: 'WAITING', status: { key: 'status.PENDING_APPROVAL' }, stage: null, note: { key: 'where.note.waiting' } })
    // Confirmed: "Confirmed · Preparing" before any work order (no stage read, or the read's own Preparing); a stage reached is said.
    expect(headlineOf(order('CONFIRMED'), CONFIRMED_READ.headline)).toEqual({ state: 'CURRENT', status: { key: 'status.CONFIRMED' }, stage: 'PREPARING', note: null })
    expect(headlineOf(order('CONFIRMED'), at('PREPARING'))).toEqual({ state: 'CURRENT', status: { key: 'status.CONFIRMED' }, stage: 'PREPARING', note: null })
    expect(headlineOf(order('CONFIRMED'), at('QUALITY'))).toEqual({ state: 'CURRENT', status: { key: 'status.CONFIRMED' }, stage: 'QUALITY', note: null })
    // In production, Ready, Partly shipped: status · stage; no stage read: "Stage not known yet", never step 1.
    for (const status of ['IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const) {
      for (const code of BRAND_STAGES.filter((stage) => !(status === 'READY' && stage === 'READY'))) expect(headlineOf(order(status), at(code)), `${status} ${code}`).toEqual({ state: 'CURRENT', status: { key: `status.${status}` }, stage: code, note: null })
      expect(headlineOf(order(status), { ...HEADLINE, stage: null }), status).toEqual({ state: 'CURRENT', status: { key: `status.${status}` }, stage: 'unknown', note: null })
    }
    // One word per thing: the status Ready with the stage Ready to ship is "Ready to ship" alone (never "Ready · Ready to ship").
    expect(headlineOf(order('READY'), at('READY'))).toEqual({ state: 'CURRENT', status: null, stage: 'READY', note: null })
    // "· 1 line ahead" is gone (F8): the read still says it (aheadWords), the headline never does.
    expect(HEADLINE.stage!.ahead).toBe(1)
    for (const status of ORDER_STATUSES) expect(JSON.stringify(headlineOf(order(status), HEADLINE)), status).not.toMatch(/ahead/)
  })

  it('after production: shipped on its last day (delivered only once the order is), closed with it; cancelled says where work had reached', () => {
    // The newest shipment's day; an older shipment's arrival is never the order's.
    expect(headlineOf(shippedAs('SHIPPED', SHIPMENTS), HEADLINE)).toEqual({ state: 'ALL_DONE', status: { key: 'overview.headline.shipped', params: { shipped: '2026-11-20T10:00:00Z' } }, stage: null, note: null })
    const delivered = [SHIPMENTS[0]!, shipment('2', '2026-11-20T10:00:00Z', '2026-11-22T09:00:00Z')]
    expect(headlineOf(shippedAs('DELIVERED', delivered), HEADLINE)).toEqual({ state: 'ALL_DONE', status: { key: 'overview.headline.delivered', params: { shipped: '2026-11-20T10:00:00Z', delivered: '2026-11-22T09:00:00Z' } }, stage: null, note: null })
    expect(headlineOf(shippedAs('CLOSED', SHIPMENTS), HEADLINE)).toEqual({ state: 'ALL_DONE', status: { key: 'where.headline.closedShipped', params: { shipped: '2026-11-20T10:00:00Z' } }, stage: null, note: null })
    // No shipment day known (closed short, say): the status word alone.
    expect(headlineOf(shippedAs('CLOSED', []), HEADLINE)).toEqual({ state: 'ALL_DONE', status: { key: 'status.CLOSED' }, stage: null, note: null })
    expect(headlineOf(shippedAs('SHIPPED', []), HEADLINE)).toEqual({ state: 'ALL_DONE', status: { key: 'status.SHIPPED' }, stage: null, note: null })
    // Cancelled: the status word; where the work had reached once it was beyond Preparing (nothing begun: nothing said).
    expect(headlineOf(order('CANCELLED'), at('CUTTING'))).toEqual({ state: 'STOPPED', status: { key: 'status.CANCELLED' }, stage: null, note: { key: 'where.note.reached', stage: 'CUTTING' } })
    expect(headlineOf(order('CANCELLED'), at('PREPARING'))).toEqual({ state: 'STOPPED', status: { key: 'status.CANCELLED' }, stage: null, note: null })
    expect(headlineOf(order('CANCELLED'), null)).toEqual({ state: 'STOPPED', status: { key: 'status.CANCELLED' }, stage: null, note: null })
  })

  it('the words: each status and stage word exists in both languages; the new lines in both languages; the old ones are gone', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      const p = createTranslator(locale, messagesFor(locale, ['production']).production!)
      for (const status of ORDER_STATUSES) expect(t(`status.${status}`), `${locale} ${status}`).not.toBe(`status.${status}`)
      for (const stage of [...BRAND_STAGES, 'unknown']) expect(p(`parts.stage.${stage}`), `${locale} ${stage}`).not.toBe(`parts.stage.${stage}`)
      expect(t('where.note.waiting'), locale).not.toBe('where.note.waiting')
      expect(t('where.note.reached', { stage: p('parts.stage.CUTTING') })).toBe(locale === 'en' ? 'Work had reached Cutting when it was cancelled' : 'Il lavoro era arrivato a Taglio quando è stato annullato')
      expect(t('where.headline.closedShipped', { shipped: '20/11/2026' })).toBe(locale === 'en' ? 'Closed · shipped 20/11/2026' : 'Chiuso · spedito il 20/11/2026')
      // "1 line ahead" and "Confirmed · waiting for the deposit" left the catalogue with the headline that said them.
      for (const key of ['overview.ahead', 'overview.headline.waitingDeposit']) expect(t(key, { count: 1 }), `${locale} ${key}`).toBe(key)
    }
    // One word per thing: the status "Ready" and the stage "Ready to ship" are two words, never the same one.
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    const stageEn = createTranslator('en', messagesFor('en', ['production']).production!)
    expect([en('status.READY'), stageEn('parts.stage.READY')]).toEqual(['Ready', 'Ready to ship'])
  })
})
// ---- end F-OO-101

describe('"Where it is now": the stages and the facts', () => {
  // F-OO-102: rewritten — the strip carries the office state (the headline's own); the blocked why left the current dot (the strips say it).
  it('the stages: the stage now with its day, the working plan, the blocked mark without its why; before any work order Preparing after the deposit', () => {
    const strip = stageStripOf(order('IN_PRODUCTION'), HEADLINE, PRODUCTION_READ.dates)
    expect(strip).toMatchObject({ state: 'CURRENT', stage: 'SEWING', reached: { SEWING: '2026-11-13' }, sewingCounted: true, blocked: null, expected: { CUTTING: '2026-11-10', SEWING: '2026-11-13', QUALITY: '2026-12-10' } })
    const holds = [{ kind: 'QUALITY' as const, words: { en: 'Quality hold', it: 'Sospensione qualità' }, since: '2026-11-14' }]
    const held = stageStripOf(order('IN_PRODUCTION'), { ...HEADLINE, held: true, holds }, null)
    expect(held.blocked).toEqual({ why: null })
    expect(JSON.stringify(held)).not.toContain('Quality hold')
    expect(stageStripOf(order('CONFIRMED'), CONFIRMED_READ.headline, null)).toMatchObject({ state: 'CURRENT', stage: 'PREPARING' })
    expect(preparingNote(order('CONFIRMED'), CONFIRMED_READ.headline)).toEqual({ key: 'overview.afterDeposit' })
    expect(stageStripOf(order('IN_PRODUCTION'), { ...HEADLINE, stage: null }, null)).toEqual({ state: 'CURRENT', stage: null })
  })

  it('F-OO-102: the dots read the headline\'s state — waiting all to come, production over all done (no blocked mark), cancelled no strip', () => {
    for (const status of ORDER_STATUSES) expect(stageStripOf(order(status), HEADLINE, PRODUCTION_READ.dates).state, status).toBe(headlineOf(order(status), HEADLINE).state)
    expect(stageStripOf(order('PENDING_APPROVAL'), HEADLINE, PRODUCTION_READ.dates)).toEqual({ state: 'WAITING', stage: null })
    expect(stageStripOf(order('CANCELLED'), HEADLINE, PRODUCTION_READ.dates)).toEqual({ state: 'STOPPED', stage: null })
    // After shipping the keeper stops: the kept stage keeps its day, every stage reads done, a hold still kept marks nothing.
    const held = { ...HEADLINE, held: true, holds: [{ kind: 'PRODUCTION' as const, words: { en: 'x', it: 'x' }, since: '2026-11-14' }] }
    for (const status of ['SHIPPED', 'DELIVERED', 'CLOSED'] as const) expect(stageStripOf(order(status), held, PRODUCTION_READ.dates), status).toEqual({ state: 'ALL_DONE', stage: 'SEWING', reached: { SEWING: '2026-11-13' } })
    // The quiet line under the dots shows where they are drawn.
    expect(ORDER_STATUSES.filter((status) => stagesNoteShown(headlineOf(order(status), HEADLINE).state))).toEqual(['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CLOSED', 'DELIVERED'])
  })

  it('who acts next, the ex-factory slip, the bundles as counts only (OW-6), the health from the keeper else the order’s lateness', () => {
    // F-OP-103: who acts next is the ONE waiting list's first row.
    const rows = waitingOf({ headline: HEADLINE }, { requests: [], approvals: [], recordPayment: false, locale: 'it' })
    expect(whoActsNextOf(rows, HEADLINE)).toMatchObject({ who: 'US', since: '2026-11-17T09:05:00Z', kind: 'request' })
    expect(whoActsNextOf([], null)).toEqual({ who: undefined, since: null, kind: 'record', row: null, still: null })
    expect(exFactoryOf(order('IN_PRODUCTION'), HEADLINE)).toEqual({ key: 'overview.exFactoryMoved', params: { date: '2026-12-15', count: 2, days: '+6' } })
    expect(inWorkOf(HEADLINE)).toEqual({ count: 3, stage: 'SEWING' })
    expect(inWorkOf(CONFIRMED_READ.headline)).toBeNull()
    const atRisk = healthInputOf(order('IN_PRODUCTION'), HEADLINE)
    expect(atRisk.computed).toBe('AT_RISK')
    expect(bandHealthOf(atRisk)).toBe(true)
    expect(bandHealthOf(healthInputOf(order('IN_PRODUCTION'), { ...HEADLINE, health: { ...HEADLINE.health!, code: 'ON_TRACK', computed: 'ON_TRACK' } }))).toBe(false)
    // No state kept yet: the order read's own lateness, in the same words.
    const late = healthInputOf({ ...order('IN_PRODUCTION'), daysLate: 3 }, { ...HEADLINE, health: null })
    expect(late).toMatchObject({ computed: 'LATE', daysLate: 3 })
    expect(healthInputOf(order('IN_PRODUCTION'), null).computed).toBeUndefined()
  })
})
