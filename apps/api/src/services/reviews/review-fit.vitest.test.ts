/**
 * Reviews Insights › Fit by size (review-fit.ts, pure): the phrase map per language, negation and mixed reviews, the
 * fit theme gate, return reasons, sizes and their order, the verdict maths with its minimum, and the tables.
 */
import { describe, expect, it } from 'vitest'
import {
  basisWords, buildFitTable, buildProductFit, compareSizes, familyAdvice, fitCell, fitDirectionOfReview, fitDirectionOfText,
  MIN_FIT_SIGNALS, returnFitDirection, sizeKey, sizeOfVariant, type FitFamilyInfo, type FitSignal,
} from './review-fit.js'

describe('the phrase map, per language', () => {
  const cases: Record<string, Array<[string, 'small' | 'true' | 'large' | 'mixed' | null]>> = {
    en: [
      ['Great jacket but it runs small, order one size up.', 'small'],
      ['Sleeves a bit tight, otherwise fine', 'small'],
      ['Smaller than expected.', 'small'],
      ['I sized up and it is perfect', 'small'],
      ['Runs large — I would size down.', 'large'],
      ['Way too big on me', 'large'],
      ['Fits true to size.', 'true'],
      ['Perfect fit, very comfortable', 'true'],
      ['Sizing is spot on', 'true'],
      ['Quick delivery, nice colour', null],
    ],
    it: [
      ['Veste piccola, prendete una taglia in più', 'small'],
      ['Troppo stretta sulle spalle', 'small'],
      ['Ho preso la XL, è più piccola del previsto', 'small'],
      ['Consiglio una taglia più grande', 'small'],
      ['Veste abbondante', 'large'],
      ['Un po\' larga sui fianchi', 'large'],
      ['Meglio una taglia in meno', 'large'],
      ['Taglia giusta, calza a pennello', 'true'],
      ['Vestibilità perfetta', 'true'],
    ],
    de: [
      ['Gute Jacke, aber fällt klein aus. Ärmel zu kurz.', 'small'],
      ['Eine Nummer größer bestellen!', 'small'],
      ['Zu eng an den Schultern', 'small'],
      ['Fällt groß aus', 'large'],
      ['Faellt gross aus, eine Nummer kleiner reicht', 'large'],
      ['Größer als erwartet', 'large'],
      ['Passt perfekt', 'true'],
      ['Größe passt, sitzt wie angegossen', 'true'],
    ],
    fr: [
      ['Taille petit, prenez une taille au-dessus', 'small'],
      ['Un peu serré aux épaules', 'small'],
      ['Taille grand', 'large'],
      ['Trop grand pour moi, une taille en dessous suffit', 'large'],
      ['Taille normalement', 'true'],
      ['Bonne taille, conforme au guide', 'true'],
    ],
    es: [
      ['La talla es pequeña, pedid una talla más', 'small'],
      ['Me queda un poco justa', 'small'],
      ['Queda grande, mejor una talla menos', 'large'],
      ['Pedí una talla más pequeña y perfecto', 'large'],
      ['Talla perfecta, queda bien', 'true'],
      ['Se ajusta a la talla', 'true'],
    ],
  }
  for (const [language, list] of Object.entries(cases)) {
    it(`${language}: small, large and true to size`, () => {
      for (const [text, want] of list) expect([text, fitDirectionOfText(text)]).toEqual([text, want])
    })
  }

  it('a phrase after a negation does not count', () => {
    expect(fitDirectionOfText('It is not too small and not too big')).toBeNull()
    expect(fitDirectionOfText("Doesn't run small at all, fits perfectly")).toBe('true')
    expect(fitDirectionOfText('Nicht zu klein, passt gut')).toBe('true')
    expect(fitDirectionOfText('Non è troppo piccola, veste bene')).toBe('true')
    expect(fitDirectionOfText("Ce n'est pas trop petit")).toBeNull()
    expect(fitDirectionOfText('No queda pequeño')).toBeNull()
    expect(fitDirectionOfText("Doesn't fit well")).toBeNull()
  })

  it('small and large in one text cancel out; small or large beats "fits well"', () => {
    expect(fitDirectionOfText('The M was too small and the L too big')).toBe('mixed')
    expect(fitDirectionOfText('Fits well but a bit tight on the shoulders')).toBe('small')
    expect(fitDirectionOfText('')).toBeNull()
    expect(fitDirectionOfText(null)).toBeNull()
  })

  it('"order a bigger size" is runs small, never "big" = runs large (phrases are read once, in order)', () => {
    expect(fitDirectionOfText('Order a size bigger')).toBe('small')
    expect(fitDirectionOfText('Prendete una taglia più grande')).toBe('small')
    expect(fitDirectionOfText('Eine Größe größer nehmen')).toBe('small')
    expect(fitDirectionOfText('Prenez une taille plus grande')).toBe('small')
    expect(fitDirectionOfText('Pide una talla más grande')).toBe('small')
  })
})

describe('a review', () => {
  it('counts only with the fit theme (or not read by the AI yet); its own words first, then the English', () => {
    expect(fitDirectionOfReview({ body: 'The box was too small', categories: ['SHIPPING'] })).toBeNull()
    expect(fitDirectionOfReview({ body: 'Runs small', categories: ['FIT_SIZING', 'QUALITY'] })).toBe('small')
    expect(fitDirectionOfReview({ body: 'Runs small', categories: null })).toBe('small')
    expect(fitDirectionOfReview({ title: 'Fällt klein aus', body: 'Sonst super', categories: ['FIT_SIZING'] })).toBe('small')
    // A language the map does not read: the English translation decides.
    expect(fitDirectionOfReview({ body: 'Valt klein uit', bodyEnglish: 'Runs small', categories: ['FIT_SIZING'] })).toBe('small')
    // The own words win over the translation.
    expect(fitDirectionOfReview({ body: 'Veste grande', bodyEnglish: 'Runs small', categories: ['FIT_SIZING'] })).toBe('large')
    expect(fitDirectionOfReview({ body: 'Too small in M, too big in L', categories: ['FIT_SIZING'] })).toBeNull()
  })
})

describe('return reasons', () => {
  it('too small / too large codes of every channel and typed reasons', () => {
    expect(returnFitDirection('apparel too small')).toBe('small')
    expect(returnFitDirection('APPAREL_TOO_LARGE')).toBe('large')
    expect(returnFitDirection('amz-pg-app-too-small')).toBe('small')
    expect(returnFitDirection('size_too_large')).toBe('large')
    expect(returnFitDirection('Too small')).toBe('small')
    expect(returnFitDirection('troppo grande')).toBe('large')
    expect(returnFitDirection('Zu groß')).toBe('large')
  })
  it('"does not fit" counts with the buyer’s comment, else it is unclear; other reasons are not about fit', () => {
    expect(returnFitDirection('does not fit', 'Waist far too tight')).toBe('small')
    expect(returnFitDirection('does not fit', 'Muy grande')).toBe('unclear')
    expect(returnFitDirection('does not fit', 'Demasiado grande')).toBe('large')
    expect(returnFitDirection('wrong size', null)).toBe('unclear')
    expect(returnFitDirection('defective')).toBeNull()
    expect(returnFitDirection('no longer needed')).toBeNull()
    expect(returnFitDirection(null)).toBeNull()
  })
})

describe('sizes', () => {
  it('the size axis of a variant, by any of its names; the variations bag first', () => {
    expect(sizeOfVariant({ variantAttributes: { Size: 'M', Colour: 'Black' } })).toBe('M')
    expect(sizeOfVariant({ variantAttributes: { Taglia: 'XL' } })).toBe('XL')
    expect(sizeOfVariant({ variantAttributes: { Größe: ' 42 ' } })).toBe('42')
    expect(sizeOfVariant({ variantAttributes: { Size: 'M' }, categoryAttributes: { variations: { size: 'L' } } })).toBe('L')
    expect(sizeOfVariant({ variantAttributes: { Colour: 'Black' } })).toBeNull()
    expect(sizeOfVariant({})).toBeNull()
  })
  it('wearing order: letters, then numbers, then the rest; one key per spelling', () => {
    expect(['XL', 'S', '2XL', 'M', 'XS', 'L'].sort(compareSizes)).toEqual(['XS', 'S', 'M', 'L', 'XL', '2XL'])
    expect(['44', 'One size', '40', '42.5'].sort(compareSizes)).toEqual(['40', '42.5', '44', 'One size'])
    expect(sizeKey('xxl')).toBe(sizeKey('2XL'))
  })
})

describe('the verdict maths', () => {
  const c = (small: number, tru: number, large: number, returns = 0) => ({ small, true: tru, large, reviews: small + tru + large - returns, returns })
  it('below the minimum is too few — never a verdict, never shares', () => {
    expect(MIN_FIT_SIGNALS).toBe(5)
    const cell = fitCell('M', c(4, 0, 0))
    expect(cell).toMatchObject({ verdict: 'too_few', shares: null, share: null, total: 4 })
    expect(cell.words).toBe('Too few: 4 fit mentions (4 reviews); a size needs 5 before it gets a verdict.')
  })
  it('the leading way with at least half wins, with its share and what it rests on', () => {
    const cell = fitCell('M', c(7, 4, 1, 3))
    expect(cell).toMatchObject({ verdict: 'small', share: 58, shares: { small: 58, true: 33, large: 8 }, total: 12, reviews: 9, returns: 3 })
    expect(cell.words).toBe('Runs small: 7 of 12 fit mentions (58%), from 9 reviews and 3 returns.')
    expect(fitCell('L', c(0, 5, 0)).verdict).toBe('true')
    expect(fitCell('XL', c(1, 2, 3)).verdict).toBe('large')
  })
  it('a tie, or no way with half, is mixed', () => {
    expect(fitCell('S', c(3, 3, 0)).verdict).toBe('mixed')
    expect(fitCell('S', c(2, 2, 2)).verdict).toBe('mixed')
    expect(fitCell('S', c(4, 3, 2)).verdict).toBe('mixed')
    expect(fitCell('S', c(3, 3, 0)).words).toMatch(/^Buyers disagree/)
  })
  it('basis words', () => {
    expect(basisWords(1, 0)).toBe('1 review')
    expect(basisWords(0, 2)).toBe('2 returns')
    expect(basisWords(0, 0)).toBe('nothing yet')
  })
  it('what to tell buyers, from the sizes with a verdict only', () => {
    expect(familyAdvice([{ size: 'S', verdict: 'small' }, { size: 'M', verdict: 'small' }, { size: 'XL', verdict: 'too_few' }])).toBe('Runs small in every size with enough mentions (S and M): suggest one size up.')
    expect(familyAdvice([{ size: 'M', verdict: 'true' }])).toBe('True to size in M, the one size with enough mentions.')
    expect(familyAdvice([{ size: 'S', verdict: 'small' }, { size: 'M', verdict: 'true' }, { size: 'L', verdict: 'true' }, { size: 'XL', verdict: 'large' }]))
      .toBe('S runs small: suggest one size up; XL runs large: suggest one size down; M and L are true to size.')
    expect(familyAdvice([{ size: 'S', verdict: 'too_few' }])).toBe('Too few fit mentions per size to tell buyers anything yet.')
  })
})

describe('the tables', () => {
  const jacket: FitFamilyInfo = {
    id: 'jkt', name: 'Touring jacket', sku: 'TJ',
    sizes: ['S', 'M', 'L'],
    variants: [{ id: 'jkt-s', label: 'S · Black', size: 'S' }, { id: 'jkt-m', label: 'M · Black', size: 'M' }, { id: 'jkt-m-red', label: 'M · Red', size: 'M' }, { id: 'jkt-l', label: 'L · Black', size: 'L' }],
  }
  const gloves: FitFamilyInfo = { id: 'glv', name: 'Gloves', sku: 'GL', sizes: ['M', 'XL'], variants: [{ id: 'glv-m', label: 'M', size: 'M' }, { id: 'glv-xl', label: 'XL', size: 'XL' }] }
  const families = new Map([[jacket.id, jacket], [gloves.id, gloves]])
  const sig = (familyId: string, productId: string, size: string | null, direction: FitSignal['direction'], source: FitSignal['source'] = 'review'): FitSignal => ({ familyId, productId, size, direction, source })
  const signals: FitSignal[] = [
    ...Array.from({ length: 4 }, () => sig('jkt', 'jkt-m', 'M', 'small')),
    sig('jkt', 'jkt-m-red', 'M', 'small', 'return'),
    sig('jkt', 'jkt-m-red', 'M', 'true'),
    sig('jkt', 'jkt-s', 'S', 'small'),
    sig('jkt', 'jkt', null, 'small'),
    sig('glv', 'glv-xl', 'XL', 'large', 'return'),
  ]

  it('Themes: families by signals, a column per size with a signal, "not sold" where a family has no such size', () => {
    const t = buildFitTable({ signals, families, unclearReturns: 2 })
    expect(t.sizes).toEqual(['S', 'M', 'XL'])
    expect(t.families.map((f) => [f.familyId, f.signals, f.noSize])).toEqual([['jkt', 7, 1], ['glv', 1, 0]])
    const j = t.families[0]
    expect(j.cells.map((c) => c.verdict)).toEqual(['too_few', 'small', 'not_sold'])
    expect(j.cells[1]).toMatchObject({ size: 'M', total: 6, small: 5, true: 1, reviews: 5, returns: 1, share: 83 })
    expect(j.advice).toBe('Runs small in M, the one size with enough mentions: suggest one size up.')
    expect(t.families[1].cells.map((c) => c.verdict)).toEqual(['not_sold', 'too_few', 'too_few'])
    expect(t.summary).toEqual({ reviews: 6, returns: 2, unclearReturns: 2, noSize: 1, minimum: 5 })
    expect(t.words).toBe('From 6 reviews that say how the fit runs and 2 returns with the reason “too small” or “too large”. 1 fit mention names no size (the review is on the family, not a variant) and is not counted. 2 returns say only that it did not fit, without which way, and are not counted. Amazon topics carry no size, so Amazon counts only through returns and imported reviews. A size needs 5 mentions before it gets a verdict.')
  })

  it('Themes: the family limit, and nothing at all', () => {
    expect(buildFitTable({ signals, families, limit: 1 })).toMatchObject({ moreFamilies: 1, sizes: ['S', 'M'] })
    expect(buildFitTable({ signals: [], families: new Map() })).toMatchObject({ sizes: [], families: [], moreFamilies: 0, summary: { reviews: 0, returns: 0 } })
  })

  it('the pop-up: every size the family sells, and each variant (size and colour) on its own', () => {
    const p = buildProductFit({ signals, family: jacket })
    expect(p.sizes.map((c) => [c.size, c.verdict, c.total])).toEqual([['S', 'too_few', 1], ['M', 'small', 6], ['L', 'too_few', 0]])
    expect(p.variants.map((v) => [v.label, v.verdict, v.total])).toEqual([['S · Black', 'too_few', 1], ['M · Black', 'too_few', 4], ['M · Red', 'too_few', 2], ['L · Black', 'too_few', 0]])
    expect(p).toMatchObject({ reviews: 6, returns: 1, noSize: 1, family: { id: 'jkt' } })
    expect(p.advice).toMatch(/^Runs small in M/)
  })
})
