import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import type { AskImpact, AskVerdict, ChangeRequest, ChangeRules } from './api'
import { askBodyOf, askChoicesOf, askHeld, askProblem, EMPTY_ASK, impactHeld, impactViewOf, productionAskRefusal, splitIsWhole, verdictKey } from './ask-model'
import { orderBandOf, type OrderBandFacts } from './band'
import { at, dayAt, orderRecord, orderWords, PREFIX, requestsOf, rulesOf, TODAY } from './design-data'
import { AskDialogBody, type AskDialogModel } from './view/AskDialog'
import { AskImpact as AskImpactView } from './view/AskImpact'

/**
 * F-PR-13 — the portal Ask dialog (production plan §3 "Brand asks, we decide", §5; 06-tree B.2 P-ORD-ask; wall PW-P06): step 1
 * offers change and cancel and only the production asks the customer's limits open ("Urgent – asked" only while its urgency
 * switch is on); a kind whose request waits is withdrawn there or, countered, answered in Waiting for you; step 2 takes the
 * details of a production ask; step 3 says what it means before Send — frozen, the cost (an amount only for a price role,
 * else "A price may apply"), the earliest date, and that after release a size change means cancel and remake. Brand Beta's
 * dialog names only its own order. Made-up data.
 */

const say = (en: string, it = en) => ({ en, it })
const FREE: AskVerdict = { possible: true, code: 'FREE', day: null, words: say('You can ask') }
const FACTS = { mayAsk: true, preview: false, offline: false, busy: false }

function rules(over: Partial<ChangeRules> = {}): ChangeRules {
  const base = rulesOf()
  return {
    ...base,
    lines: base.lines.map((line) => ({ ...line, split: FREE, samples: [{ sampleKind: 'PRE_PRODUCTION' as const, verdict: { possible: false, code: 'CUT' as const, day: dayAt(-3), words: say('Not possible: cutting started') } }, { sampleKind: 'TOP_OF_PRODUCTION' as const, verdict: FREE }] })),
    asks: [
      { kind: 'RUSH', words: say('Urgent – asked'), open: true, verdict: FREE, waitingRequestId: null },
      { kind: 'HOLD', words: say('Pause'), open: true, verdict: { possible: false, code: 'PAUSED', day: null, words: say('The order is paused already') }, waitingRequestId: null },
      { kind: 'RESUME', words: say('Resume'), open: false, verdict: { possible: false, code: 'NOT_OPEN', day: null, words: say('Not open') }, waitingRequestId: null },
      { kind: 'SPLIT_SHIPMENT', words: say('Ship what is ready'), open: true, verdict: FREE, waitingRequestId: null },
      { kind: 'SAMPLE_ROUND', words: say('Another sample'), open: true, verdict: FREE, waitingRequestId: null },
    ],
    ...over,
  }
}

const NO_REQUESTS: ChangeRequest[] = []
const line2 = () => rulesOf().lines[1]!.lineId

describe('step 1: what the customer may ask on this order (F-PR-13)', () => {
  it('change and cancel always, then only the production asks its limits open; a held one says why in our words', () => {
    const choices = askChoicesOf(rules(), NO_REQUESTS)
    expect(choices.map((choice) => choice.kind)).toEqual(['CHANGE', 'CANCEL', 'RUSH', 'HOLD', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'])
    // Resume is closed by the limits: not drawn at all (never "not for you").
    expect(choices.some((choice) => choice.kind === 'RESUME')).toBe(false)
    const hold = choices.find((choice) => choice.kind === 'HOLD')!
    expect(hold).toMatchObject({ possible: false, held: { key: 'ask.verdict.PAUSED' }, waiting: null })
    // Cancel: the whole order is held, a line is still free — it may be asked.
    expect(choices.find((choice) => choice.kind === 'CANCEL')!.possible).toBe(true)
  })

  it('"Urgent – asked" only while the customer’s urgency switch is on (the API opens RUSH exactly then)', () => {
    const off = rules({ asks: rules().asks!.map((ask) => (ask.kind === 'RUSH' ? { ...ask, open: false } : ask)) })
    expect(askChoicesOf(off, NO_REQUESTS).map((choice) => choice.kind)).not.toContain('RUSH')
    // An older answer without production asks: change and cancel only.
    expect(askChoicesOf({ ...rulesOf(), asks: undefined }, NO_REQUESTS).map((choice) => choice.kind)).toEqual(['CHANGE', 'CANCEL'])
  })

  it('a kind whose request waits is not asked twice: withdraw it (OPEN), or answer our counter-offer in Waiting for you (COUNTERED)', () => {
    const waiting: ChangeRequest = { ...requestsOf()[0]!, id: 'b1b1b1b1-0000-4000-8000-000000000901', kind: 'HOLD', status: 'OPEN', askedAt: at(-2), version: 3 }
    const countered: ChangeRequest = { ...requestsOf()[0]!, id: 'b1b1b1b1-0000-4000-8000-000000000902', kind: 'RUSH', status: 'COUNTERED', askedAt: at(-1), version: 2 }
    const read = rules({ asks: rules().asks!.map((ask) => (ask.kind === 'HOLD' ? { ...ask, verdict: { ...ask.verdict, code: 'WAITING' as const }, waitingRequestId: waiting.id } : ask.kind === 'RUSH' ? { ...ask, waitingRequestId: countered.id } : ask)) })
    const choices = askChoicesOf(read, [waiting, countered])
    expect(choices.find((choice) => choice.kind === 'HOLD')).toMatchObject({ possible: false, held: null, waiting: { requestId: waiting.id, status: 'OPEN', version: 3 } })
    expect(choices.find((choice) => choice.kind === 'RUSH')).toMatchObject({ possible: false, waiting: { requestId: countered.id, status: 'COUNTERED' } })
    expect(askHeld('HOLD', read, choices, FACTS)).toBe('ask.held.waiting')
    const html = drawWhat({ rules: read, choices })
    expect(textOf(html)).toContain('Withdraw')
    expect(textOf(html)).toContain('We suggest something else: answer it in Waiting for you')
    expect(html).toContain(`href="${PREFIX}/waiting"`)
  })

  it('held before anything else: a preview, no right to ask, nothing picked; our lock says its own reason (the API’s words)', () => {
    const choices = askChoicesOf(rules(), NO_REQUESTS)
    expect(askHeld('RUSH', rules(), choices, { ...FACTS, preview: true })).toBe('held.preview')
    expect(askHeld('RUSH', rules(), choices, { ...FACTS, mayAsk: false })).toBe('held.mayAsk')
    expect(askHeld(null, rules(), choices, FACTS)).toBe('ask.problem.choose')
    expect(askHeld('HOLD', rules(), choices, FACTS)).toBe('ask.held.closed')
    expect(askHeld('RUSH', rules(), choices, FACTS)).toBeNull()
    expect(verdictKey('RUSH', { code: 'LOCKED', day: null })).toBeNull()
    expect(verdictKey('HOLD', { code: 'READY', day: null })).toEqual({ key: 'ask.verdict.READY_HOLD' })
    expect(verdictKey('SAMPLE_ROUND', { code: 'CUT', day: '2026-11-10' })).toEqual({ key: 'ask.verdict.CUT', params: { day: '2026-11-10' } })
  })
})

describe('step 2: the details, and what Send sends (only its own order’s lines)', () => {
  it('a pause needs their words; a rush date before the promise; a date from today on', () => {
    expect(askProblem('HOLD', rules(), EMPTY_ASK, TODAY)).toBe('ask.problem.holdWhy')
    expect(askProblem('HOLD', rules(), { ...EMPTY_ASK, note: 'Made-up: our shop opens later.' }, TODAY)).toBeNull()
    expect(askProblem('RUSH', rules(), { ...EMPTY_ASK, requestedDate: dayAt(20) }, TODAY)).toBe('ask.problem.rushLater')
    expect(askProblem('RUSH', rules(), { ...EMPTY_ASK, requestedDate: dayAt(-1) }, TODAY)).toBe('ask.problem.past')
    expect(askProblem('RUSH', rules(), EMPTY_ASK, TODAY)).toBeNull()
    expect(askBodyOf('RUSH', rules(), { ...EMPTY_ASK, requestedDate: dayAt(9), note: ' soon ' })).toEqual({ kind: 'RUSH', requestedDate: dayAt(9), note: 'soon' })
    // A pause takes no date even when one was typed for another kind.
    expect(askBodyOf('HOLD', rules(), { ...EMPTY_ASK, requestedDate: dayAt(9), note: 'why' })).toEqual({ kind: 'HOLD', note: 'why' })
  })

  it('ship what is ready: the first part, at most the pieces ordered, never the whole order; a foreign line is never named (PW-P06)', () => {
    const own = { ...EMPTY_ASK, cells: { [line2()]: { '50': 9, '48': 2 }, 'a1a1a1a1-0000-4000-8000-000000000999': { '50': 3 } } }
    expect(askBodyOf('SPLIT_SHIPMENT', rules(), own)).toEqual({ kind: 'SPLIT_SHIPMENT', cells: [{ lineId: line2(), size: '48', quantity: 2 }, { lineId: line2(), size: '50', quantity: 6 }] })
    expect(askProblem('SPLIT_SHIPMENT', rules(), EMPTY_ASK, TODAY)).toBe('ask.problem.splitNothing')
    const everything = Object.fromEntries(rulesOf().lines.map((line) => [line.lineId, Object.fromEntries(line.sizes.map((size) => [size.size, size.quantity]))]))
    expect(splitIsWhole(rules(), { cells: everything })).toBe(true)
    expect(askProblem('SPLIT_SHIPMENT', rules(), { ...EMPTY_ASK, cells: everything }, TODAY)).toBe('ask.problem.splitWhole')
  })

  it('another sample: one of its lines and a kind the rules still allow', () => {
    const first = rulesOf().lines[0]!.lineId
    expect(askProblem('SAMPLE_ROUND', rules(), EMPTY_ASK, TODAY)).toBe('ask.problem.sampleLine')
    expect(askProblem('SAMPLE_ROUND', rules(), { ...EMPTY_ASK, lineId: first }, TODAY)).toBe('ask.problem.sampleKind')
    expect(askProblem('SAMPLE_ROUND', rules(), { ...EMPTY_ASK, lineId: first, sampleKind: 'PRE_PRODUCTION' }, TODAY)).toBe('ask.problem.sampleClosed')
    expect(askBodyOf('SAMPLE_ROUND', rules(), { ...EMPTY_ASK, lineId: first, sampleKind: 'TOP_OF_PRODUCTION' })).toEqual({ kind: 'SAMPLE_ROUND', lineId: first, sampleKind: 'TOP_OF_PRODUCTION' })
    expect(askBodyOf('SAMPLE_ROUND', rules(), { ...EMPTY_ASK, lineId: 'a1a1a1a1-0000-4000-8000-000000000999', sampleKind: 'BRAND' }).lineId).toBeNull()
  })
})

const IMPACT: AskImpact = {
  kind: 'CHANGE',
  frozen: [{ field: 'SIZE_QUANTITY', lineId: 'x', line: '2', size: '52', state: 'CHANGE_REQUEST', words: say('Line 2, size 52: Cutting started — size frozen') }],
  blocked: false,
  priced: true,
  earliest: { date: '2026-12-02', partial: true, meetsWanted: false },
  notes: [],
}
const money = (minor: number) => `EUR ${(minor / 100).toFixed(2)}`

describe('step 3: what it means before Send', () => {
  it('the cost: an amount only for a price role (a cancel’s fee); everyone else reads "A price may apply"; none: "No price applies"', () => {
    const cancel: AskImpact = { kind: 'CANCEL', frozen: [], blocked: false, priced: true, earliest: null, notes: [] }
    expect(impactViewOf('CANCEL', cancel, { seesPrices: true, fee: 29550, money, sizesAsked: false }).cost).toEqual({ key: 'ask.impact.fee', params: { fee: 'EUR 295.50' } })
    expect(impactViewOf('CANCEL', cancel, { seesPrices: false, fee: null, money, sizesAsked: false }).cost).toEqual({ key: 'ask.impact.mayApply' })
    expect(impactViewOf('CANCEL', { ...cancel, priced: false }, { seesPrices: true, fee: null, money, sizesAsked: false }).cost).toEqual({ key: 'ask.impact.noPrice' })
  })

  it('frozen in the API’s words, the earliest date (a date only), and after release a size change means cancel and remake', () => {
    const view = impactViewOf('CHANGE', IMPACT, { seesPrices: false, fee: null, money, sizesAsked: true })
    expect(view).toMatchObject({ headline: { key: 'ask.impact.frozen', tone: 'warning' }, earliest: { key: 'ask.impact.earliestLater', date: '2026-12-02', partial: true }, afterRelease: true, blocked: false })
    expect(impactViewOf('CHANGE', IMPACT, { seesPrices: false, fee: null, money, sizesAsked: false }).afterRelease).toBe(false)
    expect(impactViewOf('HOLD', { ...IMPACT, kind: 'HOLD', frozen: [], priced: false, earliest: null, notes: [say('A pause may move your date')] }, { seesPrices: false, fee: null, money, sizesAsked: false })).toMatchObject({ headline: { key: 'ask.impact.nothingFrozen' }, notes: ['ask.impact.note.HOLD'], earliest: null })
    const blocked = impactViewOf('CHANGE', { ...IMPACT, blocked: true, frozen: [{ ...IMPACT.frozen[0]!, state: 'BLOCKED' }] }, { seesPrices: false, fee: null, money, sizesAsked: true })
    expect(impactHeld({ state: 'ready', view: blocked })).toBe('ask.impact.blockedHeld')
    expect(impactHeld({ state: 'loading', view: null })).toBe('ask.impact.reading')
    expect(impactHeld(null)).toBeNull()
    const text = textOf(render(createElement(AskImpactView, { model: { state: 'ready', view } })))
    for (const words of ['What it means', 'Line 2, size 52: Cutting started — size frozen', 'A price may apply: we will tell you.', 'From about', 'Some lines are not dated yet', 'we cancel that line and make it again']) expect(text).toContain(words)
    expect(text).not.toMatch(/EUR|€/)
  })

  it('a refusal at the click in our words, the rules read again', () => {
    expect(productionAskRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/PAUSED' }]))).toEqual({ key: 'ask.verdict.PAUSED', reread: true })
    expect(productionAskRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/cells/0/CUT' }]))).toEqual({ key: 'ask.verdict.CUT_NO_DAY', reread: true })
    expect(productionAskRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/SIZE_QUANTITY' }]))).toEqual({ key: 'ask.impact.blockedHeld', reread: true })
    expect(productionAskRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/OPEN_REQUEST' }])).key).toBe('problem.verdict.OPEN_REQUEST')
  })
})

function drawWhat(over: Partial<AskDialogModel> = {}, locale: 'en' | 'it' = 'en') {
  const read = over.rules ?? rules()
  const choices = over.choices ?? askChoicesOf(read, NO_REQUESTS)
  const model: AskDialogModel = { state: 'ready', number: 'Your order 4', rules: read, step: 'what', kind: null, choices, draft: EMPTY_ASK, held: null, impact: null, busy: false, problem: null, waitingHref: `${PREFIX}/waiting`, withdrawHeld: null, withdrawing: null, today: TODAY, ...over }
  return render(createElement(AskDialogBody, { model }), locale)
}

describe('the dialog’s words and the wall (PW-P06)', () => {
  it('step 1 names each kind in plain words; a colour change goes to the order’s conversation', () => {
    const text = textOf(drawWhat())
    for (const words of ['Change sizes, quantities, the date or the delivery address', 'Cancel the order or some lines', 'Make it urgent (Urgent – asked)', 'Pause the work', 'Ship what is ready first', 'Another sample', 'The order is paused already', 'A colour change: write to us']) expect(text).toContain(words)
    expect(text).not.toContain('Resume the work')
  })

  it('Brand Beta’s dialog holds nothing of Brand Alpha: its own order, its own lines, our words only', () => {
    const base = rules()
    const beta: ChangeRules = {
      ...base,
      order: { ...base.order, number: BRAND_BETA.numbers.order, customerRef: BRAND_BETA.customerRef },
      lines: base.lines.map((line) => ({ ...line, style: { code: BRAND_BETA.numbers.style, name: 'Beta jacket' }, colourway: { code: 'BK', name: 'Black' } })),
      addresses: [{ id: 'b2b2b2b2-0000-4000-8000-000000000301', label: `${BRAND_BETA.legalName} — ${BRAND_BETA.address.line1}, ${BRAND_BETA.address.city}` }],
    }
    for (const step of ['what', 'details'] as const) {
      for (const locale of ['en', 'it'] as const) {
        const html = drawWhat({ rules: beta, choices: askChoicesOf(beta, NO_REQUESTS), step, kind: step === 'details' ? 'SPLIT_SHIPMENT' : null }, locale)
        expect(scanText(html, BRAND_ALPHA), `${step} ${locale}`).toEqual([])
      }
    }
  })

  it('every word in both languages, and the Italian speaks to the customer as "voi"', () => {
    const flat = (locale: 'en' | 'it') => Object.entries(CATALOGUE[locale]['portal-orders'] ?? {}).filter(([key]) => key.startsWith('ask.') || key === 'band.ask')
    const en = flat('en')
    const it = flat('it')
    expect(en.length).toBeGreaterThan(80)
    expect(it.map(([key]) => key).sort()).toEqual(en.map(([key]) => key).sort())
    for (const [key, text] of it) expect(text, key).not.toMatch(/\b(tu|tuo|tua|tuoi|tue|ti|hai|puoi|vuoi|scegli|scrivici|chiedici)\b/i)
  })

  it('the band: "Ask us…" opens the dialog; "Ask for a change" stays in the ⋯; without the dialog the band is as before', () => {
    const facts: OrderBandFacts = { changeHeld: null, cancelHeld: null, reconfirm: null, shipments: 1, moves: 0, confirmation: true, pay: null }
    const record = orderRecord({ status: 'IN_PRODUCTION' })
    const words = orderWords('en')
    const withAsk = orderBandOf({ words, record, tab: 'status', prefix: PREFIX, facts: { ...facts, ask: { held: null } } })
    expect(withAsk.actions?.map((action) => [action.id, action.label])).toEqual([['ask', 'Ask us…']])
    expect(withAsk.more?.[0]).toMatchObject({ id: 'change', label: words.t('band.change') })
    expect(orderBandOf({ words, record, tab: 'status', prefix: PREFIX, facts }).actions?.map((action) => action.id)).toEqual(['change'])
  })
})
