import { describe, expect, it } from 'vitest'
import { planBundles, printBasketsWords, type PlanCell, type PlanFacts } from './rules'

/**
 * owb- (order workflow, S3 ss2 step 2.4, guard 2; PL-review § 4): the bench's "Make bundles" on a cell whose baskets were made at
 * "Print and start the work" ATTACHES the cell's new cut log entries to them (no new bundle, no new code); an over-cut beyond the
 * baskets still makes today's extra bundles; nothing new cut is refused in the print words. Made-up facts.
 */

const cell = (over: Partial<PlanCell> = {}): PlanCell => ({ cellId: 'c1', label: 'BLK 52', quantity: 4, cut: 4, bundled: 4, toBundle: 0, parts: [], ...over })
const facts = (cells: PlanCell[], asks: PlanFacts['asks'] = null): PlanFacts => ({ workOrder: { number: 'WO-T-1', status: 'IN_PROGRESS', kind: 'SIZE_GRID' }, cells, asks })

describe('planBundles ATTACH (baskets made at print)', () => {
  it('all cut: the cells with print baskets and new cuts attach; no bundle is planned', () => {
    expect(planBundles(facts([cell({ printBaskets: 4, toAttach: 2 })]))).toEqual({ ok: true, bundles: [], singlePiece: false, attach: ['c1'] })
  })

  it('nothing new cut for the baskets: refused in the print words', () => {
    const plan = planBundles(facts([cell({ printBaskets: 4, toAttach: 0 })]))
    expect(plan).toEqual({ ok: false, refusal: { code: 'NOTHING_TO_BUNDLE', message: printBasketsWords('BLK 52') } })
    const asked = planBundles(facts([cell({ printBaskets: 4, toAttach: 0 })], [{ cellId: 'c1' }]))
    expect(asked.ok ? null : asked.refusal.message).toBe('Baskets were made at print: the cuts go on them. BLK 52: nothing new is cut for them yet.')
  })

  it('a cell named by the bench attaches; an over-cut beyond the baskets still plans today’s extra bundle', () => {
    expect(planBundles(facts([cell({ printBaskets: 4, toAttach: 1 })], [{ cellId: 'c1' }]))).toEqual({ ok: true, bundles: [], singlePiece: false, attach: ['c1'] })
    const over = planBundles(facts([cell({ cut: 5, toBundle: 1, printBaskets: 4, toAttach: 1 })], [{ cellId: 'c1' }]))
    expect(over).toEqual({ ok: true, bundles: [{ cellId: 'c1', part: null, quantity: 1 }], singlePiece: false, attach: ['c1'] })
  })

  it('a site that bundles at cutting reads exactly as before (no attach key)', () => {
    expect(planBundles(facts([cell({ bundled: 0, toBundle: 4 })], [{ cellId: 'c1', bundleSize: 2 }]))).toEqual({ ok: true, bundles: [{ cellId: 'c1', part: null, quantity: 2 }, { cellId: 'c1', part: null, quantity: 2 }], singlePiece: false })
    expect(planBundles(facts([cell()])).ok).toBe(false)
  })
})
