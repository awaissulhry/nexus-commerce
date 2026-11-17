import { describe, expect, it } from 'vitest'
import { isPartnerMessageKey, PARTNER_MESSAGE_KEYS, PARTNER_MESSAGE_TEMPLATES, partnerSentence, productionWordsOf, topicOfNotice } from '../portal/notifications/messages'
import { defaultFrequencyOf, frequencyOf, isTransactional, NON_ESSENTIAL_TOPICS, PARTNER_EMAIL_TOPICS, TOPIC_WORDS, type PartnerEmailFrequency, type PartnerEmailTopic } from '../portal/notifications/topics'
import { HEALTH_NOTICE_KEYS, HOLD_CAUSE_OF_EVENT, healthNoticeKey, holdNoticeKey, problemNotice, STAGE_NOTICE_KEYS, stageNoticeKey, URGENCY_NOTICE_KEYS, urgencyNoticeKey } from './notices'

/**
 * B-PR-31 — which notice a customer is told of its own production, and its words (production plan §6 "Notifications" L15; review
 * fixes R-41, R-51; walls PW-15, PW-18). Pure: the API's rule (platform/portal/notifications/rules/production.ts) reads the records;
 * production-notices.pg.vitest.test.ts there runs it on the local stack.
 */

const O1 = '00000000-0000-7000-8000-0000000000e1'
const O2 = '00000000-0000-7000-8000-0000000000e2'
const PRODUCTION_KEYS = PARTNER_MESSAGE_KEYS.filter((key) => key.startsWith('portal.production.'))
const order12 = { recordLabel: '#12', params: { yourKind: 'ORDER', yourSeq: 12 } }

describe('B-PR-31 which production event is news for the customer', () => {
  it('a stage reached: forward, to Cutting … Ready, while the order is still there; never its first stage nor a move back', () => {
    expect(stageNoticeKey({ stage: 'CUTTING', previous: 'PREPARING' }, 'CUTTING')).toBe('portal.production.cutting')
    expect(stageNoticeKey({ stage: 'SEWING', previous: 'CUTTING' }, 'SEWING')).toBe('portal.production.sewing')
    expect(stageNoticeKey({ stage: 'QUALITY', previous: 'SEWING' }, 'QUALITY')).toBe('portal.production.quality')
    expect(stageNoticeKey({ stage: 'READY', previous: 'PREPARING' }, 'READY')).toBe('portal.production.ready')
    // The keeper's first keep of an order (a new order, or the first nightly run over older ones): no flood.
    expect(stageNoticeKey({ stage: 'PREPARING', previous: null }, 'PREPARING')).toBeNull()
    expect(stageNoticeKey({ stage: 'SEWING', previous: null }, 'SEWING')).toBeNull()
    // Back, or the same: never news.
    expect(stageNoticeKey({ stage: 'CUTTING', previous: 'SEWING' }, 'CUTTING')).toBeNull()
    // Moved on (or back) before the worker told it: stale, the next stage is told on its own.
    expect(stageNoticeKey({ stage: 'CUTTING', previous: 'PREPARING' }, 'SEWING')).toBeNull()
    expect(stageNoticeKey({ stage: 'CUTTING', previous: 'PREPARING' }, null)).toBeNull()
    expect(Object.keys(STAGE_NOTICE_KEYS).sort()).toEqual(['CUTTING', 'QUALITY', 'READY', 'SEWING'])
  })

  it('a health changed: only worse, to At risk or Late, while the order still reads it; never the first health', () => {
    expect(healthNoticeKey({ health: 'AT_RISK', previous: 'ON_TRACK' }, 'AT_RISK')).toBe('portal.production.at_risk')
    expect(healthNoticeKey({ health: 'AT_RISK', previous: 'NO_DATE' }, 'AT_RISK')).toBe('portal.production.at_risk')
    expect(healthNoticeKey({ health: 'LATE', previous: 'AT_RISK' }, 'LATE')).toBe('portal.production.late')
    expect(healthNoticeKey({ health: 'LATE', previous: 'ON_TRACK' }, 'LATE')).toBe('portal.production.late')
    // Better, or no worse: the page shows it.
    expect(healthNoticeKey({ health: 'AT_RISK', previous: 'LATE' }, 'AT_RISK')).toBeNull()
    expect(healthNoticeKey({ health: 'ON_TRACK', previous: 'AT_RISK' }, 'ON_TRACK')).toBeNull()
    expect(healthNoticeKey({ health: 'NO_DATE', previous: 'ON_TRACK' }, 'NO_DATE')).toBeNull()
    expect(healthNoticeKey({ health: null, previous: 'AT_RISK' }, null)).toBeNull()
    // The first keep (previous null), and a health that changed again before the worker told it.
    expect(healthNoticeKey({ health: 'LATE', previous: null }, 'LATE')).toBeNull()
    expect(healthNoticeKey({ health: 'AT_RISK', previous: 'ON_TRACK' }, 'ON_TRACK')).toBeNull()
    expect(Object.keys(HEALTH_NOTICE_KEYS).sort()).toEqual(['AT_RISK', 'LATE'])
  })

  it('a hold: on hold when placed, resumed when nothing holds it any more; a lift that leaves another hold and its own pause placed tell nothing', () => {
    expect(holdNoticeKey({ held: true, kind: 'PRODUCTION' }, 'PLACED')).toBe('portal.production.on_hold')
    expect(holdNoticeKey({ held: true, kind: 'QUALITY' }, 'PLACED')).toBe('portal.production.on_hold')
    // The cause not known (no causation): taken as placed.
    expect(holdNoticeKey({ held: true, kind: 'PRODUCTION' }, null)).toBe('portal.production.on_hold')
    // Lifted while another hold still holds it: it was on hold and still is.
    expect(holdNoticeKey({ held: true, kind: 'QUALITY' }, 'LIFTED')).toBeNull()
    // Its own pause: only our yes to its pause request places it, and that answer tells it.
    expect(holdNoticeKey({ held: true, kind: 'BRAND' }, 'PLACED')).toBeNull()
    for (const kind of ['QUALITY', 'PRODUCTION', 'BRAND'] as const) expect(holdNoticeKey({ held: false, kind }, 'LIFTED')).toBe('portal.production.hold_lifted')
    expect(HOLD_CAUSE_OF_EVENT).toEqual({ 'work_order_hold.placed': 'PLACED', 'quality.hold_placed': 'PLACED', 'work_order_hold.lifted': 'LIFTED', 'quality.hold_released': 'LIFTED' })
  })

  it("PW-18: an urgency change is news only when it is ours (set back, lock, unlock), not our yes to its ask, and its switch is on — never the customer's own mark", () => {
    const ours = { by: 'FACTORY', asked: false, undo: false } as const
    expect(urgencyNoticeKey({ ...ours, change: 'SET_BACK' }, true)).toBe('portal.production.set_regular')
    expect(urgencyNoticeKey({ ...ours, change: 'LOCK' }, true)).toBe('portal.production.locked')
    expect(urgencyNoticeKey({ ...ours, change: 'UNLOCK' }, true)).toBe('portal.production.unlocked')
    // The customer's own acts: nobody is told (neither the customer nor any other).
    for (const change of ['MARK', 'ORDER', 'SET_BACK', 'LOCK', 'UNLOCK'] as const) {
      expect(urgencyNoticeKey({ by: 'BRAND', change, asked: false, undo: false }, true)).toBeNull()
      expect(urgencyNoticeKey({ by: 'BRAND', change, asked: false, undo: true }, true)).toBeNull()
    }
    // Our yes to its "Urgent – asked": the answer tells it.
    expect(urgencyNoticeKey({ ...ours, change: 'MARK', asked: true }, true)).toBeNull()
    expect(urgencyNoticeKey({ ...ours, change: 'MARK' }, true)).toBeNull()
    // Its urgency switched off: its portal shows no urgency.
    expect(urgencyNoticeKey({ ...ours, change: 'SET_BACK' }, false)).toBeNull()
    expect(Object.keys(URGENCY_NOTICE_KEYS).sort()).toEqual(['LOCK', 'SET_BACK', 'UNLOCK'])
  })

  it('a problem answered: only one the customer reported, on its order; the other orders of its batch read where the answer is', () => {
    expect(problemNotice({ source: 'BRAND', salesOrderId: O1, answeredInOrderId: O1 })).toEqual({ key: 'portal.production.problem_answered', inOrderId: null })
    expect(problemNotice({ source: 'BRAND', salesOrderId: O1, answeredInOrderId: null })).toEqual({ key: 'portal.production.problem_answered', inOrderId: null })
    expect(problemNotice({ source: 'BRAND', salesOrderId: O2, answeredInOrderId: O1 })).toEqual({ key: 'portal.production.problem_answered_in', inOrderId: O1 })
    // An office issue (the customer never knew of it), or one on a work order of several orders: nothing.
    expect(problemNotice({ source: 'OFFICE', salesOrderId: O1, answeredInOrderId: null })).toBeNull()
    expect(problemNotice({ source: 'BRAND', salesOrderId: null, answeredInOrderId: O1 })).toBeNull()
  })
})

describe('B-PR-31 the words: Italian in "voi", the customer\'s own number, never a person, an amount or the office series', () => {
  it('says each production notice in English and Italian', () => {
    const en = (messageKey: string, params: Record<string, unknown> = order12.params) => partnerSentence({ messageKey, recordLabel: '#12', params }, 'en', 'Factory Spa')
    const it_ = (messageKey: string, params: Record<string, unknown> = order12.params) => partnerSentence({ messageKey, recordLabel: '#12', params }, 'it', 'Factory Spa')
    expect([en('portal.production.cutting'), it_('portal.production.cutting')]).toEqual(['Cutting has started on your order 12', 'È iniziato il taglio per il vostro ordine 12'])
    expect([en('portal.production.ready'), it_('portal.production.ready')]).toEqual(['Your order 12 is ready to ship', 'Il vostro ordine 12 è pronto per la spedizione'])
    expect([en('portal.production.at_risk'), it_('portal.production.at_risk')]).toEqual(['Your order 12 is at risk of missing its date', 'Il vostro ordine 12 rischia di non rispettare la data'])
    expect([en('portal.production.late'), it_('portal.production.late')]).toEqual(['Your order 12 is late', 'Il vostro ordine 12 è in ritardo'])
    expect([en('portal.production.on_hold'), it_('portal.production.hold_lifted')]).toEqual(['Work on your order 12 is on hold', 'La lavorazione per il vostro ordine 12 è ripresa'])
    // Ours: "we", never a name; one act over three of its orders names the first and how many more.
    const three = { ...order12.params, more: 2 }
    expect([en('portal.production.set_regular', three), it_('portal.production.set_regular', three)]).toEqual(['We set your order 12 and 2 more back to Regular', 'Abbiamo riportato il vostro ordine 12 e altri 2 a normale'])
    expect([en('portal.production.locked'), it_('portal.production.locked')]).toEqual(['We locked your order 12 at Regular', 'Abbiamo bloccato il vostro ordine 12 su normale'])
    expect([en('portal.production.unlocked', { ...order12.params, more: 0 }), it_('portal.production.unlocked')]).toEqual(['We unlocked the urgency of your order 12', "Abbiamo sbloccato l'urgenza per il vostro ordine 12"])
    // A problem it reported on two orders, answered in one order's conversation.
    expect([en('portal.production.problem_answered'), it_('portal.production.problem_answered')]).toEqual(['We answered the problem you reported on your order 12', 'Abbiamo risposto al problema che avete segnalato per il vostro ordine 12'])
    const elsewhere = { ...order12.params, inSeq: 13 }
    expect([en('portal.production.problem_answered_in', elsewhere), it_('portal.production.problem_answered_in', elsewhere)]).toEqual([
      'We answered the problem you reported on your order 12 in the conversation of your order 13',
      'Abbiamo risposto al problema che avete segnalato per il vostro ordine 12 nella conversazione del vostro ordine 13',
    ])
    expect(en('portal.production.problem_answered_in')).toBe('We answered the problem you reported on your order 12 in the conversation of another of your orders')
    // The answers to its asks, and our counter-offer.
    expect([en('portal.production.hold_refused'), it_('portal.production.hold_refused')]).toEqual(['Your pause request on your order 12 was not accepted', 'La vostra richiesta di pausa per il vostro ordine 12 non è stata accettata'])
    expect([en('portal.production.rush_accepted'), it_('portal.production.rush_accepted')]).toEqual(['Your urgent request on your order 12 was accepted', 'La vostra richiesta di urgenza per il vostro ordine 12 è stata accettata'])
    expect([en('portal.order.countered'), it_('portal.production.countered')]).toEqual([
      'We answered your request on your order 12 with a counter-offer: it waits for your answer',
      'Abbiamo risposto alla vostra richiesta per il vostro ordine 12 con una controproposta: attende la vostra risposta',
    ])
  })

  it('every production key: no placeholder left, no office series, no "tu" in Italian, whatever the params', () => {
    const keys = [...PRODUCTION_KEYS, 'portal.order.countered' as const]
    expect(PRODUCTION_KEYS.length).toBeGreaterThanOrEqual(24)
    for (const messageKey of keys) {
      for (const params of [order12.params, {}, { ...order12.params, more: 3, inSeq: 4 }, { more: 'two', inSeq: -1 }]) {
        for (const locale of ['it', 'en'] as const) {
          const words = partnerSentence({ messageKey, recordLabel: '#12', params }, locale, 'Factory Spa')
          expect(words, `${messageKey} ${locale}`).not.toMatch(/[{}]/)
          expect(words, `${messageKey} ${locale}`).not.toMatch(/SO-|WO-|€|\d+[.,]\d{2}/)
          if (locale === 'it') expect(words, messageKey).not.toMatch(/\b(tu|ti|tuo|tua|tuoi|tue)\b/i)
        }
      }
    }
    expect(productionWordsOf({ more: 1.5, inSeq: 0 }, 'en')).toEqual({ inYours: 'another of your orders', more: '' })
  })

  it('topic PRODUCTION: non-essential, a daily summary until changed; a change or cancel countered is order news (at once)', () => {
    expect(PARTNER_EMAIL_TOPICS).toContain('PRODUCTION')
    expect(isTransactional('PRODUCTION')).toBe(false)
    expect(NON_ESSENTIAL_TOPICS).toContain('PRODUCTION')
    expect(defaultFrequencyOf('PRODUCTION')).toBe('DAILY')
    expect(frequencyOf('PRODUCTION', new Map<PartnerEmailTopic, PartnerEmailFrequency>())).toBe('DAILY')
    expect(frequencyOf('PRODUCTION', new Map<PartnerEmailTopic, PartnerEmailFrequency>([['PRODUCTION', 'OFF']]))).toBe('OFF')
    expect(TOPIC_WORDS.PRODUCTION).toEqual({ it: 'Produzione', en: 'Production' })
    for (const messageKey of PRODUCTION_KEYS) {
      expect(isPartnerMessageKey(messageKey)).toBe(true)
      expect(PARTNER_MESSAGE_TEMPLATES[messageKey].category, messageKey).toBe('FOLLOWING')
      expect(topicOfNotice({ messageKey, recordLabel: '#12', params: {} }, () => null), messageKey).toBe('PRODUCTION')
    }
    expect(topicOfNotice({ messageKey: 'portal.order.countered', recordLabel: '#12', params: {} }, () => null)).toBe('ORDERS')
    // Every key a decision gives is a production notice.
    for (const key of [...Object.values(STAGE_NOTICE_KEYS), ...Object.values(HEALTH_NOTICE_KEYS), ...Object.values(URGENCY_NOTICE_KEYS)]) expect(PRODUCTION_KEYS).toContain(key)
  })
})
