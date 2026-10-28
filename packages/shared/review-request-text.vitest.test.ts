import { describe, expect, it } from 'vitest'

import {
  BODY_MAX,
  REQUEST_TEXT_LANGUAGES,
  STANDARD_REQUEST_TEXT,
  SUBJECT_MAX,
  checkRequestText,
  isStandardRequestText,
  readRuleEmailText,
  requestTextLanguageFor,
  requestTextSegments,
  ruleEmailTextRefusal,
  ruleEmailTextWords,
  ruleTextFor,
  sameRuleEmailText,
  type RequestText,
} from './review-request-text'

const own = (lang: 'it' | 'en', patch: Partial<RequestText> = {}): RequestText => ({ ...STANDARD_REQUEST_TEXT[lang], body: `${STANDARD_REQUEST_TEXT[lang].body}\n\nA line of our own.`, ...patch })
const codes = (t: RequestText) => checkRequestText(t).map((i) => i.code)

describe('a rule’s own review e-mail text — the check (Reviews N3, 2026-10-27)', () => {
  it('the standard texts pass the check (they are what a rule starts from)', () => {
    for (const lang of REQUEST_TEXT_LANGUAGES) expect(checkRequestText(STANDARD_REQUEST_TEXT[lang])).toEqual([])
  })

  it('refuses anything offered for a review, in both languages — but “feel free to share” is no offer', () => {
    for (const bad of ['Get a 10% discount for your review', 'Leave a review and receive a free gift', 'We send a coupon', 'Lascia una recensione e ricevi uno sconto', 'in cambio di una recensione', 'un buono regalo per te', 'Prodotto gratis']) {
      expect(codes(own('en', { body: `${own('en').body}\n\n${bad}` }))).toContain('incentive')
    }
    expect(codes(STANDARD_REQUEST_TEXT.en)).not.toContain('incentive')
    expect(codes(own('en', { body: `${STANDARD_REQUEST_TEXT.en.body}\n\nFeel free to write as much as you like.` }))).toEqual([])
    // Italian "premi il pulsante" (press the button) is no prize.
    expect(codes(own('it', { body: `${STANDARD_REQUEST_TEXT.it.body}\n\nPremi il pulsante qui sopra.` }))).toEqual([])
  })

  it('refuses asking only happy buyers, or sending unhappy ones elsewhere first', () => {
    for (const bad of ['If you are happy with it, leave a review', 'If you’re not satisfied, contact us first', 'Se sei soddisfatto lascia una recensione', 'Se ti è piaciuto, scrivi una recensione', 'Before leaving a review, write to us']) {
      expect(codes(own('en', { body: `${own('en').body}\n\n${bad}` }))).toContain('happy_only')
    }
  })

  it('refuses asking for 5 stars or a positive review, in the subject too', () => {
    for (const bad of ['Give us 5 stars', 'a five-star review', 'Leave a positive review', 'Lasciaci 5 stelle', 'una recensione positiva', '★★★★★']) {
      expect(codes(own('en', { body: `${own('en').body}\n\n${bad}` }))).toContain('five_stars')
    }
    const subject = checkRequestText(own('en', { subject: 'Rate us 5 stars!' }))
    expect(subject).toEqual([expect.objectContaining({ code: 'five_stars', where: 'subject', match: '5 stars' })])
  })

  it('keeps the required parts: the review button and the unsubscribe link', () => {
    expect(codes(own('en', { body: STANDARD_REQUEST_TEXT.en.body.replace('{review_button}', '') }))).toEqual(['missing_review_button'])
    expect(codes(own('it', { body: STANDARD_REQUEST_TEXT.it.body.replace('{unsubscribe_link}', 'non scriverci') }))).toEqual(['missing_unsubscribe_link'])
    expect(checkRequestText(own('en', { body: 'Hi' })).map((i) => i.words)).toEqual([
      'The review button is missing: put {review_button} back. Without it the buyer has nowhere to leave the review.',
      'The unsubscribe link is missing: put {unsubscribe_link} back. Every review e-mail must let the buyer stop them.',
    ])
  })

  it('refuses unknown parts, a button in the subject, empty and too long texts', () => {
    expect(checkRequestText(own('en', { subject: 'Hi {name}' }))[0]).toMatchObject({ code: 'unknown_part', where: 'subject', match: '{name}' })
    expect(codes(own('en', { subject: 'Review {review_button}' }))).toEqual(['part_in_subject'])
    expect(codes({ subject: ' ', body: '' })).toEqual(['empty_subject', 'empty_body'])
    expect(codes(own('en', { subject: 'x'.repeat(SUBJECT_MAX + 1) }))).toEqual(['subject_too_long'])
    expect(codes(own('en', { body: `${STANDARD_REQUEST_TEXT.en.body}\n\n${'x'.repeat(BODY_MAX)}` }))).toEqual(['body_too_long'])
  })

  it('a save is refused with the first reason, naming the language', () => {
    expect(ruleEmailTextRefusal(null)).toBeNull()
    expect(ruleEmailTextRefusal({ it: own('it'), en: own('en') })).toBeNull()
    expect(ruleEmailTextRefusal({ it: own('it', { subject: 'Ti regaliamo uno sconto' }) })).toBe(
      'Italian subject: It offers something for a review. Nothing may be given or promised for a review — no discount, gift, refund or free product. (“sconto”)',
    )
  })
})

describe('reading a rule’s texts and the language of a buyer', () => {
  it('Italian for Italy, English for every other market (the sender’s own choice)', () => {
    expect(requestTextLanguageFor('IT')).toBe('it')
    expect(requestTextLanguageFor(null)).toBe('it')
    expect(['DE', 'FR', 'UK', 'es'].map(requestTextLanguageFor)).toEqual(['en', 'en', 'en', 'en'])
  })

  it('the standard text is no text of the rule’s own; a language left out stays standard', () => {
    expect(isStandardRequestText('en', { subject: ` ${STANDARD_REQUEST_TEXT.en.subject}`, body: STANDARD_REQUEST_TEXT.en.body.replace(/\n/g, '\r\n') })).toBe(true)
    expect(readRuleEmailText({ it: STANDARD_REQUEST_TEXT.it, en: own('en') })).toEqual({ en: { ...own('en') } })
    expect(readRuleEmailText({ it: STANDARD_REQUEST_TEXT.it })).toBeNull()
    expect(readRuleEmailText('nonsense')).toBeNull()
    expect(readRuleEmailText({ en: { subject: 1, body: 'x' } })).toBeNull()
    expect(ruleEmailTextWords(null)).toBe('standard e-mail text')
    expect(ruleEmailTextWords({ en: own('en') })).toBe('own English text')
  })

  it('the sender gets the rule’s text for the buyer’s language only when it passes the check', () => {
    expect(ruleTextFor({ en: own('en') }, 'en')).toEqual(own('en'))
    expect(ruleTextFor({ en: own('en') }, 'it')).toBeNull()
    expect(ruleTextFor({ en: own('en', { subject: 'Free gift inside' }) }, 'en')).toBeNull()
  })

  it('two rules say the same when their own texts are equal (standard = standard)', () => {
    expect(sameRuleEmailText(null, { it: STANDARD_REQUEST_TEXT.it })).toBe(true)
    expect(sameRuleEmailText(null, { it: own('it') })).toBe(false)
  })

  it('cuts a text into paragraphs, the button and the unsubscribe line', () => {
    expect(requestTextSegments('Hi {first_name},\n\nTry it. {review_button} Thanks!\n\nStop? {unsubscribe_link}')).toEqual([
      { kind: 'paragraph', pieces: [{ kind: 'text', text: 'Hi {first_name},' }], footer: false },
      { kind: 'paragraph', pieces: [{ kind: 'text', text: 'Try it.' }], footer: false },
      { kind: 'button' },
      { kind: 'paragraph', pieces: [{ kind: 'text', text: 'Thanks!' }], footer: false },
      { kind: 'paragraph', pieces: [{ kind: 'text', text: 'Stop? ' }, { kind: 'unsubscribe' }], footer: true },
    ])
  })
})
