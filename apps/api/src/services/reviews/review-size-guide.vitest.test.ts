/**
 * Reviews › Fixes › Size guide (pure): which families get a fix (only the sizes fit by size itself judges small or
 * large), the words (what is wrong, the change, the evidence), the sizing bullet in each language (read back by the fit
 * phrase map as its own direction), and the re-check: one open fix per family and direction, refreshed, duplicates
 * closed, closed when the evidence is gone, never made again while a person's decision stands.
 */
import { describe, expect, it } from 'vitest'
import { emptyCounts, fitCell, fitDirectionOfText, fitFindings, type FitFamilyInfo, type FitFinding, type FitSignal } from './review-fit.js'
import {
  DUPLICATE_WORDS, SIZE_GUIDE_LANGUAGES, goneWords, planSizeGuideRecheck, sizeGuideFix, sizeGuideTitle, sizesWords, sizingLine,
  type SizeGuideRow,
} from './review-size-guide.js'

const NOW = new Date('2026-10-27T10:00:00Z')
const family = (id: string, sizes: string[]): FitFamilyInfo => ({ id, name: `Test ${id}`, sku: id.toUpperCase(), sizes, variants: sizes.map((s) => ({ id: `${id}-${s}`, label: s, size: s })) })
const signals = (familyId: string, size: string, direction: FitSignal['direction'], n: number, source: FitSignal['source'] = 'review'): FitSignal[] =>
  Array.from({ length: n }, () => ({ familyId, productId: `${familyId}-${size}`, size, direction, source }))

describe('findings: only the sizes fit by size judges one way', () => {
  const families = new Map([['jacket', family('jacket', ['S', 'M', 'L', 'XL'])], ['pants', family('pants', ['46', '48', '50'])]])
  const all = [
    ...signals('jacket', 'M', 'small', 4), ...signals('jacket', 'M', 'small', 2, 'return'), ...signals('jacket', 'M', 'true', 1),
    ...signals('jacket', 'L', 'small', 3), ...signals('jacket', 'L', 'small', 2, 'return'),
    ...signals('jacket', 'S', 'small', 4), // too few: no verdict
    ...signals('jacket', 'XL', 'large', 5),
    ...signals('pants', '48', 'small', 3), ...signals('pants', '48', 'large', 3), // mixed: no verdict
  ]
  const found = fitFindings({ signals: all, families })

  it('a family per direction with a verdict; too few and mixed sizes never count', () => {
    expect(found.map((f) => [f.familyId, f.direction, f.sizes])).toEqual([['jacket', 'small', ['M', 'L']], ['jacket', 'large', ['XL']]])
    expect(found[0]).toMatchObject({ reviews: 7, returns: 4, familySizes: ['S', 'M', 'L', 'XL'] })
    // The verdict is fitCell's own: the same counts give the same words.
    const m = { ...emptyCounts(), small: 6, true: 1, reviews: 5, returns: 2 }
    expect(found[0].cells[0]).toEqual({ size: 'M', words: fitCell('M', m).words })
  })

  it('says what is wrong, the change, and the evidence', () => {
    const fix = sizeGuideFix(found[0], 'it', NOW)
    expect(fix.title).toBe('Runs small: 7 reviews and 4 size returns say so for sizes M–L')
    expect(fix.payload).toMatchObject({
      direction: 'small', sizes: ['M', 'L'], sizesText: 'M–L', allSizes: false, reviews: 7, returns: 4, language: 'it',
      advice: 'Tell buyers to order one size up in sizes M–L: in the size guide and in the listing text.',
      line: 'Le taglie M–L vestono piccole: consigliamo di ordinare una taglia in più.',
      english: 'Sizes M–L run small: we suggest ordering one size up.',
      evidence: [expect.stringMatching(/^M — Runs small: 6 of 7 fit mentions/), expect.stringMatching(/^L — Runs small: 5 of 5/)],
      checkedAt: NOW.toISOString(), evidenceGoneAt: null, closed: null,
    })
    expect(fix.detail).toMatch(/last 12 months: a size needs 5 fit mentions/)
    const large = sizeGuideFix(found[1], 'en', NOW)
    expect(large.title).toBe('Runs large: 5 reviews say so for size XL')
    expect(large.payload).toMatchObject({ line: 'Size XL runs large: we suggest ordering one size down.', advice: 'Tell buyers to order one size down in size XL: in the size guide and in the listing text.' })
  })

  it('every size of the family: the sentence names none', () => {
    const one = new Map([['gloves', family('gloves', ['M', 'L'])]])
    const [f] = fitFindings({ signals: [...signals('gloves', 'M', 'small', 5), ...signals('gloves', 'L', 'small', 5, 'return')], families: one })
    expect(sizeGuideFix(f, 'de', NOW).payload).toMatchObject({
      allSizes: true, advice: 'Tell buyers to order one size up: in the size guide and in the listing text.',
      line: 'Fällt klein aus: wir empfehlen, eine Größe größer zu bestellen.',
    })
    expect(sizeGuideTitle(f)).toBe('Runs small: 5 reviews and 5 size returns say so for sizes M–L')
  })
})

describe('words', () => {
  it('a range when the sizes follow each other, else a list', () => {
    expect(sizesWords(['M', 'L'], ['S', 'M', 'L', 'XL'])).toBe('M–L')
    expect(sizesWords(['S', 'M', 'XL'], ['S', 'M', 'L', 'XL'])).toBe('S, M and XL')
    expect(sizesWords(['S', 'XL'], ['S', 'M', 'L', 'XL'], 'it')).toBe('S e XL')
    expect(sizesWords(['M'], ['S', 'M'])).toBe('M')
  })

  it('the sizing bullet in every language reads back as its own direction (the fit phrase map)', () => {
    expect(SIZE_GUIDE_LANGUAGES.sort()).toEqual(['de', 'en', 'es', 'fr', 'it'])
    for (const language of SIZE_GUIDE_LANGUAGES) {
      for (const direction of ['small', 'large'] as const) {
        for (const [sizes, allSizes] of [[['M'], false], [['M', 'L'], false], [['S', 'M', 'L'], true]] as const) {
          const line = sizingLine(direction, sizes, ['S', 'M', 'L', 'XL'], allSizes, language)!
          expect(fitDirectionOfText(line), `${language} ${direction} ${line}`).toBe(direction)
        }
      }
    }
    expect(sizingLine('small', ['M'], ['M'], false, 'nl')).toBeNull()
  })

  it('says why the re-check closed a fix', () => {
    expect(goneWords({ direction: 'small', sizes: ['M', 'L'], sizesText: 'M–L' })).toBe('Closed by Nexus: the reviews and returns of the last 12 months no longer say sizes M–L run small.')
    expect(goneWords({ direction: 'large', sizes: ['XL'], sizesText: 'XL' })).toBe('Closed by Nexus: the reviews and returns of the last 12 months no longer say size XL runs large.')
    expect(goneWords({ direction: 'small', sizes: ['M', 'L'], allSizes: true })).toMatch(/no longer say its sizes run small\.$/)
  })
})

describe('the re-check', () => {
  const finding = (over: Partial<FitFinding> = {}): FitFinding => ({
    familyId: 'jacket', name: 'Test jacket', sku: 'JACKET', direction: 'small', sizes: ['M', 'L'], familySizes: ['S', 'M', 'L'], reviews: 7, returns: 4,
    cells: [{ size: 'M', words: 'Runs small: 6 of 7 fit mentions (86%), from 4 reviews and 3 returns.' }, { size: 'L', words: 'Runs small: 5 of 5 fit mentions (100%), from 3 reviews and 2 returns.' }],
    ...over,
  })
  const fresh = sizeGuideFix(finding(), 'it', NOW)
  let n = 0
  const row = (over: Partial<SizeGuideRow> & { payload?: Record<string, unknown> } = {}): SizeGuideRow => ({
    id: `r${++n}`, productId: 'jacket', status: 'OPEN', title: fresh.title, detail: fresh.detail, createdAt: new Date(NOW.getTime() - n * 1000), ...over,
    payload: { ...fresh.payload, ...over.payload },
  })

  it('makes one fix for a family and direction with evidence', () => {
    expect(planSizeGuideRecheck([], [finding(), finding({ direction: 'large', sizes: ['S'] })], 'it', NOW).map((s) => [s.op, 'productId' in s ? s.productId : null, 'payload' in s ? s.payload.direction : null]))
      .toEqual([['create', 'jacket', 'small'], ['create', 'jacket', 'large']])
  })

  it('leaves an open fix with the same evidence alone, refreshes it when the evidence moved, and closes duplicates', () => {
    expect(planSizeGuideRecheck([row()], [finding()], 'it', NOW)).toEqual([])
    const later = new Date(NOW.getTime() + 86_400_000)
    expect(planSizeGuideRecheck([row()], [finding()], 'it', later)).toEqual([]) // only the time of the check moved
    const moved = planSizeGuideRecheck([row({ id: 'keep' })], [finding({ reviews: 9 })], 'it', NOW)
    expect(moved).toEqual([{ op: 'refresh', id: 'keep', title: 'Runs small: 9 reviews and 4 size returns say so for sizes M–L', detail: fresh.detail, payload: expect.objectContaining({ reviews: 9 }) }])
    const dup = planSizeGuideRecheck([row({ id: 'old', createdAt: new Date(0) }), row({ id: 'new' })], [finding()], 'it', NOW)
    expect(dup).toEqual([{ op: 'close', id: 'old', payload: expect.objectContaining({ closed: { words: DUPLICATE_WORDS, at: NOW.toISOString() } }) }])
  })

  it('keeps a person’s words while the sizes stay; new sizes are new words', () => {
    const edited = row({ id: 'e', title: 'Our own title', payload: { line: 'Prendete una taglia in più.', english: 'Take one size up.', edited: true } })
    expect(planSizeGuideRecheck([edited], [finding({ reviews: 9 })], 'it', NOW)).toEqual([
      { op: 'refresh', id: 'e', title: 'Our own title', detail: fresh.detail, payload: expect.objectContaining({ reviews: 9, line: 'Prendete una taglia in più.', english: 'Take one size up.', edited: true }) },
    ])
    const [step] = planSizeGuideRecheck([edited], [finding({ sizes: ['M'] })], 'it', NOW)
    expect(step).toMatchObject({ op: 'refresh', title: 'Runs small: 7 reviews and 4 size returns say so for size M', payload: { line: 'La taglia M veste piccola: consigliamo di ordinare una taglia in più.', edited: false } })
  })

  it('closes an open fix when its evidence is gone, and marks a decided one so it can come back', () => {
    expect(planSizeGuideRecheck([row({ id: 'o' })], [], 'it', NOW)).toEqual([{
      op: 'close', id: 'o', payload: expect.objectContaining({ evidenceGoneAt: NOW.toISOString(), closed: { words: 'Closed by Nexus: the reviews and returns of the last 12 months no longer say sizes M–L run small.', at: NOW.toISOString() } }),
    }])
    expect(planSizeGuideRecheck([row({ id: 'd', status: 'DISMISSED' })], [], 'it', NOW)).toEqual([{ op: 'gone', id: 'd', payload: expect.objectContaining({ evidenceGoneAt: NOW.toISOString() }) }])
    expect(planSizeGuideRecheck([row({ id: 'a', status: 'APPLIED', payload: { evidenceGoneAt: '2026-10-01T00:00:00Z' } })], [], 'it', NOW)).toEqual([])
    expect(planSizeGuideRecheck([row({ status: 'SENT' })], [], 'it', NOW)).toEqual([])
  })

  it('never makes a new fix while a person’s decision stands; once the evidence went away and came back, it does', () => {
    expect(planSizeGuideRecheck([row({ status: 'DISMISSED' })], [finding()], 'it', NOW)).toEqual([])
    expect(planSizeGuideRecheck([row({ status: 'APPLIED' })], [finding()], 'it', NOW)).toEqual([])
    expect(planSizeGuideRecheck([row({ status: 'SENT' }), row({ status: 'DISMISSED', payload: { evidenceGoneAt: NOW.toISOString() } })], [finding()], 'it', NOW)).toEqual([])
    expect(planSizeGuideRecheck([row({ status: 'DISMISSED', payload: { evidenceGoneAt: '2026-10-01T00:00:00Z' } })], [finding()], 'it', NOW).map((s) => s.op)).toEqual(['create'])
    // Only the newest decides: an old gone one under a newer dismissed one keeps it closed.
    const old = row({ status: 'DISMISSED', createdAt: new Date(0), payload: { evidenceGoneAt: '2026-10-01T00:00:00Z' } })
    expect(planSizeGuideRecheck([old, row({ status: 'DISMISSED' })], [finding()], 'it', NOW)).toEqual([])
  })

  it('leaves rows without a direction or product alone', () => {
    expect(planSizeGuideRecheck([{ id: 'x', productId: null, status: 'OPEN', title: 't', detail: null, payload: { direction: 'small' }, createdAt: NOW }, { id: 'y', productId: 'p', status: 'OPEN', title: 't', detail: null, payload: {}, createdAt: NOW }], [], 'it', NOW)).toEqual([])
  })
})
