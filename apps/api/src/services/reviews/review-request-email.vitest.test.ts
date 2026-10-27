/**
 * Reviews — our review e-mail to Shopify buyers asks every buyer the same way for an HONEST review (Owner,
 * 2026-10-27; audit E1; CHANNEL-FACTS 5a, 5b, 6). Never "contact us first", never "don't leave a negative review",
 * never a positive-only ask; no button (and no `#`) without a review page. Pure renderer.
 * N3 — a rule's own subject and text per language: the standard e-mail is unchanged without one; with one, its words in
 * the same frame (button, unsubscribe link, footer); a stored text the check refuses is never sent.
 */
import { describe, expect, it } from 'vitest'
import { xaviaIdentity, type BusinessIdentity } from '../business-identity.service.js'
import { renderReviewRequestEmail, type ReviewEmailContext } from './review-request-email.service.js'
import { STANDARD_REQUEST_TEXT } from '@nexus/shared/review-request-text'

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

describe('N3 — a rule’s own subject and text per language', () => {
  const ownEn = {
    subject: 'Your {product} — tell other riders what you think',
    body: 'Hello {first_name},\n\nWhat about {aspects}? Tell other riders the truth.\nThank you!\n\n{review_button}\n\nNo more of these e-mails? {unsubscribe_link}',
  }
  const ownIt = { ...STANDARD_REQUEST_TEXT.it, subject: 'Com’è {product}? Racconta la verità' }

  it('without one (every rule until a person writes and saves one) the standard e-mail is unchanged, word for word', () => {
    for (const locale of ['it', 'en'] as const) {
      const standard = renderReviewRequestEmail(ctx(locale), other)
      expect(renderReviewRequestEmail({ ...ctx(locale), ruleText: null }, other)).toEqual(standard)
      expect(renderReviewRequestEmail({ ...ctx(locale), ruleText: undefined, unsubscribeUrl: 'https://unsub.example.test/x' }, other)).toEqual(standard)
    }
    // Pinned: the standard English e-mail's subject and plain text as buyers get them today.
    const en = renderReviewRequestEmail(ctx('en'), other)
    expect(en.subject).toBe('How is your Test Jacket? Share your honest review')
    expect(en.text).toBe([
      'Hi Test,', '', "Thank you for your purchase! We hope you've had the chance to try your Test Jacket.", '',
      'Feel free to share your honest feedback by leaving a review (for example about the fit and protection of the jacket).', '',
      'Leave a review: https://shop.example.test/pages/reviews', '', '— The Test Moto Team',
    ].join('\n'))
  })

  it('the rule’s words in the same frame: parts filled, the button where {review_button} stands, the unsubscribe link', () => {
    const mail = renderReviewRequestEmail({ ...ctx('en'), ruleText: ownEn, unsubscribeUrl: 'https://unsub.example.test/u?token=t' }, other)
    expect(mail.subject).toBe('Your Test Jacket — tell other riders what you think')
    expect(mail.html).toContain('Hello Test,')
    expect(mail.html).toContain('What about the fit and protection of the jacket? Tell other riders the truth.<br>Thank you!')
    expect(mail.html).toContain('href="https://shop.example.test/pages/reviews"')
    expect(mail.html).toContain('href="https://unsub.example.test/u?token=t"')
    expect(mail.html).toContain('Questions about your order?')
    expect(mail.html).toContain(other.brandMark)
    expect(mail.html.indexOf('Thank you!')).toBeLessThan(mail.html.indexOf('Leave a review →'))
    expect(mail.text).toContain('Leave a review: https://shop.example.test/pages/reviews')
    expect(mail.text).toContain('No more of these e-mails? Unsubscribe: https://unsub.example.test/u?token=t')
    expect(mail.html).not.toContain('{')
  })

  it('Italian with the Italian words; no review page → no button and never a dead link', () => {
    const mail = renderReviewRequestEmail({ ...ctx('it', null), ruleText: ownIt }, other)
    expect(mail.subject).toBe('Com’è Test Jacket? Racconta la verità')
    expect(mail.html).not.toMatch(/Lascia una recensione →/)
    expect(mail.html).not.toMatch(/<a href="(#|null|undefined)/)
    expect(mail.html).toContain('Annulla l’iscrizione')
    expect(mail.html).toContain('Per domande sul tuo ordine')
  })

  it('escapes what the buyer, the catalogue and the rule put in', () => {
    const mail = renderReviewRequestEmail({ ...ctx('en'), customerName: '<b>x</b>', productName: 'A & B', ruleText: { ...ownEn, body: `<script>x</script> {first_name}\n\n${ownEn.body}` } }, other)
    expect(mail.html).toContain('&lt;script&gt;x&lt;/script&gt; &lt;b&gt;x&lt;/b&gt;')
    expect(mail.html).not.toContain('<script>')
  })

  it('a stored text the check refuses is never sent: the standard e-mail goes instead', () => {
    const bad = { ...ownEn, subject: 'Leave 5 stars for a discount' }
    expect(renderReviewRequestEmail({ ...ctx('en'), ruleText: bad }, other)).toEqual(renderReviewRequestEmail(ctx('en'), other))
  })
})
