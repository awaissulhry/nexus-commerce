/**
 * Reviews — our review e-mail to Shopify buyers asks every buyer the same way for an HONEST review (Owner,
 * 2026-10-27; audit E1; CHANNEL-FACTS 5a, 5b, 6). Never "contact us first", never "don't leave a negative review",
 * never a positive-only ask; no button (and no `#`) without a review page. Pure renderer.
 */
import { describe, expect, it } from 'vitest'
import { xaviaIdentity, type BusinessIdentity } from '../business-identity.service.js'
import { renderReviewRequestEmail, type ReviewEmailContext } from './review-request-email.service.js'

const other: BusinessIdentity = { ...xaviaIdentity(), xavia: false, workspaceId: 'b', brandName: 'Test Moto', brandMark: 'TEST MOTO', supportEmail: 'help@testmoto.example', unsubscribeEmail: 'help@testmoto.example' }
const ctx = (locale: 'it' | 'en', reviewUrl: string | null = 'https://shop.example.test/pages/reviews'): ReviewEmailContext => ({
  to: 'buyer@example.test', customerName: 'Test Buyer', channelOrderId: 'TEST-1', channel: 'SHOPIFY', marketplace: 'DE',
  productName: 'Test Jacket', productType: 'giacca', reviewUrl, locale,
})
const FORBIDDEN = [/contact us first/i, /before you leave a review/i, /contattaci/i, /non lasciare/i, /negativ/i, /positive review/i, /5[- ]star/i, /recensione positiva/i, /href="#"/]

describe('review request e-mail', () => {
  for (const locale of ['it', 'en'] as const) {
    for (const identity of [xaviaIdentity(), other]) {
      it(`${locale} · ${identity.brandName}: an honest-review ask only, the support line about the order`, () => {
        const mail = renderReviewRequestEmail(ctx(locale), identity)
        for (const text of [mail.subject, mail.html, mail.text]) for (const bad of FORBIDDEN) expect(text).not.toMatch(bad)
        expect(mail.html).toMatch(locale === 'it' ? /opinione sincera/ : /share your honest feedback by leaving a review/)
        expect(mail.html).toContain('href="https://shop.example.test/pages/reviews"')
        expect(mail.html).toContain(locale === 'it' ? 'Per domande sul tuo ordine' : 'Questions about your order?')
        expect(mail.html).toContain(identity.brandMark)
      })
    }
    it(`${locale}: no review page → no button and no link, never a dead "#"`, () => {
      const mail = renderReviewRequestEmail(ctx(locale, null), other)
      expect(mail.html).not.toMatch(/<a href="(#|null|undefined)/)
      expect(mail.html).not.toMatch(locale === 'it' ? /Lascia una recensione →/ : /Leave a review →/)
      expect(mail.text).not.toMatch(locale === 'it' ? /Lascia una recensione:/ : /Leave a review:/)
    })
  }

  it('without a product name it says "your purchase" once, never "your your"', () => {
    const en = renderReviewRequestEmail({ ...ctx('en'), productName: null }, other)
    expect(en.subject).toBe('How is your purchase? Share your honest review')
    for (const text of [en.subject, en.html, en.text]) expect(text).not.toMatch(/your your/i)
    const italian = renderReviewRequestEmail({ ...ctx('it'), productName: null }, other)
    expect(italian.subject).toBe('Come ti trovi con il tuo acquisto? Lascia una recensione sincera')
  })

  it('escapes what the buyer and the catalogue put in', () => {
    const mail = renderReviewRequestEmail({ ...ctx('en'), customerName: '<b>x</b>', productName: 'A & B "C"' }, other)
    expect(mail.html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(mail.html).toContain('A &amp; B &quot;C&quot;')
  })
})
