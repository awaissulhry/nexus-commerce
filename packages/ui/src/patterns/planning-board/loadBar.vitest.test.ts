import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LoadBar } from './LoadBar'
import { LOAD_BAR_WORDS, fillWords, loadAfterSentence, loadFigures, loadView, minutesFormatter } from './loadBarModel'

const en = minutesFormatter('en-GB')

describe('load figures (LoadBar, D18)', () => {
  it('booked against available, as a whole percent', () => {
    expect(loadFigures({ booked: 2340, available: 2880 })).toMatchObject({ state: 'ok', pct: 81, over: 0 })
    expect(loadFigures({ booked: 0, available: 2880 })).toMatchObject({ state: 'ok', pct: 0, bookedAt: 0 })
  })

  it('never says full or 100% unless it is exactly full; never 100% when over', () => {
    expect(loadFigures({ booked: 2868, available: 2880 }).pct).toBe(99)
    expect(loadFigures({ booked: 1, available: 100000 }).pct).toBe(1)
    expect(loadFigures({ booked: 2880, available: 2880 })).toMatchObject({ state: 'full', pct: 100 })
    expect(loadFigures({ booked: 2881, available: 2880 })).toMatchObject({ state: 'over', pct: 101, over: 1 })
  })

  it('over: the minutes over and where the capacity ends on the bar', () => {
    const over = loadFigures({ booked: 3520, available: 2880 })
    expect(over).toMatchObject({ state: 'over', pct: 122, over: 640, bookedAt: 100 })
    expect(over.capacityAt).toBeCloseTo(81.8, 1)
  })

  it('unknown is not zero; no working time set and no working time are said apart', () => {
    expect(loadFigures({ booked: 100, available: undefined })).toMatchObject({ state: 'unknown', pct: null })
    expect(loadFigures({ booked: 0, available: null })).toMatchObject({ state: 'none', pct: null })
    expect(loadFigures({ booked: 0, available: 0 })).toMatchObject({ state: 'closed', pct: null })
    expect(loadFigures({ booked: 120, available: 0 })).toMatchObject({ state: 'over', pct: null, over: 120, capacityAt: 0 })
    expect(loadFigures({ booked: Number.NaN, available: 100 })).toMatchObject({ state: 'ok', pct: 0 })
  })
})

describe('load words (LoadBar, D18)', () => {
  it('the design cell: "2,340 / 2,880 min · 81%"; over "+640 min over"', () => {
    const ok = loadView({ booked: 2340, available: 2880 }, LOAD_BAR_WORDS, en, 'Line 2, Tue')
    expect([ok.value, ok.minutes, ok.overText]).toEqual(['81%', '2,340 / 2,880 min', null])
    expect(ok.sentence).toBe('Line 2, Tue: 2,340 of 2,880 min booked, 81%.')
    const over = loadView({ booked: 3520, available: 2880 }, LOAD_BAR_WORDS, en, 'Line 2, Tue')
    expect([over.value, over.minutes, over.overText]).toEqual(['122%', '3,520 / 2,880 min', '+640 min over'])
    expect(over.sentence).toBe('Line 2, Tue: 3,520 of 2,880 min booked, 122%, 640 min over capacity.')
  })

  it('without a label the sentence starts with its first fact', () => {
    expect(loadView({ booked: 0, available: null }).sentence).toBe('No working time set, 0 min booked.')
    expect(loadView({ booked: 10, available: 20 }).sentence).toBe('10 of 20 min booked, 50%.')
  })

  it('unknown draws "—" and says it; no capacity and closed say so in words', () => {
    expect(loadView({ booked: 0, available: undefined })).toMatchObject({ value: '—', minutes: 'Load not known' })
    expect(loadView({ booked: 300, available: null })).toMatchObject({ value: '—', minutes: 'No working time set · 300 min booked' })
    expect(loadView({ booked: 0, available: 0 })).toMatchObject({ value: '—', minutes: 'No working time' })
    expect(loadView({ booked: 120, available: 0 })).toMatchObject({ value: '—', overText: '+120 min over' })
  })

  it('numbers in the page language (Italian: 15.300, a decimal comma; 4 digits stay ungrouped), words from the app', () => {
    const it = minutesFormatter('it-IT')
    const words = { ...LOAD_BAR_WORDS, minutes: '{booked} / {available} min', over: '+{over} min oltre', sentenceOver: '{label}: {booked} di {available} min, {pct}%, {over} min oltre.' }
    const view = loadView({ booked: 15940.5, available: 15300 }, words, it, 'Linea 2')
    expect(view.minutes).toBe('15.940,5 / 15.300 min')
    expect(view.overText).toBe('+640,5 min oltre')
    expect(view.sentence).toBe('Linea 2: 15.940,5 di 15.300 min, 104%, 640,5 min oltre.')
    expect(it(2340)).toBe('2340')
  })

  it('the preview sentence says the load after the move, then now', () => {
    const now = loadView({ booked: 2340, available: 2880 }, LOAD_BAR_WORDS, en, 'Line 2, Tue')
    const after = loadView({ booked: 2844, available: 2880 }, LOAD_BAR_WORDS, en, 'Line 2, Tue')
    expect(loadAfterSentence(now, after)).toBe('After the move, Line 2, Tue: 2,844 of 2,880 min booked, 99%. Now Line 2, Tue: 2,340 of 2,880 min booked, 81%.')
  })

  it('fills placeholders and leaves unknown ones as written', () => {
    expect(fillWords('{a} and {b}', { a: 1 })).toBe('1 and {b}')
  })
})

describe('LoadBar markup (D18)', () => {
  it('over: the figure, the minutes over in words and a hatched part after the capacity line', () => {
    const out = render(h(LoadBar, { booked: 3520, available: 2880, label: 'Line 2, Tue' }))
    expect(out).toContain('class="nds-loadbar sm is-over"')
    expect(out).toContain('>122%<')
    expect(out).toContain('>+640 min over<')
    expect(out).toContain('nds-loadbar-excess')
    expect(out).toContain('nds-loadbar-cap')
    expect(out).toContain('<span class="nds-vh">Line 2, Tue: 3,520 of 2,880 min booked, 122%, 640 min over capacity.</span>')
  })

  it('a preview is marked and says both loads', () => {
    const out = render(h(LoadBar, { booked: 2340, available: 2880, after: 2844, label: 'Line 2, Tue' }))
    expect(out).toContain('is-preview')
    expect(out).toContain('>after the move<')
    expect(out).toContain('After the move, Line 2, Tue: 2,844 of 2,880 min booked, 99%. Now Line 2, Tue: 2,340 of 2,880 min booked, 81%.')
  })

  it('with a detail it is a popover button named by the whole sentence', () => {
    const out = render(h(LoadBar, { booked: 10, available: 20, label: 'Line 1, Mon', detail: 'formula' }))
    expect(out).toMatch(/<button type="button" class="nds-detailpop-trigger nds-loadbar-trigger" aria-label="Line 1, Mon: 10 of 20 min booked, 50%\." aria-haspopup="dialog" aria-expanded="false"/)
    expect(out).not.toContain('nds-vh')
  })

  it('md shows the label unless the place already names it', () => {
    expect(render(h(LoadBar, { booked: 1, available: 2, label: 'Line 1', size: 'md' }))).toContain('nds-loadbar-label')
    expect(render(h(LoadBar, { booked: 1, available: 2, label: 'Line 1', size: 'md', labelVisible: false }))).not.toContain('nds-loadbar-label')
  })
})
