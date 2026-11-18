import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import type { AskImpact, AskVerdict, ChangeRequest, ChangeRules } from './api'
import { askBodyOf, askChoicesOf, askHeld, askProblem, EMPTY_ASK, impactHeld, impactViewOf, productionAskRefusal, splitIsWhole, verdictKey, type AskDraft } from './ask-model'
import { orderBandOf, type OrderBandFacts } from './band'
import { at, dayAt, orderRecord, orderWords, PREFIX, requestsOf, rulesOf, TODAY } from './design-data'
import { AskDialogBody, type AskDialogModel } from './view/AskDialog'
import { AskImpact as AskImpactView } from './view/AskImpact'
// F-SA-246: the design change (its model, files, doors and the request card's kinds).
import { ORDER_REQUEST_KINDS } from '@nexus/factory-domain/sales/change-requests/rules'
import { REQUEST_KINDS as CARD_KINDS } from '../../../lib/production/model'
import type { HeldFile } from '../../../lib/request-compose/files'
import type { ComposeFilesModel } from '../../../lib/request-compose/view/ComposeFiles'
import { PortalRecordFrame } from '../../shell/record/PortalRecordFrame'
import type { PortalOrderFiles } from './api'
import { availableIdsOf, cleanedUploads, designAskRefusal, designBodyOf, designFilesOf, designProblem, MAX_DESIGN_FILES, scanningUploadsOf, sentUploadsOf, takesSteps, uploadFailureOf } from './ask-model'
import type { DesignAskModel } from './view/AskDialog'
// B-SA-046b: which pieces a design change is for.
import { appliesToOf, APPLIES_TO_CHOICES } from './ask-model'
import { askImpactSchema, changeRequestSchema } from './api'

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
    const cells: AskDraft['cells'] = { [line2()]: { '50': 9, '48': 2 }, 'a1a1a1a1-0000-4000-8000-000000000999': { '50': 3 } }
    const own = { ...EMPTY_ASK, cells }
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
    // F-PR-23b: the change asks a colour too (B-PR-27a); without another colourway of the style it is still written to us.
    for (const words of ['Change sizes, quantities, a colour, the date or the delivery address', 'Cancel the order or some lines', 'Make it urgent (Urgent – asked)', 'Pause the work', 'Ship what is ready first', 'Another sample', 'The order is paused already', 'A colour change: write to us']) expect(text).toContain(words)
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

// ── F-SA-246 (sales page plan R6, R3, P21; 14-change-flow §2.4; review OW-8, C-10): the design change, asked from the portal ──

const OPEN_DESIGN = { words: say('Design change', 'Modifica del design'), open: true, verdict: FREE, waitingRequestId: null }
const designRules = (over: Partial<NonNullable<ChangeRules['design']>> = {}): ChangeRules => rules({ design: { ...OPEN_DESIGN, ...over } })
const lineOne = () => rulesOf().lines[0]!.lineId
const held = (over: Partial<HeldFile>): HeldFile => ({ key: 'k1', name: 'sketch.pdf', sizeBytes: 1200, contentType: 'application/pdf', kind: 'DOCUMENT', sheet: false, design: false, problem: null, state: 'held', ...over })
const uploadModel = (files: HeldFile[] = [], over: Partial<ComposeFilesModel> = {}): ComposeFilesModel => ({ open: true, closedWords: null, held: files, leftOut: 0, when: 'send', readOnly: false, heldReason: null, ...over })
const designModel = (over: Partial<DesignAskModel> = {}): DesignAskModel => ({ orderFiles: { state: 'ready', files: [{ id: 'f-order', name: 'artwork-v2.pdf', sizeBytes: 4000, line: null }, { id: 'f-line', name: 'collar.png', sizeBytes: 900, line: 1 }] }, upload: uploadModel(), uploaded: [], scanning: 0, ...over })
const fileOf = (id: string, type: string, over: Partial<PortalOrderFiles['groups'][number]['files'][number]> = {}): PortalOrderFiles['groups'][number]['files'][number] => ({
  id,
  name: `${id}.pdf`,
  kind: 'DOCUMENT',
  category: null,
  documentKind: null,
  documentWords: null,
  contentType: 'application/pdf',
  sizeBytes: 100,
  versionNo: 1,
  at: at(-1),
  from: { type, id: type === 'SalesOrder' ? rulesOf().order.id : 'x', label: 'Your order 4' },
  line: type === 'SalesOrderLine' ? { id: 'x', seq: 2 } : null,
  ...over,
})
const ORDER_FILES: Pick<PortalOrderFiles, 'groups'> = {
  groups: [
    { key: 'ORDER', words: say('Order'), files: [fileOf('f-order', 'SalesOrder'), fileOf('f-library', 'SalesOrder', { documentKind: 'DECLARATION_OF_CONFORMITY', documentWords: say('Declaration') })] },
    { key: 'LINES', words: say('Lines'), files: [fileOf('f-line', 'SalesOrderLine')] },
    { key: 'REQUESTS', words: say('Requests'), files: [fileOf('f-request', 'OrderChangeRequest'), fileOf('f-order', 'SalesOrder')] },
  ],
}

describe('F-SA-246: step 1 — the design change is offered only where the customer’s settings open it', () => {
  it('after change and cancel, only while design.open; closed: not drawn at all (never "not for you")', () => {
    expect(askChoicesOf(designRules(), NO_REQUESTS).map((choice) => choice.kind)).toEqual(['CHANGE', 'CANCEL', 'DESIGN', 'RUSH', 'HOLD', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'])
    expect(askChoicesOf(designRules({ open: false }), NO_REQUESTS).map((choice) => choice.kind)).not.toContain('DESIGN')
    // An older answer without the design part: as before.
    expect(askChoicesOf(rules(), NO_REQUESTS).map((choice) => choice.kind)).not.toContain('DESIGN')
    expect(takesSteps('DESIGN')).toBe(true)
    expect(takesSteps('CHANGE')).toBe(false)
  })

  it('one waits per order: withdrawn here; a design change waiting never holds a change or a cancel', () => {
    const waiting: ChangeRequest = { ...requestsOf()[0]!, id: 'b1b1b1b1-0000-4000-8000-000000000911', kind: 'DESIGN', status: 'OPEN', askedAt: at(-1), version: 2 }
    const read = designRules({ verdict: { possible: false, code: 'WAITING', day: dayAt(-1), words: say('Your request waits for our answer') }, waitingRequestId: waiting.id })
    const choices = askChoicesOf(read, [waiting])
    expect(choices.find((choice) => choice.kind === 'DESIGN')).toMatchObject({ possible: false, held: null, waiting: { requestId: waiting.id, status: 'OPEN', version: 2 } })
    expect(choices.find((choice) => choice.kind === 'CHANGE')!.possible).toBe(true)
    expect(askHeld('DESIGN', read, choices, FACTS)).toBe('ask.held.waiting')
    expect(textOf(drawWhat({ rules: read, choices }))).toContain('Design change')
  })
})

describe('F-SA-246: step 2 — the lines, what to change (required), up to ten files', () => {
  it('held in order: a line, their words, at most 4000 characters, at most 10 files, nothing still uploading', () => {
    const read = designRules()
    const draft = { ...EMPTY_ASK }
    const none = { uploaded: [] as string[], uploading: false }
    expect(designProblem(read, draft, none)).toBe('ask.design.problem.lines')
    expect(designProblem(read, { ...draft, lineIds: [lineOne()], note: '   ' }, none)).toBe('ask.design.problem.words')
    expect(designProblem(read, { ...draft, lineIds: [lineOne()], note: 'x'.repeat(4001) }, none)).toBe('ask.design.problem.long')
    const eleven = Array.from({ length: MAX_DESIGN_FILES + 1 }, (_, index) => `f-${index}`)
    expect(MAX_DESIGN_FILES).toBe(10)
    expect(designProblem(read, { ...draft, lineIds: [lineOne()], note: 'A shorter collar', fileIds: eleven.slice(0, 6) }, { uploaded: eleven.slice(6), uploading: false })).toBe('ask.design.problem.files')
    expect(designProblem(read, { ...draft, lineIds: [lineOne()], note: 'A shorter collar' }, { uploaded: [], uploading: true })).toBe('ask.design.problem.uploading')
    expect(designProblem(read, { ...draft, lineIds: [lineOne()], note: 'A shorter collar', fileIds: ['f-order'] }, { uploaded: ['u1'], uploading: false })).toBeNull()
  })

  it('what Send sends: only the order’s own lines, their words trimmed, each file once — a foreign line is never named (PW-P06)', () => {
    const body = designBodyOf(designRules(), { lineIds: ['a1a1a1a1-0000-4000-8000-000000000999', line2(), lineOne()], note: '  A shorter collar  ', fileIds: ['f-order', 'u1'] }, ['u1', 'u2'])
    expect(body).toEqual({ kind: 'DESIGN', lineIds: [lineOne(), line2()], note: 'A shorter collar', fileIds: ['f-order', 'u1', 'u2'] })
    expect(designBodyOf(designRules(), { lineIds: [lineOne()], note: 'x', fileIds: [] }, [])).toEqual({ kind: 'DESIGN', lineIds: [lineOne()], note: 'x' })
  })

  it('the files already on the order it may name: the order’s own and its lines’, never a library document or another request’s file', () => {
    expect(designFilesOf(ORDER_FILES).map((file) => file.id)).toEqual(['f-order', 'f-line'])
    expect(designFilesOf(ORDER_FILES).find((file) => file.id === 'f-line')).toMatchObject({ line: 2 })
    expect(designFilesOf(ORDER_FILES, new Set(['f-order'])).map((file) => file.id)).toEqual(['f-line'])
    expect(designFilesOf(null)).toEqual([])
  })

  it('a file of ours held for the virus scan goes once the order’s list holds it; until then it stays on the order and is left out', () => {
    const files = [held({ key: 'a', state: 'sent', fileId: 'u1' }), held({ key: 'b', state: 'scanning', fileId: 'f-order' }), held({ key: 'c', state: 'scanning', fileId: 'u3' }), held({ key: 'd', state: 'failed', failure: 'x' })]
    expect(sentUploadsOf(files)).toEqual(['u1'])
    expect(scanningUploadsOf(files)).toBe(2)
    const after = cleanedUploads(files, availableIdsOf(ORDER_FILES))
    expect(sentUploadsOf(after)).toEqual(['u1', 'f-order'])
    expect(scanningUploadsOf(after)).toBe(1)
  })

  it('closed uploads say so in the API’s own sentence; a refusal at refusal/<CODE> in its words; else ours', () => {
    const words = { network: 'the connection dropped', store: 'the file store did not take it', refused: 'it was refused as it is' }
    const closed = 'Uploads from outside are closed for now: the virus scanner is not running here yet. Please send the file to your contact by e-mail.'
    expect(uploadFailureOf(new ApiError('unavailable', 503, 'not_ready', closed), words)).toBe(closed)
    expect(uploadFailureOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/TOO_MANY_FILES', message: 'This already holds 50 of your files.' }]), words)).toBe('This already holds 50 of your files.')
    expect(uploadFailureOf(new ApiError('unavailable', 0, 'network', 'The factory API could not be reached.'), words)).toBe(words.network)
    const store = new Error('The file store answered 500.')
    store.name = 'StoreError'
    expect(uploadFailureOf(store, words)).toBe(words.store)
    // The file's row says it, with Retry.
    const html = drawWhat({ rules: designRules(), step: 'details', kind: 'DESIGN', draft: { ...EMPTY_ASK, lineIds: [lineOne()] }, design: designModel({ upload: uploadModel([held({ state: 'failed', failure: closed })]) }) })
    expect(textOf(html)).toContain(`Did not go: ${closed}`)
    expect(textOf(html)).toContain('Retry the file')
  })

  it('the details draw the lines, “What to change”, the files and “Files are checked before we open them.”; a person who may not write here is held with why', () => {
    const text = textOf(drawWhat({ rules: designRules(), step: 'details', kind: 'DESIGN', draft: { ...EMPTY_ASK, lineIds: [lineOne()] }, design: designModel() }))
    for (const words of ['Pick the lines, say what to change', 'What to change', 'Files are checked before we open them.', 'Up to 10 files', 'Files already on the order', 'artwork-v2.pdf', 'collar.png', 'On line 1', 'On the order', '30 pieces ordered']) expect(text).toContain(words)
    const heldText = textOf(drawWhat({ rules: designRules(), step: 'details', kind: 'DESIGN', draft: EMPTY_ASK, design: designModel({ upload: uploadModel([], { readOnly: true, heldReason: 'Sending files needs the right to write in the conversation: ask your admin.' }) }) }))
    expect(heldText).toContain('Sending files needs the right to write in the conversation')
  })
})

describe('F-SA-246: step 3 — what it means, never a guessed date', () => {
  const DESIGN_IMPACT: AskImpact = { kind: 'DESIGN', frozen: [], blocked: false, priced: true, earliest: { date: '2026-12-02', partial: false, meetsWanted: null }, notes: [say('Cutting has started on line 1: the change may cost extra or apply to the next order'), say('Line 2 is not in production yet')] }

  it('cut already: "Frozen since cutting: a design change is priced"; each line’s stage in the API’s words; the date with our answer only', () => {
    const view = impactViewOf('DESIGN', DESIGN_IMPACT, { seesPrices: false, fee: null, money, sizesAsked: false })
    expect(view).toMatchObject({ headline: { key: 'ask.design.impact.priced', tone: 'warning' }, cost: { key: 'ask.impact.mayApply' }, earliest: { key: 'ask.design.impact.date', date: null }, blocked: false, afterRelease: false })
    expect(view.lines).toHaveLength(2)
    expect(impactViewOf('DESIGN', { ...DESIGN_IMPACT, priced: false }, { seesPrices: false, fee: null, money, sizesAsked: false }).headline.key).toBe('ask.design.impact.notCut')
    const text = textOf(render(createElement(AskImpactView, { model: { state: 'ready', view } })))
    for (const words of ['Frozen since cutting: a design change is priced.', 'We tell you the date with our answer.', 'Cutting has started on line 1', 'Line 2 is not in production yet']) expect(text).toContain(words)
    // Never a guessed date (the impact's estimate is not drawn).
    expect(text).not.toContain('From about')
  })

  it('the review says what is asked, the files counted, and the uploads still being checked', () => {
    const impact = { state: 'ready' as const, view: impactViewOf('DESIGN', DESIGN_IMPACT, { seesPrices: false, fee: null, money, sizesAsked: false }) }
    const text = textOf(drawWhat({ rules: designRules(), step: 'impact', kind: 'DESIGN', draft: { ...EMPTY_ASK, lineIds: [lineOne()], note: 'A shorter collar', fileIds: ['f-order'] }, impact, design: designModel({ uploaded: ['u1'], scanning: 1 }) }))
    for (const words of ['Design change', 'A shorter collar', '2 files', '1 file is still being checked', 'What it means']) expect(text).toContain(words)
  })

  it('a refusal at Send in neutral words: a file not the order’s own reads again the order’s files; a closed ask reads the rules again', () => {
    expect(designAskRefusal(new ApiError('not_found', 404, 'not_found', 'File not found.', null, [{ path: 'body/fileIds/1', message: 'File not found.' }]))).toEqual({ key: 'ask.design.problem.fileGone', reread: false, files: true })
    expect(designAskRefusal(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/fileIds', message: 'At most 10 files.' }])).key).toBe('ask.design.problem.files')
    expect(designAskRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/NOT_OPEN' }]))).toEqual({ key: 'ask.verdict.NOT_OPEN', reread: true, files: false })
    expect(designAskRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/lineIds/0/CLOSED_SHORT' }])).key).toBe('ask.verdict.CLOSED_SHORT')
  })
})

describe('F-SA-246: the doors, the request card and the words', () => {
  it('"Ask for a change" above the order’s conversation (the frame; PartnerThread untouched), held with why', () => {
    const draw = (held: string | null) => render(createElement(PortalRecordFrame, { thread: createElement('p', null, 'the conversation'), threadLabel: 'Messages: Your order 4', design: { mode: 'docked' }, door: { label: 'Ask for a change', held, onOpen: () => undefined }, children: createElement('div', null, 'body') }))
    const html = draw(null)
    expect(textOf(html)).toContain('Ask for a change')
    expect(html.indexOf('Ask for a change')).toBeLessThan(html.indexOf('the conversation'))
    expect(textOf(draw('You are looking at a preview.'))).toContain('Ask for a change')
    expect(render(createElement(PortalRecordFrame, { thread: createElement('p', null, 'x'), threadLabel: 'Messages', design: { mode: 'docked' }, children: createElement('div', null, 'body') }))).not.toContain('Ask for a change')
  })

  it('the request card knows the design change (the domain’s kinds, its word in both languages)', () => {
    expect([...CARD_KINDS].sort()).toEqual([...ORDER_REQUEST_KINDS].sort())
    for (const locale of ['en', 'it'] as const) expect(CATALOGUE[locale]['production']?.['parts.request.kind.DESIGN'], locale).toBeTruthy()
  })

  it('every new word in both languages with the same placeholders; the portal speaks "voi"; the limits card names the design change', () => {
    const keys = Object.keys(CATALOGUE.en['portal-orders'] ?? {}).filter((key) => key.startsWith('ask.design.') || key.startsWith('ask.kind.DESIGN') || key === 'ask.details.DESIGN')
    expect(keys.length).toBeGreaterThan(30)
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const key of keys) expect(holes(CATALOGUE.it['portal-orders']![key] ?? ''), key).toEqual(holes(CATALOGUE.en['portal-orders']![key]!))
    for (const locale of ['en', 'it'] as const) {
      expect(CATALOGUE[locale]['portal-orders']!['ask.design.checked']).toBe(locale === 'en' ? 'Files are checked before we open them.' : 'I file vengono controllati prima che li apriamo.')
      expect(CATALOGUE[locale]['portal-orders']!['ask.design.sent']).toBe(locale === 'en' ? "Request sent. We answer here and in the order's conversation." : "Richiesta inviata. Vi rispondiamo qui e nella conversazione dell'ordine.")
      for (const key of ['limits.ask.DESIGN', 'limits.askLine.DESIGN']) expect(CATALOGUE[locale]['portal-access']?.[key], `${locale} ${key}`).toBeTruthy()
    }
  })

  it('Brand Beta’s design dialog holds nothing of Brand Alpha', () => {
    const base = designRules()
    const beta: ChangeRules = { ...base, lines: base.lines.map((line) => ({ ...line, style: { code: BRAND_BETA.numbers.style, name: 'Beta jacket' }, colourway: { code: 'BK', name: 'Black' } })) }
    for (const locale of ['en', 'it'] as const) {
      const html = drawWhat({ rules: beta, choices: askChoicesOf(beta, NO_REQUESTS), step: 'details', kind: 'DESIGN', draft: EMPTY_ASK, design: designModel() }, locale)
      expect(scanText(html, BRAND_ALPHA), locale).toEqual([])
    }
  })
})
// ── end F-SA-246 ──

// ── B-SA-046b (14-change-flow §2.4): the design change applies to the pieces not started yet (the default) or also to the made ones ──
describe('B-SA-046b: which pieces the design change is for', () => {
  const asked = { ...EMPTY_ASK, lineIds: [lineOne()], note: 'A shorter collar' }

  it('a new draft reads the pieces not started yet; Send says the choice; a draft without one sends none (the API reads the default)', () => {
    expect(EMPTY_ASK.appliesTo).toBe('NOT_STARTED')
    expect(APPLIES_TO_CHOICES).toEqual(['NOT_STARTED', 'ALSO_MADE'])
    expect(appliesToOf({})).toBe('NOT_STARTED')
    expect(designBodyOf(designRules(), asked, [])).toEqual({ kind: 'DESIGN', lineIds: [lineOne()], note: 'A shorter collar', appliesTo: 'NOT_STARTED' })
    expect(designBodyOf(designRules(), { ...asked, appliesTo: 'ALSO_MADE' }, []).appliesTo).toBe('ALSO_MADE')
    expect(designBodyOf(designRules(), { lineIds: [lineOne()], note: 'x', fileIds: [] }, [])).not.toHaveProperty('appliesTo')
  })

  it('step 2 offers both, the default picked; step 3 says the choice; in both languages, "voi" in Italian', () => {
    for (const locale of ['en', 'it'] as const) {
      const details = drawWhat({ rules: designRules(), step: 'details', kind: 'DESIGN', draft: asked, design: designModel() }, locale)
      const text = textOf(details)
      expect(text, locale).toContain(locale === 'en' ? 'Which pieces' : 'Quali pezzi')
      expect(text, locale).toContain(locale === 'en' ? 'Apply to pieces not started yet' : 'Applicare ai pezzi non ancora iniziati')
      expect(text, locale).toContain(locale === 'en' ? 'Also pieces already made (rework may cost)' : 'Anche ai pezzi già fatti (la rilavorazione può costare)')
      expect(details, locale).toMatch(/value="NOT_STARTED"[^>]*checked|checked[^>]*value="NOT_STARTED"/)
      const review = textOf(drawWhat({ rules: designRules(), step: 'impact', kind: 'DESIGN', draft: { ...asked, appliesTo: 'ALSO_MADE' }, design: designModel() }, locale))
      expect(review, locale).toContain(locale === 'en' ? 'Also pieces already made (rework may cost)' : 'Anche ai pezzi già fatti (la rilavorazione può costare)')
    }
    expect(CATALOGUE.it['portal-orders']!['ask.design.appliesTo.hint.ALSO_MADE']).toContain('vi diciamo')
  })

  it('reads the choice back from the impact and the request (the rest of the kept impact is not read here)', () => {
    const impact = askImpactSchema.parse({ kind: 'DESIGN', frozen: [], blocked: false, priced: true, earliest: null, notes: [], appliesTo: 'ALSO_MADE' })
    expect(impact.appliesTo).toBe('ALSO_MADE')
    // An answer from before it, and another kind: no choice.
    expect(askImpactSchema.parse({ kind: 'CHANGE', frozen: [], blocked: false, priced: false, earliest: null, notes: [] }).appliesTo).toBeUndefined()
    const request = changeRequestSchema.parse({ ...requestsOf()[0]!, kind: 'DESIGN', impact: { kind: 'DESIGN', frozen: [], words: say('x'), notes: [], appliesTo: 'ALSO_MADE' } })
    expect(request.impact).toEqual({ appliesTo: 'ALSO_MADE' })
    expect(changeRequestSchema.parse({ ...requestsOf()[0]!, impact: null }).impact).toBeNull()
  })
})
// ── end B-SA-046b ──
