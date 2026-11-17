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
  it('locks order, delivery and invoice mail on as it happens; messages as it happens and everything else a daily summary until changed', () => {
    const stored = new Map<PartnerEmailTopic, PartnerEmailFrequency>([['ORDERS', 'OFF'], ['DATES', 'WEEKLY']])
    expect(TRANSACTIONAL_TOPICS).toEqual(['ORDERS', 'SHIPPED', 'INVOICES'])
    expect(frequencyOf('ORDERS', stored)).toBe('INSTANT')
    expect(frequencyOf('DATES', stored)).toBe('WEEKLY')
    // B-TH-045 (Owner decision 5): messages as it happens until the person changes it; the other non-essential topics daily.
    expect(frequencyOf('MESSAGES', stored)).toBe('INSTANT')
    expect(frequencyOf('DOCUMENTS', stored)).toBe('DAILY')
    expect(frequencyOf('MESSAGES', new Map([['MESSAGES', 'DAILY']]))).toBe('DAILY')
    expect(frequencyOf('MESSAGES', rowsOfChange({ nonEssential: 'OFF' }))).toBe('OFF')
    expect(settingsOf(stored).find((entry) => entry.topic === 'MESSAGES')).toEqual({ topic: 'MESSAGES', frequency: 'INSTANT', locked: false, stored: false })
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

  // th2-backend step 7 (threads plan §0.5, counts do not leak): a customer's request, quote or order by its OWN number.
  it("names a customer's request, quote or order by its own number in the reader's language, never the office's series", () => {
    const order = { recordLabel: '#12', params: { yourKind: 'ORDER', yourSeq: 12 } }
    expect(partnerSentence({ messageKey: 'portal.order.confirmed', ...order }, 'en', 'Factory Spa')).toBe('Your order 12 is confirmed')
    expect(partnerSentence({ messageKey: 'portal.order.confirmed', ...order }, 'it', 'Factory Spa')).toBe('Il vostro ordine 12 è confermato')
    expect(partnerSentence({ messageKey: 'portal.order.received', ...order }, 'en', 'Factory Spa')).toBe('We received your order 12: it is waiting for our approval')
    expect(partnerSentence({ messageKey: 'portal.order.dates_changed', recordLabel: '#12', params: { ...order.params, dueAt: '2026-12-12T11:00:00.000Z' } }, 'it', 'Factory Spa')).toBe('Nuova data di consegna per il vostro ordine 12 (entro il 12 dic)')
    const request = { recordLabel: '#7', params: { yourKind: 'REQUEST', yourSeq: 7 } }
    expect(partnerSentence({ messageKey: 'portal.request.received', ...request }, 'en', 'Factory Spa')).toBe('We received your request 7')
    expect(partnerSentence({ messageKey: 'portal.request.need_info', ...request }, 'it', 'Factory Spa')).toBe('Ci serve qualcosa da voi per la vostra richiesta 7')
    expect(partnerSentence({ messageKey: 'portal.request.declined', ...request }, 'en', 'Factory Spa')).toBe('Your request 7 was declined')
    // A request notice made before (yourSeq only) still reads as a request; a supplier's record keeps its label.
    expect(partnerSentence({ messageKey: 'portal.request.received', recordLabel: '#7', params: { yourSeq: 7 } }, 'en', 'Factory Spa')).toBe('We received your request 7')
    expect(partnerSentence({ messageKey: 'portal.message.posted', recordLabel: '#3', params: { yourKind: 'QUOTE', yourSeq: 3 } }, 'it', 'Factory Spa')).toBe('Nuovo messaggio da Factory Spa per il vostro preventivo 3')
    expect(partnerSentence({ messageKey: 'portal.message.posted', recordLabel: 'PO-2026-0007', params: {} }, 'en', 'Factory Spa')).toBe('New message from Factory Spa on PO-2026-0007')
    for (const messageKey of ['portal.order.confirmed', 'portal.request.received', 'portal.order.change_accepted'] as const) {
      for (const locale of ['it', 'en'] as const) expect(partnerSentence({ messageKey, ...order }, locale, 'Factory Spa')).not.toMatch(/SO-|INQ-|QT-/)
    }
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

  // B-TH-080 (threads plan TH-6, thread-G11): the shared message the notice is about, quoted and escaped; none, nothing extra.
  it('quotes the shared message under its sentence (one mail and the summary), escaped; without one, the mail is as before', () => {
    const footer = { text: '-- Factory Spa', html: '<div>Factory Spa</div>' }
    const links = { manage: portalEmailSettingsUrl('https://web.example', 'P0001'), unsubscribe: unsubscribeUrl('https://web.example', unsubscribeToken(KEY, T, U)) }
    const plain = { sentence: 'New message from Factory Spa on Q-1', link: portalRecordUrl('https://web.example', 'P0001', 'Quote', U, `message:${U}`) }
    const quoted = { ...plain, quote: 'Your jackets <AX-100> ship on Monday.' }
    const one = composeNotificationMail({ recipientName: 'Anna', item: quoted, links, footer, locale: 'en' })
    expect(one.text).toContain('“Your jackets <AX-100> ship on Monday.”')
    expect(one.html).toContain('<blockquote>Your jackets &lt;AX-100&gt; ship on Monday.</blockquote>')
    expect(one.subject).toBe(plain.sentence)
    const digest = composeDigestMail({ recipientName: 'Anna', company: 'Factory Spa', weekly: false, items: [quoted, plain], more: 0, links, footer, locale: 'en' })
    expect(digest.text).toContain('• New message from Factory Spa on Q-1\n  “Your jackets <AX-100> ship on Monday.”\n  https://web.example/')
    expect(digest.html).toContain('<em>“Your jackets &lt;AX-100&gt; ship on Monday.”</em>')
    expect(composeNotificationMail({ recipientName: 'Anna', item: plain, links, footer, locale: 'en' })).toEqual(composeNotificationMail({ recipientName: 'Anna', item: { ...plain, quote: null }, links, footer, locale: 'en' }))
    expect(composeNotificationMail({ recipientName: 'Anna', item: plain, links, footer, locale: 'en' }).html).not.toContain('blockquote')
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

describe('our check of a delivery address the person added (B-W2b-F15)', () => {
  const label = 'Seed warehouse two, Via Esempio 12, 40100 Bologna'

  it('says the decision in Italian and English with the address in short, a refusal with the reason; orders mail it at once', () => {
    expect(partnerSentence({ messageKey: 'portal.address.approved', recordLabel: label, params: {} }, 'en', 'Factory Spa')).toBe(`Your delivery address ${label} was checked: your orders can use it`)
    expect(partnerSentence({ messageKey: 'portal.address.approved', recordLabel: label, params: {} }, 'it', 'Factory Spa')).toBe(`Il tuo indirizzo di consegna ${label} è stato verificato: i tuoi ordini possono usarlo`)
    const refused = { messageKey: 'portal.address.refused', recordLabel: label, params: { reason: ' We do not deliver to private garages. ' } }
    expect(partnerSentence(refused, 'en', 'Factory Spa')).toBe(`Your delivery address ${label} was not accepted: We do not deliver to private garages.`)
    expect(partnerSentence(refused, 'it', 'Factory Spa')).toBe(`Il tuo indirizzo di consegna ${label} non è stato accettato: We do not deliver to private garages.`)
    expect(partnerSentence({ ...refused, params: {} }, 'en', 'Factory Spa')).toBe(`Your delivery address ${label} was not accepted`)
    const kindTopic = () => null
    expect(topicOfNotice({ messageKey: 'portal.address.approved', recordLabel: label, params: {} }, kindTopic)).toBe('ORDERS')
    expect(topicOfNotice(refused, kindTopic)).toBe('ORDERS')
  })

  it('puts free text in as written: a "$&" in the address or the reason is never a replacement pattern', () => {
    expect(partnerSentence({ messageKey: 'portal.address.refused', recordLabel: 'Via $& 1', params: { reason: "Not $' here" } }, 'en', 'Factory Spa')).toBe("Your delivery address Via $& 1 was not accepted: Not $' here")
  })
})

// ── B-TH-006 (L2-G06) ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('an order that waits for our yes (B-TH-006)', () => {
  it('is received, waiting for our approval, never confirmed; it is mailed at once as order news', () => {
    // th2-backend step 7 (§0.5): the order by the customer's own number.
    const order = { recordLabel: '#42', params: { yourKind: 'ORDER', yourSeq: 42 } }
    expect(partnerSentence({ messageKey: 'portal.order.received', ...order }, 'en', 'Factory Spa')).toBe('We received your order 42: it is waiting for our approval')
    expect(partnerSentence({ messageKey: 'portal.order.received', ...order }, 'it', 'Factory Spa')).toBe('Abbiamo ricevuto il vostro ordine 42: è in attesa della nostra approvazione')
    for (const locale of ['it', 'en'] as const) expect(partnerSentence({ messageKey: 'portal.order.received', recordLabel: 'SO-1', params: {} }, locale, 'Factory Spa')).not.toMatch(/confirm|conferm/i)
    expect(topicOfNotice({ messageKey: 'portal.order.received', recordLabel: 'SO-1', params: {} }, () => null)).toBe('ORDERS')
  })
})
// ── end B-TH-006 ──────────────────────────────────────────────────────────────────────────────────────────────────────

// ── th3b follow-up 5 (threads plan §0.5, counts do not leak) ───────────────────────────────────────────────────────────────
describe('a delivery that shipped (th3b follow-up 5)', () => {
  it("names the customer's own order, never the office's shipment or order series", () => {
    const shipped = { messageKey: 'portal.shipment.shipped' as const, recordLabel: '#12', params: { yourKind: 'ORDER', yourSeq: 12 } }
    expect(partnerSentence(shipped, 'en', 'Factory Spa')).toBe('A delivery of your order 12 has shipped')
    expect(partnerSentence(shipped, 'it', 'Factory Spa')).toBe('È stata spedita una consegna per il vostro ordine 12')
    for (const locale of ['it', 'en'] as const) expect(partnerSentence(shipped, locale, 'Factory Spa')).not.toMatch(/SH-|SO-/)
    expect(topicOfNotice(shipped, () => null)).toBe('SHIPPED')
  })
})
// ── end th3b follow-up 5 ────────────────────────────────────────────────────────────────────────────────────────────────────
