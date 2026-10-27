/**
 * Amazon seller feedback — the removal check (Reviews PR H). Pure: one feedback's words and age → may qualify / struck
 * through, not removed / does not qualify / too old, with the reason and what to do in words. It never offers to ask
 * Amazon from Nexus (no API for it): the words send the person to Feedback Manager, and always say Amazon decides.
 */
import { describe, expect, it } from 'vitest'
import {
  feedbackRemovalCheck, foldText, fulfilmentOf, readFeedbackWords, REMOVAL_CAVEAT, REMOVAL_RULES, REMOVAL_WINDOW_DAYS,
} from './review-feedback-removal.js'

const NOW = new Date('2026-10-27T10:00:00Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000)
const check = (text: string, over: Partial<Parameters<typeof feedbackRemovalCheck>[0]> = {}) =>
  feedbackRemovalCheck({ text, postedAt: daysAgo(2), now: NOW, ...over })

describe('the four answers', () => {
  it('entirely about the product: may qualify, with the days left to ask', () => {
    const c = check('The gloves arrived with an open seam on the thumb.')
    expect(c).toMatchObject({ verdict: 'may_qualify', label: 'May qualify', tone: 'info', why: 'Entirely about the product, not your service', reasons: ['product_only'], daysLeft: 88 })
    expect(c.words).toBe(`Entirely about the product, not your service. Ask Amazon in Feedback Manager within 88 days. ${REMOVAL_CAVEAT}`)
  })

  it('only about the delivery of an FBA order: struck through, not removed', () => {
    const c = check('Delivery a week late.', { fulfilment: 'amazon' })
    expect(c).toMatchObject({ verdict: 'struck_through_not_removed', label: 'Struck through, not removed', tone: 'success', reasons: ['fba_delivery'] })
    expect(c.why).toBe('Only about FBA delivery: Amazon strikes it through')
  })

  it('only about delivery of an order the seller shipped, or nobody knows who: does not qualify, and says when Amazon strikes it', () => {
    const own = check('Pacco arrivato in ritardo di una settimana', { fulfilment: 'seller' })
    expect(own).toMatchObject({ verdict: 'does_not_qualify', reasons: ['delivery_you_shipped'] })
    expect(own.words).toMatch(/only if you shipped on time with Buy Shipping/)
    const unknown = check('Lieferung kam viel zu spät', { fulfilment: null })
    expect(unknown).toMatchObject({ verdict: 'does_not_qualify', reasons: ['delivery_unknown'] })
  })

  it('older than 90 days: too old to ask, whatever it says', () => {
    const c = check('Fuck this product', { postedAt: daysAgo(106) })
    expect(c).toMatchObject({ verdict: 'too_old', label: 'Too old to ask', tone: 'warning', ageDays: 106, daysLeft: 0 })
    expect(c.why).toBe('106 days old: removal requests go within 90 days (per Amazon staff guidance)')
    expect(check('Great seam', { postedAt: daysAgo(REMOVAL_WINDOW_DAYS) }).verdict).not.toBe('too_old')
  })
})

describe('what qualifies', () => {
  it('obscene or profane words, in any of the five languages', () => {
    for (const text of ['what a shit seller', 'venditore di merda', 'Scheiße Verkäufer', 'vendeur de merde', 'vendedor de mierda']) {
      expect(check(text)).toMatchObject({ verdict: 'may_qualify', reasons: ['obscene'] })
    }
    // "Shipping" is not "shit"; "Scunthorpe" is a place.
    expect(check('Shipping was slow from Scunthorpe').reasons).not.toContain('obscene')
  })

  it('personal details: an e-mail address or a phone number, but never the Amazon order id', () => {
    expect(check('Write me at buyer.example@example.com about the refund')).toMatchObject({ verdict: 'may_qualify', reasons: ['personal_details'] })
    expect(check('Call me on +39 333 123 4567, the seller never answers')).toMatchObject({ reasons: ['personal_details'] })
    expect(check('Order 028-1234567-1234567 never answered by the seller').reasons).not.toContain('personal_details')
  })

  it('a comment that mixes the product with the service does not qualify', () => {
    expect(check('Size runs small and the seller never replied')).toMatchObject({ verdict: 'does_not_qualify', reasons: ['mixed'] })
    expect(check('Taglia piccola e consegna in ritardo')).toMatchObject({ verdict: 'does_not_qualify', reasons: ['mixed'] })
  })

  it('a comment about the service alone, or nothing Nexus can read, does not qualify', () => {
    expect(check('The seller ignored my messages')).toMatchObject({ verdict: 'does_not_qualify', reasons: ['service'] })
    expect(check('Meh.')).toMatchObject({ verdict: 'does_not_qualify', reasons: ['unclear'] })
    expect(check('').verdict).toBe('does_not_qualify')
  })

  it('uses the English translation and the AI themes when the words alone say nothing', () => {
    expect(check('Ganz okay', { english: 'The quality is poor' }).verdict).toBe('may_qualify')
    expect(check('Hmm', { themes: ['QUALITY'] }).verdict).toBe('may_qualify')
    expect(check('Hmm', { themes: ['SHIPPING'], fulfilment: 'amazon' }).verdict).toBe('struck_through_not_removed')
  })
})

describe('words', () => {
  it('every answer ends by saying Nexus only checks and Amazon decides; none offers to ask Amazon from Nexus', () => {
    const texts = ['Great seam', 'Delivery late', 'seller rude', 'merda', 'x']
    for (const t of texts) {
      for (const fulfilment of ['amazon', 'seller', null] as const) {
        const c = check(t, { fulfilment })
        expect(c.words.endsWith(REMOVAL_CAVEAT)).toBe(true)
        expect(c.words).not.toMatch(/Ask Amazon to remove|from Nexus/i)
      }
    }
    expect(REMOVAL_RULES).toHaveLength(4)
    expect(REMOVAL_RULES[0]).toMatch(/within 90 days, in Feedback Manager \(per Amazon staff guidance\)/)
    expect(REMOVAL_RULES.join(' ')).toMatch(/struck through, not removed/)
  })

  it('folds accents and ß', () => {
    expect(foldText('Verspätet Größe Qualité')).toBe('verspatet grosse qualite')
    expect(readFeedbackWords('Verspätet')).toMatchObject({ delivery: true, product: false })
  })

  it('who shipped, from the order', () => {
    expect(fulfilmentOf('FBA')).toBe('amazon')
    expect(fulfilmentOf('AFN')).toBe('amazon')
    expect(fulfilmentOf('fbm')).toBe('seller')
    expect(fulfilmentOf('MFN')).toBe('seller')
    expect(fulfilmentOf(null)).toBeNull()
  })
})
