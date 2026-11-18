import { describe, expect, it } from 'vitest'
import { planChanges, type WantedLine, type WorkCell } from '../../order-apply/rules'
import { amendStepOf, APPLY_WORDS, floorStageOf, inWorkWords, isOpenStep, numbered, outcomeOptionsOf, repromiseStepOf, workshopStepOf, workStepOf, type WorkFacts } from './apply-plan'

/**
 * B-SA-045: the review window's apply plan, pure — the same plan before Accept (planned) and after it (the stored changes), steps
 * per freeze stage (a DRAFT, a released work order nothing of which is cut, one cut beyond the new figure), a raise, a colour change
 * and a cancel, the extra pieces and their outcomes. Made-up names only.
 */

const LINE = '00000000-0000-4000-8000-000000000001'
const cell = (over: Partial<WorkCell>): WorkCell => ({ workOrderId: 'wo-1', number: 'WO-0142', status: 'RELEASED', kind: 'SIZE_GRID', styleId: 'style-1', siteId: 'site-1', cellId: 'cell-1', salesOrderLineId: LINE, size: 'M', quantity: 40, cut: 0, ...over })
const wanted = (sizes: Record<string, number>): WantedLine => ({ lineId: LINE, styleId: 'style-1', siteId: null, madeToMeasure: false, sizes: new Map(Object.entries(sizes)) })
const facts = (over: Partial<WorkFacts>): WorkFacts => ({ kind: 'LOWER_TO_ORDER', status: 'PLANNED', number: 'WO-0142', cells: [{ size: 'M', from: 40, to: 36 }], extra: 0, decisionNote: null, lastError: null, person: null, mayApply: false, ...over })
/** A planned change as the API turns it into a step (the same rules the Accept runs). */
const plannedStep = (cells: readonly WorkCell[], sizes: Record<string, number>) =>
  planChanges([wanted(sizes)], cells).map((change) => workStepOf(facts({ kind: change.kind, number: change.number, cells: change.cells, extra: change.extra.reduce((sum, piece) => sum + piece.count, 0) })))

describe('What happens next, per freeze stage (B-SA-045)', () => {
  it('a DRAFT or a released work order nothing of which is cut: one lowering, sent to planning after Accept, no extra pieces', () => {
    for (const status of ['DRAFT', 'RELEASED'] as const) {
      const [step] = plannedStep([cell({ status })], { M: 36 })
      expect(step).toEqual({ kind: 'LOWER_TO_ORDER', state: 'TO_DO', team: 'PLANNER', words: { en: 'WO-0142: make M 40 → 36', it: 'WO-0142: produci M 40 → 36' }, why: APPLY_WORDS.workBefore, mayDoNow: false })
    }
  })

  it('cut beyond the new figure: never NOT_POSSIBLE (review C-16) — the same lowering, its cut pieces extra pieces', () => {
    const [step] = plannedStep([cell({ status: 'IN_PROGRESS', cut: 38 })], { M: 36 })
    expect(step).toMatchObject({ kind: 'LOWER_TO_ORDER', state: 'TO_DO', words: { en: 'WO-0142: make M 40 → 36 · 2 extra pieces already cut', it: 'WO-0142: produci M 40 → 36 · 2 pezzi in più già tagliati' } })
  })

  it('a raise makes more in a DRAFT, or a new work order when only released ones make the line', () => {
    expect(plannedStep([cell({ status: 'DRAFT' })], { M: 44 })[0]).toMatchObject({ kind: 'MAKE_MORE', words: { en: 'WO-0142: make more, M 40 → 44' } })
    expect(plannedStep([cell({ status: 'RELEASED' })], { M: 44 })[0]).toMatchObject({ kind: 'MAKE_MORE', words: { en: 'A new work order: M 0 → 4', it: 'Un nuovo ordine di lavoro: M 0 → 4' } })
  })

  it('a colour change and a cancel lower the old line to what it still wants (nothing: the whole line)', () => {
    const [step] = plannedStep([cell({ status: 'RELEASED' })], { M: 0 })
    expect(step).toMatchObject({ kind: 'LOWER_TO_ORDER', words: { en: 'WO-0142: make M 40 → 0' } })
  })

  it('a work order the reader does not reach is "A work order", never its number', () => {
    expect(workStepOf(facts({ number: null })).words).toEqual({ en: 'A work order: make M 40 → 36', it: 'Un ordine di lavoro: produci M 40 → 36' })
  })

  it('after Accept: PROPOSED (who decides named, the reader may act only with the right), DONE, left as is with why, stale', () => {
    expect(workStepOf(facts({ status: 'PROPOSED', person: 'Carla Prova', mayApply: true }))).toMatchObject({ state: 'PROPOSED', why: { en: 'Sent to planning: Carla Prova decides', it: 'Inviato alla pianificazione: decide Carla Prova' }, mayDoNow: true })
    expect(workStepOf(facts({ status: 'PROPOSED', lastError: 'WO-0142 is on hold' }))).toMatchObject({ state: 'PROPOSED', why: { en: 'The last try was refused: WO-0142 is on hold' }, mayDoNow: false })
    expect(workStepOf(facts({ status: 'APPLIED' }))).toMatchObject({ state: 'DONE', why: null })
    expect(workStepOf(facts({ status: 'DECLINED', decisionNote: 'Keep the 4 as overs' }))).toMatchObject({ state: 'LEFT_AS_IS', why: { en: 'Left as is: Keep the 4 as overs', it: 'Lasciato così: Keep the 4 as overs' } })
    expect(workStepOf(facts({ status: 'STALE' }))).toMatchObject({ state: 'NOT_POSSIBLE', why: APPLY_WORDS.noLongerNeeded })
    expect(['TO_DO', 'PROPOSED', 'DONE', 'NOT_POSSIBLE', 'LEFT_AS_IS'].filter((state) => isOpenStep(state as never))).toEqual(['TO_DO', 'PROPOSED'])
  })
})

describe('this Accept, the promise, the workshop (B-SA-045)', () => {
  const base = { kind: 'CHANGE' as const, status: 'OPEN' as const, wholeCancel: false, revision: null, problems: [], mayAnswer: true }

  it('AMEND: to do (the reader may answer), held with why, done with the revision; a cancel says what it closes', () => {
    expect(amendStepOf(base)).toMatchObject({ kind: 'AMEND', state: 'TO_DO', team: 'SALES', mayDoNow: true })
    const held = { en: 'Already cut in Black: 40 pieces. Suggest something else or refuse.', it: 'Già tagliati in Nero: 40 pezzi. Proponi altro o rifiuta.' }
    expect(amendStepOf({ ...base, problems: [held] })).toMatchObject({ state: 'NOT_POSSIBLE', why: held, mayDoNow: false })
    expect(amendStepOf({ ...base, status: 'ACCEPTED', revision: 3 })).toMatchObject({ state: 'DONE', words: { en: 'This Accept: the order is changed as asked (revision 3)', it: "Questa accettazione: l'ordine viene modificato come richiesto (revisione 3)" } })
    expect(amendStepOf({ ...base, kind: 'CANCEL', wholeCancel: true }).words.en).toBe('This Accept: the order is cancelled')
    expect(amendStepOf({ ...base, kind: 'CANCEL' }).words.en).toBe('This Accept: the lines asked are closed short')
  })

  it('REPROMISE only when the earliest date passes the promise: to do before Accept, then a waiting proposal, then done', () => {
    const promise = { accepted: false, promise: '2026-12-01', earliest: '2026-12-04', waitingProposals: 0, decidedProposals: 0, mayChange: true }
    expect(repromiseStepOf({ ...promise, earliest: '2026-11-28' })).toBeNull()
    expect(repromiseStepOf(promise)).toMatchObject({ kind: 'REPROMISE', state: 'TO_DO', team: 'SALES', words: { en: 'Promise: promised 1 Dec, earliest now 4 Dec' }, mayDoNow: false })
    expect(repromiseStepOf({ ...promise, accepted: true })).toMatchObject({ state: 'TO_DO', why: APPLY_WORDS.repromiseYourTurn, mayDoNow: true })
    expect(repromiseStepOf({ ...promise, accepted: true, waitingProposals: 1 })).toMatchObject({ state: 'PROPOSED', why: APPLY_WORDS.repromiseWaiting })
    expect(repromiseStepOf({ ...promise, accepted: true, decidedProposals: 1 })).toMatchObject({ state: 'DONE' })
    expect(repromiseStepOf({ ...promise, accepted: true, promise: '2026-12-05' })).toBeNull()
  })

  it('TELL_WORKSHOP: one step for the outside workshops (no customer named); done once each was told', () => {
    expect(workshopStepOf({ workshops: 0, told: 0 })).toBeNull()
    expect(workshopStepOf({ workshops: 2, told: 1 })).toMatchObject({ kind: 'TELL_WORKSHOP', state: 'TO_DO', words: { en: 'Tell the 2 outside workshops that make it', it: 'Avvisa i 2 terzisti che lo producono' } })
    expect(workshopStepOf({ workshops: 1, told: 1 })).toMatchObject({ state: 'DONE', why: null })
  })

  it('numbers the steps in the plan’s order, AMEND first', () => {
    const steps = numbered([amendStepOf(base), null, workStepOf(facts({})), workshopStepOf({ workshops: 1, told: 0 })])
    expect(steps.map((step) => [step.seq, step.kind])).toEqual([
      [1, 'AMEND'],
      [2, 'LOWER_TO_ORDER'],
      [3, 'TELL_WORKSHOP'],
    ])
  })
})

describe('On the floor now and the extra pieces (B-SA-045)', () => {
  it('names where most of the asked pieces are, in the customer’s plain stage words; nothing in work: nothing said', () => {
    expect(floorStageOf({ started: 40, cut: 24, sewn: 0, checked: 0, packed: 0 })).toBe('SEWING')
    expect(floorStageOf({ started: 40, cut: 4, sewn: null, checked: null, packed: null })).toBe('CUTTING')
    expect(floorStageOf({ started: 0, cut: null, sewn: null, checked: null, packed: null })).toBeNull()
    expect(inWorkWords(3, 'SEWING')).toEqual({ en: 'In work now: 3 bundles at Sewing', it: 'In lavorazione ora: 3 fasci a Cucitura' })
    expect(inWorkWords(0, null)).toBeNull()
  })

  it('offers the three outcomes unpicked, each with what it needs: the price grain to charge, the scrap’s own approval', () => {
    const options = outcomeOptionsOf({ customer: 'Brand Alpha', seesPrices: false })
    expect(options.map((option) => [option.outcome, option.needs, option.mayChoose])).toEqual([
      ['CHARGE', 'PRICE_GRAIN', false],
      ['LEFTOVER', null, true],
      ['SCRAP', 'SCRAP_APPROVAL', true],
    ])
    expect(options[1]!.words).toEqual({ en: 'Keep as leftover for Brand Alpha', it: 'Tieni come rimanenza di Brand Alpha' })
    expect(outcomeOptionsOf({ customer: 'Brand Alpha', seesPrices: true })[0]!.mayChoose).toBe(true)
  })
})
