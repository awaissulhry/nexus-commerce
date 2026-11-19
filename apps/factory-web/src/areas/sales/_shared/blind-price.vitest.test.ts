import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { BLIND_PRICE_KEY, isBlindPriceRefusal } from './blind-price'
import { writeProblem } from '../quotes/problems'
import { emptyDraft, linesBlindHeld, type LineDraft } from '../settings/templates/model'
import { designScreen as templatesScreen } from '../settings/templates/fixtures'
import { saveHeld, saveProblemOf, type SaveState } from '../quotes/record/configurator/model'
import { designScreen as configuratorScreen } from '../quotes/record/configurator/fixtures'
import { acceptsBlindPrice, answerHeld, answerProblem, batchLinesOf, refusalKeyOf } from '../../home/approvals/requests/model'
import { REQUEST_FIXTURES } from '../../home/approvals/requests/fixtures'
import { designScreen as approvalsScreen } from '../../home/approvals/fixtures'
import { creditsBlind, decisionDraftProblems, refusalOf } from '../returns/model'
import { RMA_RECEIVED } from '../returns/demo/fixtures'
import { designScreen as returnsRecordScreen } from '../returns/record/fixtures'

/**
 * F-CP-160 (customer page lane, the money wall; Owner answer A, the API's B-CP-026) — the four acts that change a price their maker
 * cannot see are held for a reader without the price grain, in the API's words, never hidden and never a blank:
 *   1. a quote template's line replace (held after the API's first refusal while the lines differ; the lines go before the header)
 *   2. a line's options save that moves what they add (held for the draft the API refused)
 *   3. accepting a request whose agreed counter-offer carries a fee (held before the click: `counter.priced`)
 *   4. deciding a return line's credit (a credit-only line, held before the click)
 * As a Sales worker each is held in words; as a price holder (the Owner) nothing is held. Run at the end only (Owner rule).
 */

// The DS windows open only in a browser (after hydration, in a portal): here they draw in place.
vi.mock('@nexus/ui/patterns', async (original) => {
  const actual = await original<typeof import('@nexus/ui/patterns')>()
  const DetailModal = ({ open, title, actions, error, children }: { open: boolean; title?: unknown; actions?: unknown; error?: unknown; children?: unknown }) =>
    open ? createElement('section', { role: 'dialog', 'data-window': '' }, createElement('h2', null, title as never), error ? createElement('p', null, error as never) : null, children as never, createElement('footer', null, actions as never)) : null
  return { ...actual, DetailModal }
})
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

/** The API's words (factory-domain sales/blind-price BLIND_PRICE_WORDS, B-CP-026). */
const API_WORDS = { it: 'Cambia un prezzo che non vedi: lo fa chi vede i prezzi.', en: 'It changes a price you cannot see: someone who sees prices does it.' } as const
const LOCALES = ['it', 'en'] as const
const blind = () => new ApiError('forbidden', 403, 'forbidden', API_WORDS.en, null, [{ path: 'refusal/BLIND_PRICE', message: API_WORDS.en }, { path: 'body/picks', message: API_WORDS.en }])
const forbidden = () => new ApiError('forbidden', 403, 'forbidden', 'Forbidden.')
const draw = (screen: { view: unknown; cases: readonly { id: string; model: unknown }[] }, id: string, locale: (typeof LOCALES)[number] = 'en') => {
  const found = screen.cases.find((entry) => entry.id === id)
  if (!found) throw new Error(`no case ${id}`)
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: found.model })))
}
const AMOUNT = /€\s?\d|\d+[.,]\d{2}\s?€|\bEUR\s?\d/

describe('F-CP-160: the API’s refusal and its words', () => {
  it('knows the money wall’s refusal (403 refusal/BLIND_PRICE) and nothing else', () => {
    expect(isBlindPriceRefusal(blind())).toBe(true)
    expect(isBlindPriceRefusal(new ApiError('forbidden', 403, 'forbidden', 'x', null, [{ path: ['refusal', 'BLIND_PRICE'] }]))).toBe(true)
    expect(isBlindPriceRefusal(forbidden())).toBe(false)
    expect(isBlindPriceRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/BLIND_PRICE' }]))).toBe(false)
    expect(isBlindPriceRefusal(new Error('x'))).toBe(false)
  })

  it('the four screens say the API’s words, the same in each catalogue, in Italian (tu) and English', () => {
    for (const locale of LOCALES) {
      for (const ns of ['sales', 'sales-configurator', 'approvals', 'sales-returns']) {
        expect(createTranslator(locale, CATALOGUE[locale][ns] ?? {})(BLIND_PRICE_KEY), `${ns} ${locale}`).toBe(API_WORDS[locale])
      }
    }
  })
})

describe('F-CP-160 · 1. a quote template’s line replace', () => {
  const line = (key: string): LineDraft => ({ key, section: '', styleId: `s-${key}`, styleCode: 'DEMO-JKT-01', styleName: 'Demo jacket', colourwayId: '', colourwayCode: '', sizes: {}, unitPrice: '' })
  const before = { ...emptyDraft(''), name: 'Demo', lines: [line('a'), line('b')] }
  const fewer = { ...before, lines: [line('a')] }

  it('holds Save for a reader without prices once the API said a line holds one, while the lines differ; never for a price holder', () => {
    expect(linesBlindHeld({ grains: { price: false }, before, draft: fewer })).toBeNull()
    expect(linesBlindHeld({ grains: { price: false }, linesHeld: true, before, draft: fewer })).toBe(BLIND_PRICE_KEY)
    expect(linesBlindHeld({ grains: { price: false }, linesHeld: true, before, draft: { ...before, name: 'Demo B' } })).toBeNull()
    expect(linesBlindHeld({ grains: { price: true }, linesHeld: true, before, draft: fewer })).toBeNull()
  })

  it('says the refusal in the sales catalogue’s words and reads nothing again (nothing changed)', () => {
    expect(writeProblem(blind())).toEqual({ key: BLIND_PRICE_KEY, reload: false })
    expect(writeProblem(forbidden())).toEqual({ key: 'problem.write.forbidden', reload: false })
  })

  it('the design cases as a Sales worker: no price on screen, Save held in words after the refusal, the header alone saves', () => {
    for (const locale of LOCALES) {
      const html = draw(templatesScreen, 'dialog-sales-blind', locale)
      expect(html, locale).toContain(API_WORDS[locale].replace(/'/g, '&#x27;'))
      expect(html).not.toMatch(AMOUNT)
    }
    expect(draw(templatesScreen, 'dialog-sales-lines')).not.toContain(API_WORDS.en)
    expect(draw(templatesScreen, 'dialog-sales-header')).not.toContain(API_WORDS.en)
  })
})

describe('F-CP-160 · 2. a line’s options save', () => {
  const state = (over: Partial<SaveState> = {}): SaveState => ({ held: null, changed: true, checking: false, preview: { ok: true, blocks: [], warnings: [], outsideCertificate: false, certificateNotes: [], chosen: [], pricing: { repriced: true, held: null, manualKept: false }, problem: null }, saving: false, offline: false, keepPrice: false, kind: 'QUOTE', ...over })

  it('holds Save in the money wall’s words for the draft the API refused; another choice, or no change, as before', () => {
    expect(saveHeld(state({ blind: true }), [], [])).toEqual({ key: BLIND_PRICE_KEY })
    expect(saveHeld(state({ blind: true, kind: 'ORDER' }), [], [])).toEqual({ key: BLIND_PRICE_KEY })
    expect(saveHeld(state(), [], [])).toBeNull()
    expect(saveHeld(state({ blind: true, changed: false }), [], [])).toEqual({ key: 'save.held.unchanged' })
  })

  it('reads the refusal: the money wall (the picks stay, no read again), stale (read again), a missing right', () => {
    expect(saveProblemOf(blind())).toEqual({ words: { key: BLIND_PRICE_KEY }, stale: false, blind: true })
    expect(saveProblemOf(new ApiError('conflict', 409, 'version_conflict', 'x'))).toMatchObject({ words: { key: 'problem.stale' }, stale: true, blind: false })
    expect(saveProblemOf(forbidden())).toEqual({ words: { key: 'problem.forbidden' }, stale: false, blind: false })
  })

  it('the design cases as a Sales worker (quote and order line): held in words, no surcharge, price or margin', () => {
    for (const id of ['quote-sales-blind', 'order-sales-blind']) {
      for (const locale of LOCALES) {
        const html = draw(configuratorScreen, id, locale)
        expect(html, `${id} ${locale}`).toContain(API_WORDS[locale])
        expect(html).not.toMatch(/\+\s?\d+[.,]\d{2}|\+\s?\d+\s?%/)
        expect(html).not.toMatch(AMOUNT)
      }
    }
  })
})

describe('F-CP-160 · 3. accepting a priced counter-offer', () => {
  const { AGREED, RUSH, BATCH_ROWS } = REQUEST_FIXTURES
  const PRICED = { ...AGREED, counter: { ...AGREED.counter!, priced: true } }
  const free = (price: boolean) => ({ offline: false, busy: false, price })

  it('holds Accept for a reader without prices when the agreed counter-offer carries a fee; a date-only counter, or a price holder, as before', () => {
    expect(acceptsBlindPrice(PRICED, false)).toBe(true)
    expect(acceptsBlindPrice(PRICED, true)).toBe(false)
    expect(acceptsBlindPrice(AGREED, false)).toBe(false)
    expect(acceptsBlindPrice({ ...PRICED, status: 'OPEN' }, false)).toBe(false)
    expect(answerHeld(PRICED, 'accept', free(false), '')).toBe(BLIND_PRICE_KEY)
    expect(answerHeld(PRICED, 'accept', free(true), '')).toBeNull()
    expect(answerHeld(AGREED, 'accept', free(false), '')).toBeNull()
    // the other answers keep their own reasons (an agreed counter is only accepted)
    expect(answerHeld(PRICED, 'refuse', free(false), 'x')).toBe('customerRequest.held.counterAgreed')
    expect(answerHeld(RUSH, 'accept', free(false), '')).toBeNull()
  })

  it('Accept all leaves a priced counter-offer out with the words; the refusal (also of a batch item) in the same words', () => {
    const rows = [...BATCH_ROWS.slice(0, 2), { ...PRICED, id: 'priced-row', batchId: BATCH_ROWS[0]!.batchId }]
    expect(batchLinesOf(rows, 'accept', false).find((entry) => entry.requestId === 'priced-row')?.leftOut).toBe(BLIND_PRICE_KEY)
    expect(batchLinesOf(rows, 'accept', true).find((entry) => entry.requestId === 'priced-row')?.leftOut).toBeNull()
    expect(refusalKeyOf('BLIND_PRICE')).toBe(BLIND_PRICE_KEY)
    expect(answerProblem(new ApiError('forbidden', 403, 'forbidden', 'x', null, [{ path: 'refusal/BLIND_PRICE' }, { path: 'request/counterFee' }])).key).toBe(BLIND_PRICE_KEY)
  })

  it('the design cases: as a Sales worker the window and Accept say the words, no amount; as the Owner, or a date-only counter, nothing held', () => {
    for (const locale of LOCALES) expect(draw(approvalsScreen, 'cp160-priced-agreed-sales', locale), locale).toContain(API_WORDS[locale])
    // the counter-offer as this reader reads it: `priced`, never its fee (the API drops it without the grain)
    const sales = approvalsScreen.cases.find((entry) => entry.id === 'cp160-priced-agreed-sales')!.model as unknown as { depth: { grains: { price: boolean }; requestReview: { record: { value: { request: { counter: Record<string, unknown> } } } } } }
    expect(sales.depth.grains.price).toBe(false)
    expect(sales.depth.requestReview.record.value.request.counter).toMatchObject({ priced: true })
    expect('fee' in sales.depth.requestReview.record.value.request.counter).toBe(false)
    expect(draw(approvalsScreen, 'cp160-priced-agreed-owner')).not.toContain(API_WORDS.en)
    expect(draw(approvalsScreen, 'cp160-agreed-date-sales')).not.toContain(API_WORDS.en)
  })
})

describe('F-CP-160 · 4. deciding a return’s credit', () => {
  const line = { ...RMA_RECEIVED.lines[1]!, grade: 'LIKE_NEW' as const, disposition: null }
  const drafts = (disposition: 'CREDIT_ONLY' | 'REPLACE' | 'REPAIR') => ({ [line.id]: { disposition, outcome: 'RESTOCK' as const, credit: '' } })

  it('a credit-only line is a price holder’s decision; the others are decided as before', () => {
    expect(creditsBlind({ disposition: 'CREDIT_ONLY' }, false)).toBe(true)
    expect(creditsBlind({ disposition: 'CREDIT_ONLY' }, true)).toBe(false)
    expect(creditsBlind({ disposition: 'REPLACE' }, false)).toBe(false)
    expect(decisionDraftProblems(drafts('CREDIT_ONLY'), [line], false)).toContainEqual({ key: BLIND_PRICE_KEY })
    expect(decisionDraftProblems(drafts('CREDIT_ONLY'), [line], true)).not.toContainEqual({ key: BLIND_PRICE_KEY })
    expect(decisionDraftProblems(drafts('REPLACE'), [line], false)).toEqual([])
    expect(decisionDraftProblems(drafts('REPAIR'), [line], false)).toEqual([])
  })

  it('says the refusal in the returns’ words', () => {
    expect(refusalOf(blind())).toEqual({ key: BLIND_PRICE_KEY })
  })

  it('the design cases as a Sales worker: Decide held and the line says why, no amount; a replacement decided as before', () => {
    for (const locale of LOCALES) {
      const html = draw(returnsRecordScreen, 'rma-deciding-sales', locale)
      expect(html, locale).toContain(API_WORDS[locale].replace(/'/g, '&#x27;'))
      expect(html).not.toMatch(AMOUNT)
    }
    expect(draw(returnsRecordScreen, 'rma-deciding-sales-repair')).not.toContain(API_WORDS.en)
  })
})
