import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { productionWordsFor } from '../../../../lib/production/words'
import { COUNTED_STEPS, madeForOf, ownProgress, productionProgress } from './production'

/**
 * Lead fix (production-page lane): the order's Production tab wrote `sewn ?? 0` — "0 sewn" where the site does not scan sewing.
 * Now ONE figure (lib/production progressFigure: the bar shows what its words name) and, for a step the site does not count, "—"
 * with the reason in words.
 */
describe('the Production tab’s progress, honest where a step is not scanned', () => {
  const row = (progress: { cut: number | null; bundled: number | null; sewn: number | null; finished: number | null } | null, status = 'IN_PROGRESS') => ({ progress, pieces: 100, status }) as Parameters<typeof productionProgress>[0]

  it('a site that does not scan sewing: no "0 sewn", the step says it is not counted', () => {
    const { figure, notCounted } = productionProgress(row({ cut: 100, bundled: null, sewn: null, finished: 40 }))
    expect(notCounted).toEqual(['sewn'])
    expect(figure.step).toBe('finished')
    expect(figure.percent).toBe(40)
    for (const locale of LOCALES) {
      const words = productionWordsFor(locale)(figure.words.key, figure.words.params)
      expect(words).toMatch(/40/)
      expect(words).not.toMatch(/\b0\b/)
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      expect(t('production.notCounted.sewn')).not.toMatch(/production\.|\{/)
      for (const step of COUNTED_STEPS) expect(t(`production.step.${step}`)).not.toMatch(/production\./)
    }
  })

  it('the bar shows the figure its words name: sewn 80 of 100 is 80 %, never finished 0 %', () => {
    const { figure, notCounted } = productionProgress(row({ cut: 100, bundled: 90, sewn: 80, finished: 0 }))
    expect(figure).toMatchObject({ step: 'sewn', done: 80, percent: 80 })
    expect(notCounted).toEqual([])
  })

  it('every step counted: none is marked; a draft has no figure and no steps', () => {
    expect(productionProgress(row({ cut: 0, bundled: 0, sewn: 0, finished: 0 })).notCounted).toEqual([])
    const draft = productionProgress(row(null, 'DRAFT'))
    expect(draft.figure.percent).toBeNull()
    expect(draft.notCounted).toEqual([])
  })
})

// ---- F-SA-234: the order's OWN pieces on a work order, and what else it makes (no other customer named or counted) ------------
describe('F-SA-234: Production › Work orders — the order’s own pieces', () => {
  it('ONE figure of the own cells (checked = released by quality); a step not counted is listed, never 0; a draft has none', () => {
    const own = { cells: 4, pieces: 40, cut: 40, sewn: 30, checked: null }
    const { figure, notCounted } = ownProgress(own, 'IN_PROGRESS')
    expect(figure).toMatchObject({ step: 'sewn', done: 30, total: 40, percent: 75 })
    expect(notCounted).toEqual(['finished'])
    expect(ownProgress({ ...own, sewn: null }, 'IN_PROGRESS').notCounted).toEqual(['sewn', 'finished'])
    expect(ownProgress(own, 'DRAFT').figure.percent).toBeNull()
    expect(ownProgress(own, 'DRAFT').notCounted).toEqual([])
  })

  it('"Made for this order 40 of 100 · also makes SO-…": only this customer’s orders by number; another customer’s work in words only', () => {
    const own = { cells: 4, pieces: 40, cut: 40, sewn: 30, checked: 10 }
    expect(madeForOf(own, 100, { orders: [{ number: 'SO-2026-0151' }], more: 2 }, false, false)).toEqual([
      { key: 'production.own.of', params: { own: 40, total: 100 } },
      { key: 'production.own.alsoMakes', params: { number: 'SO-2026-0151' } },
      { key: 'production.own.alsoMore', params: { count: 2 } },
    ])
    const mixed = madeForOf(own, null, { orders: [], more: 0 }, true, true)
    expect(mixed.map((entry) => entry.key)).toEqual(['production.own.all', 'production.own.alsoOther', 'production.own.cutTogether'])
    expect(JSON.stringify(mixed)).not.toMatch(/SO-|Brand|Beta/)
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const entry of [...madeForOf(own, 100, { orders: [{ number: 'SO-1' }], more: 2 }, true, true)]) expect(t(entry.key, entry.params), `${locale}: ${entry.key}`).not.toMatch(/production\.|\{/)
      for (const key of ['production.held', 'production.rush', 'production.progressHeld', 'production.col.own', 'production.col.materials', 'gate.money', 'dates.customerSees', 'dates.cutStart', 'dates.sewStart', 'dates.finish']) expect(t(key, { date: 'x' }), `${locale}: ${key}`).not.toBe(key)
      expect(t('production.mtmRow', { style: 'S', colour: 'C', units: 12, workOrders: 12 })).toMatch(/12/)
    }
  })
})
// ---- end F-SA-234
