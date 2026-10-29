import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { FLOOR_NAMESPACES } from '../routes'
import { designScreen } from './fixtures'
import {
  addSet,
  areaUsed,
  convertArea,
  cutLines,
  draftLines,
  lotReasonOf,
  maySet,
  nextPicked,
  otherUnitOf,
  pendingSets,
  remnantMax,
  remnantProblem,
  remnantText,
  shadeMatch,
  sizeStates,
  undoSet,
  type CutCell,
} from './model'

const CELLS: CutCell[] = [
  { id: 'a', colourwayCode: 'NERO', size: '50', quantity: 10, toCut: 2 },
  { id: 'b', colourwayCode: 'NERO', size: '52', quantity: 10, toCut: 1 },
  { id: 'c', colourwayCode: 'NERO', size: '54', quantity: 10, toCut: 0 },
]

describe('SCR-094 areas: the other unit beside, never a float in the cut', () => {
  it('shows dm² beside sq ft and sq ft beside dm² and m²', () => {
    expect(otherUnitOf('FT2')).toBe('DM2')
    expect(otherUnitOf('DM2')).toBe('FT2')
    expect(otherUnitOf('M2')).toBe('FT2')
    expect(convertArea('10', 'FT2', 'DM2')).toBe('92.90')
    expect(convertArea('100', 'DM2', 'FT2')).toBe('10.76')
    expect(convertArea('x', 'FT2', 'DM2')).toBeNull()
  })

  it('area used = what is left less the remnant, shown not typed; the remnant at most what is left', () => {
    expect(areaUsed('52.4000', 12.5)).toBe('39.9000')
    expect(areaUsed('52.4000', null)).toBe('52.4000')
    expect(areaUsed('5.0000', 9)).toBe('0.0000')
    expect(remnantProblem('52.4000', null, true)).toBe('empty')
    expect(remnantProblem('52.4000', 0, false)).toBe('empty')
    expect(remnantProblem('52.4000', 12.5, true)).toBeNull()
    // With pieces logged, they used some of it: the remnant is less than what is left.
    expect(remnantProblem('52.4000', 52.4, true)).toBe('tooLarge')
    expect(remnantProblem('52.4000', 52.4, false)).toBeNull()
    expect(remnantProblem('52.4000', 60, false)).toBe('tooLarge')
    expect(remnantText(12.5)).toBe('12.5000')
    expect(remnantMax('52.4567')).toBe(52.45)
  })
})

describe('SCR-094 the draft of sets: one tap per set, Undo last set, never past what is left', () => {
  it('counts sets per size in the cells\' order and builds the cut\'s lines', () => {
    const draft = addSet(addSet(addSet([], 'b'), 'a'), 'a')
    expect(draftLines(draft, CELLS)).toEqual([
      { cellId: 'a', label: '50', sets: 2 },
      { cellId: 'b', label: '52', sets: 1 },
    ])
    expect(cutLines(draft, CELLS)).toEqual([
      { workOrderSizeId: 'a', sets: 2 },
      { workOrderSizeId: 'b', sets: 1 },
    ])
    expect(undoSet(draft)).toEqual(['b', 'a'])
  })

  it('holds a size that is all cut, counting the draft and the cuts saved here not yet recorded', () => {
    const sizes = sizeStates(CELLS, ['a'], new Map([['a', 1]]))
    expect(sizes.map((size) => [size.label, size.remaining, size.allCut])).toEqual([
      ['50', 0, true],
      ['52', 1, false],
      ['54', 0, true],
    ])
    expect(maySet(sizes, 'a')).toBe(false)
    expect(maySet(sizes, 'b')).toBe(true)
    expect(maySet(sizes, null)).toBe(false)
    // The picked size stays picked while it has garments left, else the next one that has.
    expect(nextPicked(sizes, 'b')).toBe('b')
    expect(nextPicked(sizes, 'a')).toBe('b')
  })

  it('names the colourway on a size only when the leather is cut for more than one', () => {
    const two: CutCell[] = [...CELLS, { id: 'd', colourwayCode: 'GRIGIO', size: '50', quantity: 4, toCut: 4 }]
    expect(sizeStates(two, []).map((size) => size.label)).toEqual(['NERO 50', 'NERO 52', 'NERO 54', 'GRIGIO 50'])
  })

  it('reads the sets of this work order\'s cuts still waiting in the queue', () => {
    const items = [
      { kind: 'production.cut.log', state: 'waiting', payload: { workOrderId: 'wo', lines: [{ workOrderSizeId: 'a', sets: 2 }] } },
      { kind: 'production.cut.log', state: 'recorded', payload: { workOrderId: 'wo', lines: [{ workOrderSizeId: 'a', sets: 5 }] } },
      { kind: 'production.cut.log', state: 'waiting', payload: { workOrderId: 'other', lines: [{ workOrderSizeId: 'a', sets: 5 }] } },
      { kind: 'production.scan.report', state: 'waiting', payload: { workOrderId: 'wo' } },
    ]
    expect([...pendingSets(items, 'wo')]).toEqual([['a', 2]])
  })
})

describe('SCR-094 the hide check', () => {
  it('compares the dye batch with the work order\'s other hides (information only)', () => {
    const others = [
      { hideId: 'h1', dyeBatch: '7731' },
      { hideId: 'h2', dyeBatch: '7731' },
    ]
    expect(shadeMatch('7731', others, 'h3')).toEqual({ kind: 'same', batch: '7731' })
    expect(shadeMatch('7745', others, 'h3')).toEqual({ kind: 'different', batch: '7745', others: ['7731'] })
    expect(shadeMatch('7731', [{ hideId: 'h3', dyeBatch: '7731' }], 'h3')).toEqual({ kind: 'first' })
    expect(shadeMatch(null, others, 'h3')).toEqual({ kind: 'unknown' })
  })

  it('says why a lot is not cut, the API\'s own code first', () => {
    expect(lotReasonOf({ qualityStatus: 'QUARANTINE', crViStatus: 'PENDING' })).toBe('CR_VI_PENDING')
    expect(lotReasonOf({ qualityStatus: 'QUARANTINE', crViStatus: 'PASS' })).toBe('QUALITY_HOLD')
    expect(lotReasonOf({ qualityStatus: 'BLOCKED', crViStatus: 'FAIL' })).toBe('CR_VI_FAILED')
    expect(lotReasonOf({ qualityStatus: 'REJECTED', crViStatus: 'PASS' })).toBe('REJECTED')
    expect(lotReasonOf({ qualityStatus: 'RELEASED', crViStatus: 'PASS' }, 'BLOCKED')).toBe('BLOCKED')
  })
})

describe('SCR-094 screens', () => {
  const html = (id: string, locale: 'it' | 'en') => {
    const item = designScreen.cases.find((entry) => entry.id === id)!
    const View = designScreen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, FLOOR_NAMESPACES) }, createElement(View, { model: item.model })))
  }

  it('shows the hide\'s area in both units, the draft, and the main action last', () => {
    const check = html('check-passed', 'en')
    expect(check).toContain('ft²')
    expect(check).toContain('dm²')
    expect(check).toContain('+ 1 set')
    expect(html('sets-drafted', 'en')).toContain('From this hide: 50 × 1 · 52 × 2')
    expect(html('size-all-cut', 'it')).toContain('La taglia 54 è tutta tagliata.')
  })

  it('stops the knife on a lot on hold, with where to put the hide back', () => {
    const lot = html('lot-on-hold', 'en')
    expect(lot).toContain('Do not cut this hide.')
    expect(lot).toContain('Put it back on Q1.')
  })

  it('says the two ticks honestly and never names who cut on another table', () => {
    expect(html('saved-offline', 'en')).toContain('Saved on this tablet')
    expect(html('recorded', 'it')).toContain("Registrato dall&#x27;ufficio")
    const other = html('cut-on-another-table', 'en')
    expect(other).toContain('Cut on Tavolo taglio 1')
    expect(other).not.toContain('Ada Demo · ')
  })
})
