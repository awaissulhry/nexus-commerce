import { describe, expect, it } from 'vitest'
import type { Actor } from '../../core/permissions'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { homeCountProblems } from '../home/counts'
import { portalEmailSettingsUrl, portalRecordUrl } from '../home/links'
import { KIND_RULES } from '../tasks/kinds'
import { digestFrequenciesAt } from './digest'
import { partnerLiveViewFor } from './live'
import { composeDigestMail, composeNotificationMail, readUnsubscribeToken, unsubscribeToken, unsubscribeUrl } from './mail'
import { PARTNER_MESSAGE_KEYS, partnerSentence, topicOfNotice } from './messages'
import { allNonEssentialOff, changeProblems, frequencyOf, NON_ESSENTIAL_TOPICS, rowsOfChange, settingsOf, TRANSACTIONAL_TOPICS, type PartnerEmailFrequency, type PartnerEmailTopic } from './topics'

const T = '00000000-0000-7000-8000-0000000000aa'
const U = '00000000-0000-7000-8000-0000000000bb'
const C1 = '00000000-0000-7000-8000-0000000000c1'
const P1 = '00000000-0000-7000-8000-0000000000d1'
const P2 = '00000000-0000-7000-8000-0000000000d2'
const KEY = Buffer.alloc(32, 7)

describe('partner e-mail settings (B-W2b-167, COL-063)', () => {
  it('locks order, delivery and invoice mail on as it happens; everything else is a daily summary until changed', () => {
    const stored = new Map<PartnerEmailTopic, PartnerEmailFrequency>([['ORDERS', 'OFF'], ['DATES', 'WEEKLY']])
    expect(TRANSACTIONAL_TOPICS).toEqual(['ORDERS', 'SHIPPED', 'INVOICES'])
    expect(frequencyOf('ORDERS', stored)).toBe('INSTANT')
    expect(frequencyOf('DATES', stored)).toBe('WEEKLY')
    expect(frequencyOf('MESSAGES', stored)).toBe('DAILY')
    expect(settingsOf(stored).find((entry) => entry.topic === 'SHIPPED')).toEqual({ topic: 'SHIPPED', frequency: 'INSTANT', locked: true, stored: false })
  })

  it('refuses a transactional topic set to anything but as it happens; one switch turns all non-essential mail off', () => {
    expect(changeProblems({ topics: [{ topic: 'INVOICES', frequency: 'OFF' }] })[0]?.path).toBe('body/topics/0/frequency')
    expect(changeProblems({ topics: [{ topic: 'INVOICES', frequency: 'INSTANT' }] })).toEqual([])
    expect(changeProblems({ topics: [{ topic: 'DATES', frequency: 'OFF' }, { topic: 'DATES', frequency: 'DAILY' }] })[0]?.path).toBe('body/topics/1/topic')
    expect(changeProblems({})[0]?.path).toBe('body')
    const rows = rowsOfChange({ nonEssential: 'OFF', topics: [{ topic: 'MESSAGES', frequency: 'INSTANT' }, { topic: 'ORDERS', frequency: 'INSTANT' }] })
    expect([...rows.keys()].sort()).toEqual([...NON_ESSENTIAL_TOPICS].sort())
    expect(rows.get('MESSAGES')).toBe('INSTANT')
    expect(rows.get('DATES')).toBe('OFF')
    expect(allNonEssentialOff(rowsOfChange({ nonEssential: 'OFF' }))).toBe(true)
  })
})

describe('partner notifications (B-W2b-167, PLT-148)', () => {
  it('says each key in Italian and English, with the request of a task kind and its due date; never a key left in the words', () => {
    for (const messageKey of PARTNER_MESSAGE_KEYS) {
      for (const locale of ['it', 'en'] as const) {
        const words = partnerSentence({ messageKey, recordLabel: 'SO-2026-0042', params: { kind: 'CONFIRM_PO', dueAt: '2026-11-05T11:00:00.000Z' } }, locale, 'Factory Spa')
        expect(words).not.toMatch(/[{}]/)
        expect(words.length).toBeGreaterThan(5)
      }
    }
    expect(partnerSentence({ messageKey: 'portal.task.opened', recordLabel: 'PO-1', params: { kind: 'CONFIRM_PO' } }, 'en', 'Factory Spa')).toBe('Factory Spa asks you: Confirm order PO-1')
    expect(partnerSentence({ messageKey: 'portal.task.reminded', recordLabel: 'PO-1', params: { kind: 'CONFIRM_PO', dueAt: '2026-11-05T11:00:00.000Z' } }, 'it', 'Factory Spa')).toBe("Promemoria: Conferma l'ordine PO-1 (entro il 5 nov)")
  })

  it("takes a new request's e-mail topic from its kind, every other from its key", () => {
    const kindTopic = (kind: string) => KIND_RULES[kind as keyof typeof KIND_RULES]?.topic ?? null
    expect(topicOfNotice({ messageKey: 'portal.task.opened', recordLabel: 'x', params: { kind: 'PAY_INVOICE' } }, kindTopic)).toBe('INVOICES')
    expect(topicOfNotice({ messageKey: 'portal.task.reminded', recordLabel: 'x', params: { kind: 'PAY_INVOICE' } }, kindTopic)).toBe('REMINDERS')
    expect(topicOfNotice({ messageKey: 'portal.shipment.shipped', recordLabel: 'x', params: {} }, kindTopic)).toBe('SHIPPED')
    expect(topicOfNotice({ messageKey: 'notifications.mention', recordLabel: 'x', params: {} }, kindTopic)).toBeNull()
  })

  it('every mail carries Manage e-mails and the unsubscribe link, says what keeps coming, and escapes the words', () => {
    const footer = { text: '-- Factory Spa', html: '<div>Factory Spa</div>' }
    const links = { manage: portalEmailSettingsUrl('https://web.example', 'P0001'), unsubscribe: unsubscribeUrl('https://web.example', unsubscribeToken(KEY, T, U)) }
    const item = { sentence: 'New message from <Factory> on PO-1', link: portalRecordUrl('https://web.example', 'P0001', 'PurchaseOrder', U, `message:${U}`) }
    const one = composeNotificationMail({ recipientName: 'Anna', item, links, footer, locale: 'en' })
    expect(one.subject).toBe(item.sentence)
    expect(one.text).toContain('Manage e-mails: https://web.example/p/P0001?dialog=email-settings')
    expect(one.text).toContain('https://web.example/p/unsubscribe#token=pu1.')
    expect(one.text).toContain('Order, delivery and invoice mail keeps coming')
    expect(one.html).toContain('&lt;Factory&gt;')
    expect(one.html).not.toContain('<Factory>')
    const digest = composeDigestMail({ recipientName: 'Anna', company: 'Factory Spa', weekly: false, items: [item, item], more: 3, links, footer, locale: 'it' })
    expect(digest.subject).toBe('Il tuo riepilogo giornaliero da Factory Spa: 5 novità')
    expect(digest.text).toContain('e altre 3 nel portale.')
    expect(digest.text).toContain('Disiscriviti dalle e-mail non essenziali')
    expect(() => composeNotificationMail({ recipientName: 'Anna', item: { ...item, link: 'javascript:alert(1)' }, links, footer, locale: 'en' })).toThrow()
  })

  it('reads back only an unsubscribe token it made, for that tenant and person', () => {
    const token = unsubscribeToken(KEY, T, U)
    expect(readUnsubscribeToken(KEY, token)).toEqual({ tenantId: T, userId: U })
    expect(readUnsubscribeToken(Buffer.alloc(32, 8), token)).toBeNull()
    expect(readUnsubscribeToken(KEY, token.replace(U, P1))).toBeNull()
    expect(readUnsubscribeToken(KEY, `${token}x`)).toBeNull()
    expect(readUnsubscribeToken(KEY, 42)).toBeNull()
  })

  it('sends the summary from 08:00 on working days, the weekly topics on Monday, once a day', () => {
    expect(digestFrequenciesAt({ weekday: 2, clock: '07:59' }, false)).toEqual([])
    expect(digestFrequenciesAt({ weekday: 2, clock: '08:00' }, false)).toEqual(['DAILY'])
    expect(digestFrequenciesAt({ weekday: 1, clock: '09:15' }, false)).toEqual(['DAILY', 'WEEKLY'])
    expect(digestFrequenciesAt({ weekday: 6, clock: '09:15' }, false)).toEqual([])
    expect(digestFrequenciesAt({ weekday: 3, clock: '09:15' }, true)).toEqual([])
  })

  it("a partner session's live channel carries only its own party's portal events, to a viewer who holds Home", () => {
    const viewer: Actor = { audience: 'partner', tenantId: T, partyId: P1, grants: [{ permissions: ['portal.home.view'], companies: [C1], sites: [], parties: [P1] }] }
    const message = { tenantId: T, eventId: U, type: 'partner_task.opened', version: 1, subject: U, companyId: C1, siteId: null, occurredAt: '2026-11-04T10:00:00.000Z', fields: { taskId: U, partyId: P1, kind: 'CONFIRM_PO', recordType: 'PurchaseOrder', recordId: U } }
    expect(partnerLiveViewFor(message, viewer, EVENT_CATALOGUE)?.fields).toEqual({ taskId: U, partyId: P1, kind: 'CONFIRM_PO', recordType: 'PurchaseOrder', recordId: U })
    expect(partnerLiveViewFor({ ...message, fields: { ...message.fields, partyId: P2 } }, viewer, EVENT_CATALOGUE)).toBeNull()
    expect(partnerLiveViewFor({ ...message, tenantId: P2 }, viewer, EVENT_CATALOGUE)).toBeNull()
    expect(partnerLiveViewFor({ ...message, type: 'thread.message_posted' }, viewer, EVENT_CATALOGUE)).toBeNull()
    expect(partnerLiveViewFor(message, { ...viewer, grants: [] }, EVENT_CATALOGUE)).toBeNull()
    expect(partnerLiveViewFor(message, { ...viewer, audience: 'office' }, EVENT_CATALOGUE)).toBeNull()
  })

  it('refuses home counts without a good key, kinds or words', () => {
    expect(homeCountProblems([{ key: 'tasks.open', area: 'home', kinds: ['CUSTOMER'], words: { it: 'a', en: 'b' } }])).toEqual([])
    expect(homeCountProblems([{ key: 'Tasks', area: 'home', kinds: [], words: { it: '', en: 'b' } }])).toHaveLength(3)
  })
})
