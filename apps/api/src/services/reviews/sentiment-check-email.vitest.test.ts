/**
 * Reviews — the "How was it?" e-mail promises nothing Nexus cannot keep (Owner, 2026-10-27): a buyer who presses
 * "Something's wrong" is told we will reply as soon as we can, never that it is fixed within 24 hours. Everything else
 * in the e-mail stays as it was (ruling 2). Pure renderer.
 */
import { describe, expect, it } from 'vitest'
import { xaviaIdentity } from '../business-identity.service.js'
import { renderSentimentCheckEmail, type SentimentEmailLocale } from './sentiment-check-email.service.js'

const LOCALES: SentimentEmailLocale[] = ['it', 'de', 'fr', 'es', 'en']
const render = (locale: SentimentEmailLocale) => renderSentimentCheckEmail({
  to: 'buyer@example.test', customerName: 'Test Buyer', productName: 'Test Jacket', baseUrl: 'https://nexus.example.test/r/TOKEN',
  channelOrderId: 'TEST-1', locale,
}, xaviaIdentity())

describe('"How was it?" e-mail', () => {
  for (const locale of LOCALES) {
    it(`${locale}: no 24-hour promise anywhere`, () => {
      const mail = render(locale)
      for (const text of [mail.subject, mail.html, mail.text]) expect(text).not.toMatch(/24\s*h|24 hours|24 ore|24 Stunden|24 heures|24 horas|fix it/i)
    })
  }

  it('the unhappy button says we will reply as soon as we can (in the English lines of every other language)', () => {
    for (const locale of LOCALES.filter((l) => l !== 'en')) {
      expect(render(locale).html).toContain('we&#39;ll reply as soon as we can.')
    }
  })

  it('both buttons and their pages are unchanged', () => {
    const mail = render('it')
    expect(mail.html).toContain('href="https://nexus.example.test/r/TOKEN/positive"')
    expect(mail.html).toContain('href="https://nexus.example.test/r/TOKEN/negative"')
    expect(mail.html).toContain('we&#39;ll send a short review invitation.')
  })
})
