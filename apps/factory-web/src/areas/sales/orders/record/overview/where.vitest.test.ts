import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { order } from '../../_demo/fixtures'
import { ORDER_STATUSES, type OrderStatus } from '../../api' // F-OO-101
import { BRAND_STAGES, type BrandStage, type Headline } from './api' // F-OO-101
import { CONFIRMED_READ, HEADLINE, PRODUCTION_READ } from './fixtures'
import { headlineOf, stageStripOf, stagesShown } from './where'
import * as where from './where' // F-OO-103: what section 1's rules still export
import { bandHealthOf, healthInputOf, waitingOf } from './model'
// ---- F-OO-104: the strips
import { deposit, PAID } from '../../_demo/fixtures'
import { APPROVAL_NOBODY, APPROVAL_PENDING } from '../../depth/demo/fixtures'
import type { OpenApproval, Order } from '../../api'
import type { Approval } from '../../depth/api'
import type { OrderProduction } from './api'
import { FAILED_STATE, LOADING_STATE, ready, WORK } from './fixtures'
import { orderWaitingOf, type ProductionState } from './model'
import { STRIP_KINDS, STRIPS_SHOWN, whereStripsOf, type WhereStrip } from './where'
// ---- end F-OO-104

/**
 * F-OO-100 (order overview lane: one file per section) — "Where it is now"'s rules, moved with where.ts out of overview.vitest.test.ts
 * (F-SA-232: the headline sentence per state, the five stages, the health only from the reads). F-OO-101 / 102 / 103 / 202 rewrote
 * them: status · stage, the office strip state, the frame, and no "who acts next" (the waiting rows have their places).
 */

// ---- F-OO-101 (order overview §1.2; review F8): the headline is the status AND the stage — rewritten from "one sentence per state" ----
describe('F-OO-101: the headline is the status and the stage, one sentence the dots agree with', () => {
  const at = (code: BrandStage): Headline => ({ ...HEADLINE, stage: { ...HEADLINE.stage!, code } })
  const shipment = (id: string, shippedAt: string | null, deliveredAt: string | null) => ({ id, number: `SH-${id}`, status: deliveredAt ? 'DELIVERED' : 'SHIPPED', shippedAt, deliveredAt })
  const shippedAs = (status: OrderStatus, shipments: ReturnType<typeof shipment>[]) => ({ ...order(status), chain: { ...order(status).chain, shipments } })
  const SHIPMENTS = [shipment('1', '2026-11-12T10:00:00Z', '2026-11-14T11:00:00Z'), shipment('2', '2026-11-20T10:00:00Z', null)]

  it('every status × stage of the table: the status word, then the stage word — and never "· 1 line ahead"', () => {
    // Waiting for a yes: the status alone, and its quiet line (whatever the read says of the stage).
    expect(headlineOf(order('PENDING_APPROVAL'), HEADLINE)).toEqual({ state: 'WAITING', status: { key: 'status.PENDING_APPROVAL' }, stage: null, note: { key: 'where.note.waiting' } })
    // Confirmed: "Confirmed · Preparing" before any work order (no stage read, or the read's own Preparing); a stage reached is said.
    expect(headlineOf(order('CONFIRMED'), CONFIRMED_READ.headline)).toEqual({ state: 'CURRENT', status: { key: 'status.CONFIRMED' }, stage: 'PREPARING', note: null })
    expect(headlineOf(order('CONFIRMED'), at('PREPARING'))).toEqual({ state: 'CURRENT', status: { key: 'status.CONFIRMED' }, stage: 'PREPARING', note: null })
    expect(headlineOf(order('CONFIRMED'), at('QUALITY'))).toEqual({ state: 'CURRENT', status: { key: 'status.CONFIRMED' }, stage: 'QUALITY', note: null })
    // In production, Ready, Partly shipped: status · stage; no stage read: "Stage not known yet", never step 1.
    for (const status of ['IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const) {
      for (const code of BRAND_STAGES.filter((stage) => !(status === 'READY' && stage === 'READY'))) expect(headlineOf(order(status), at(code)), `${status} ${code}`).toEqual({ state: 'CURRENT', status: { key: `status.${status}` }, stage: code, note: null })
      expect(headlineOf(order(status), { ...HEADLINE, stage: null }), status).toEqual({ state: 'CURRENT', status: { key: `status.${status}` }, stage: 'unknown', note: null })
    }
    // One word per thing: the status Ready with the stage Ready to ship is "Ready to ship" alone (never "Ready · Ready to ship").
    expect(headlineOf(order('READY'), at('READY'))).toEqual({ state: 'CURRENT', status: null, stage: 'READY', note: null })
    // "· 1 line ahead" is gone (F8): the read still says it (aheadWords), the headline never does.
    expect(HEADLINE.stage!.ahead).toBe(1)
    for (const status of ORDER_STATUSES) expect(JSON.stringify(headlineOf(order(status), HEADLINE)), status).not.toMatch(/ahead/)
  })

  it('after production: shipped on its last day (delivered only once the order is), closed with it; cancelled says where work had reached', () => {
    // The newest shipment's day; an older shipment's arrival is never the order's.
    expect(headlineOf(shippedAs('SHIPPED', SHIPMENTS), HEADLINE)).toEqual({ state: 'ALL_DONE', status: { key: 'overview.headline.shipped', params: { shipped: '2026-11-20T10:00:00Z' } }, stage: null, note: null })
    const delivered = [SHIPMENTS[0]!, shipment('2', '2026-11-20T10:00:00Z', '2026-11-22T09:00:00Z')]
    expect(headlineOf(shippedAs('DELIVERED', delivered), HEADLINE)).toEqual({ state: 'ALL_DONE', status: { key: 'overview.headline.delivered', params: { shipped: '2026-11-20T10:00:00Z', delivered: '2026-11-22T09:00:00Z' } }, stage: null, note: null })
    expect(headlineOf(shippedAs('CLOSED', SHIPMENTS), HEADLINE)).toEqual({ state: 'ALL_DONE', status: { key: 'where.headline.closedShipped', params: { shipped: '2026-11-20T10:00:00Z' } }, stage: null, note: null })
    // No shipment day known (closed short, say): the status word alone.
    expect(headlineOf(shippedAs('CLOSED', []), HEADLINE)).toEqual({ state: 'ALL_DONE', status: { key: 'status.CLOSED' }, stage: null, note: null })
    expect(headlineOf(shippedAs('SHIPPED', []), HEADLINE)).toEqual({ state: 'ALL_DONE', status: { key: 'status.SHIPPED' }, stage: null, note: null })
    // Cancelled: the status word; where the work had reached once it was beyond Preparing (nothing begun: nothing said).
    expect(headlineOf(order('CANCELLED'), at('CUTTING'))).toEqual({ state: 'STOPPED', status: { key: 'status.CANCELLED' }, stage: null, note: { key: 'where.note.reached', stage: 'CUTTING' } })
    expect(headlineOf(order('CANCELLED'), at('PREPARING'))).toEqual({ state: 'STOPPED', status: { key: 'status.CANCELLED' }, stage: null, note: null })
    expect(headlineOf(order('CANCELLED'), null)).toEqual({ state: 'STOPPED', status: { key: 'status.CANCELLED' }, stage: null, note: null })
  })

  it('the words: each status and stage word exists in both languages; the new lines in both languages; the old ones are gone', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      const p = createTranslator(locale, messagesFor(locale, ['production']).production!)
      for (const status of ORDER_STATUSES) expect(t(`status.${status}`), `${locale} ${status}`).not.toBe(`status.${status}`)
      for (const stage of [...BRAND_STAGES, 'unknown']) expect(p(`parts.stage.${stage}`), `${locale} ${stage}`).not.toBe(`parts.stage.${stage}`)
      expect(t('where.note.waiting'), locale).not.toBe('where.note.waiting')
      expect(t('where.note.reached', { stage: p('parts.stage.CUTTING') })).toBe(locale === 'en' ? 'Work had reached Cutting when it was cancelled' : 'Il lavoro era arrivato a Taglio quando è stato annullato')
      expect(t('where.headline.closedShipped', { shipped: '20/11/2026' })).toBe(locale === 'en' ? 'Closed · shipped 20/11/2026' : 'Chiuso · spedito il 20/11/2026')
      // "1 line ahead" and "Confirmed · waiting for the deposit" left the catalogue with the headline that said them.
      for (const key of ['overview.ahead', 'overview.headline.waitingDeposit']) expect(t(key, { count: 1 }), `${locale} ${key}`).toBe(key)
    }
    // One word per thing: the status "Ready" and the stage "Ready to ship" are two words, never the same one.
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    const stageEn = createTranslator('en', messagesFor('en', ['production']).production!)
    expect([en('status.READY'), stageEn('parts.stage.READY')]).toEqual(['Ready', 'Ready to ship'])
  })
})
// ---- end F-OO-101

describe('"Where it is now": the stages and the facts', () => {
  // F-OO-102: rewritten — the strip carries the office state (the headline's own); the blocked why left the current dot (the strips say it).
  it('the stages: the stage now with its day, the working plan, the blocked mark without its why; before any work order Preparing', () => {
    const strip = stageStripOf(order('IN_PRODUCTION'), HEADLINE, PRODUCTION_READ.dates)
    expect(strip).toMatchObject({ state: 'CURRENT', stage: 'SEWING', reached: { SEWING: '2026-11-13' }, sewingCounted: true, blocked: null, expected: { CUTTING: '2026-11-10', SEWING: '2026-11-13', QUALITY: '2026-12-10' } })
    const holds = [{ kind: 'QUALITY' as const, words: { en: 'Quality hold', it: 'Sospensione qualità' }, since: '2026-11-14' }]
    const held = stageStripOf(order('IN_PRODUCTION'), { ...HEADLINE, held: true, holds }, null)
    expect(held.blocked).toEqual({ why: null })
    expect(JSON.stringify(held)).not.toContain('Quality hold')
    // F-OO-103: Preparing carries no deposit note any more ("Work orders are made after the deposit" is the deposit strip's, F-OO-105).
    expect(stageStripOf(order('CONFIRMED'), CONFIRMED_READ.headline, null)).toEqual({ state: 'CURRENT', stage: 'PREPARING', expected: { CUTTING: null, SEWING: null, QUALITY: null }, blocked: null })
    expect(stageStripOf(order('IN_PRODUCTION'), { ...HEADLINE, stage: null }, null)).toEqual({ state: 'CURRENT', stage: null })
  })

  it('F-OO-102: the dots read the headline\'s state — waiting all to come, production over all done (no blocked mark), cancelled no strip', () => {
    for (const status of ORDER_STATUSES) expect(stageStripOf(order(status), HEADLINE, PRODUCTION_READ.dates).state, status).toBe(headlineOf(order(status), HEADLINE).state)
    expect(stageStripOf(order('PENDING_APPROVAL'), HEADLINE, PRODUCTION_READ.dates)).toEqual({ state: 'WAITING', stage: null })
    expect(stageStripOf(order('CANCELLED'), HEADLINE, PRODUCTION_READ.dates)).toEqual({ state: 'STOPPED', stage: null })
    // After shipping the keeper stops: the kept stage keeps its day, every stage reads done, a hold still kept marks nothing.
    const held = { ...HEADLINE, held: true, holds: [{ kind: 'PRODUCTION' as const, words: { en: 'x', it: 'x' }, since: '2026-11-14' }] }
    for (const status of ['SHIPPED', 'DELIVERED', 'CLOSED'] as const) expect(stageStripOf(order(status), held, PRODUCTION_READ.dates), status).toEqual({ state: 'ALL_DONE', stage: 'SEWING', reached: { SEWING: '2026-11-13' } })
    // The dots (and their quiet line) are drawn only where they say something true.
    expect(ORDER_STATUSES.filter((status) => stagesShown(headlineOf(order(status), HEADLINE).state))).toEqual(['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CLOSED', 'DELIVERED'])
  })

  // F-OO-103: rewritten — the bundles in work left section 1 (Progress by line counts each step; the design case proves they are not
  // drawn here); the ex-factory slip is the Promised row's (Next dates), the health the band's.
  // F-OO-202: rewritten — "who acts next" is gone (F14, the keeper's waitingOn is the one rule): the list's first row is no longer
  // section 1's; a customer's request is the card's (REQUEST), and section 1 reads only the rows placed HOLD.
  it('the waiting rows section 1 reads are its holds; no ex-factory or bundles rule here; the health from the keeper else the order’s lateness', async () => {
    const rows = waitingOf({ headline: HEADLINE }, { requests: [], approvals: [], recordPayment: false, locale: 'it' })
    expect(rows).toMatchObject([{ kind: 'BRAND_REQUEST', on: 'US', since: '2026-11-17T09:05:00Z', place: 'REQUEST' }])
    expect(rows.filter((row) => row.place === 'HOLD')).toEqual([])
    expect(waitingOf({ headline: CONFIRMED_READ.headline }, { requests: [], approvals: [], recordPayment: false, locale: 'it' }).map((row) => [row.kind, row.place])).toEqual([['DEPOSIT', 'HOLD']])
    expect('whoActsNextOf' in (await import('./model'))).toBe(false)
    // The ex-factory line left with section 1's facts: Next dates' Promised row says the promise and its moves (F-OO-141, its own rule).
    for (const gone of ['inWorkOf', 'preparingNote', 'exFactoryOf']) expect(gone in where, gone).toBe(false)
    const atRisk = healthInputOf(order('IN_PRODUCTION'), HEADLINE)
    expect(atRisk.computed).toBe('AT_RISK')
    expect(bandHealthOf(atRisk)).toBe(true)
    expect(bandHealthOf(healthInputOf(order('IN_PRODUCTION'), { ...HEADLINE, health: { ...HEADLINE.health!, code: 'ON_TRACK', computed: 'ON_TRACK' } }))).toBe(false)
    // No state kept yet: the order read's own lateness, in the same words.
    const late = healthInputOf({ ...order('IN_PRODUCTION'), daysLate: 3 }, { ...HEADLINE, health: null })
    expect(late).toMatchObject({ computed: 'LATE', daysLate: 3 })
    expect(healthInputOf(order('IN_PRODUCTION'), null).computed).toBeUndefined()
  })
})

// ---- F-OO-104 (order overview §1.3; review F1, F13; Owner D6): the strips model — one per hold or wait, most blocking first ----
describe('F-OO-104: the strips — the yes, the credit, the review, the deposit, then one strip per hold kind "on N work orders"', () => {
  const words = (en: string) => ({ en, it: `${en} (it)` })
  type Ref = { type: string; id: string } | null
  const blocker = (kind: string, on: 'US' | 'BRAND', since: string | null, ref: Ref) => ({ kind, on, words: words(kind), since, ref, sub: null })
  const wo = (id: string, number: string, shared = false) => ({ ...WORK.workOrders[0]!, id, number, sharedWithOtherCustomers: shared })
  const task = (kind: string, taskId: string, requestedAt: string, approver = 'Finance'): OpenApproval => ({ taskId, kind, kindLabel: { en: kind, it: kind }, requestedAt, requester: { name: 'Luca Prova', me: false }, approver: { kind: 'ROLE', name: approver, me: false }, version: 1, requireStepUp: false, approve: { allowed: true, why: null }, reject: { allowed: true, why: null }, withdraw: { allowed: false, why: null } })
  type Hold = NonNullable<OrderProduction['headline']>['holds'][number]
  const readWith = (blockers: ReturnType<typeof blocker>[], holds: Hold[] = [], workOrders: ReturnType<typeof wo>[] = [], leftOut = 0): OrderProduction => ({ ...PRODUCTION_READ, headline: { ...HEADLINE, held: holds.length > 0, holds, waiting: { ...HEADLINE.waiting, blockers } }, work: { ...WORK, workOrders, workOrdersLeftOut: leftOut } })
  /** The strips as the card makes them: from the ONE waiting call (OverviewTab's own), the production read, the yes's read. */
  const stripsOf = (value: Order, read: OrderProduction | null, approval: Approval | null = null, state?: ProductionState) => {
    const production = state ?? (read ? ready(read) : null)
    return whereStripsOf(value, read, approval, orderWaitingOf(value, { production, requests: { value: [] }, can: { recordPayment: true } }, 'en'))
  }
  const kinds = (strips: readonly WhereStrip[]) => strips.map((strip) => strip.kind)
  const held = (strips: readonly WhereStrip[], kind: WhereStrip['kind']) => strips.find((strip) => strip.kind === kind) as Extract<WhereStrip, { kind: 'quality' | 'production' | 'pause' | 'other' }>

  it('the order of strips, most blocking first: the yes, the credit, the review, the deposit, quality, production, the pause, another kind', () => {
    const open = deposit()
    const waiting: Order = {
      ...order('PENDING_APPROVAL'),
      waits: ['REQUEST_PENDING', 'CREDIT_HOLD', 'MEASUREMENTS'],
      madeToMeasure: { units: 2, waitingReview: 1, riders: null },
      openApprovals: [task('CREDIT_OVERRIDE', 't-credit', '2026-11-02T09:00:00Z'), task('SALES_ORDER', 't-own', '2026-11-03T09:00:00Z', 'Marco Demo')],
      chain: { ...order('PENDING_APPROVAL').chain, depositRequests: [open] },
    }
    const read = readWith([
      blocker('BRAND_PAUSE', 'BRAND', '2026-11-12T09:00:00Z', { type: 'WorkOrder', id: 'wo-1' }),
      blocker('NONCONFORMANCE', 'US', '2026-11-09T09:00:00Z', { type: 'WorkOrder', id: 'wo-3' }),
      blocker('NO_MOVE', 'US', '2026-11-11T09:00:00Z', { type: 'WorkOrder', id: 'wo-2' }),
      blocker('DEPOSIT', 'BRAND', '2026-10-28T15:00:00Z', { type: 'DepositRequest', id: open.id }),
      blocker('QUALITY_HOLD', 'US', '2026-11-14T09:00:00Z', { type: 'WorkOrder', id: 'wo-3' }),
      blocker('BRAND_REQUEST', 'US', '2026-11-08T09:00:00Z', { type: 'OrderChangeRequest', id: 'r-1' }),
    ], [], [wo('wo-1', 'WO-00021'), wo('wo-2', 'WO-00022'), wo('wo-3', 'WO-00023')])
    const { strips, holds } = stripsOf(waiting, read)
    expect(kinds(strips)).toEqual(['yes', 'credit', 'review', 'deposit', 'quality', 'production', 'pause', 'other'])
    expect(STRIP_KINDS).toEqual(['yes', 'credit', 'review', 'deposit', 'quality', 'production', 'pause', 'other'])
    expect(holds).toBe('read')
    // Each with what it says: who decides each yes and since when, how many units wait, the deposit's request and due day.
    expect(strips[0]).toMatchObject({ kind: 'yes', asked: true, who: 'Marco Demo', since: '2026-11-03T09:00:00Z', task: { taskId: 't-own' } })
    expect(strips[1]).toMatchObject({ kind: 'credit', asked: true, who: 'Finance', since: '2026-11-02T09:00:00Z', task: { taskId: 't-credit' } })
    expect(strips[2]).toMatchObject({ kind: 'review', count: 1 })
    expect(strips[3]).toMatchObject({ kind: 'deposit', state: 'WAITING', requestId: open.id, due: open.dueDate, since: '2026-10-28T15:00:00Z' })
    // Another kind the list places with the holds keeps its own strip with the API's own words (never hidden); a request is not a strip.
    expect(held(strips, 'other')).toMatchObject({ blocker: 'NONCONFORMANCE', reasons: [words('NONCONFORMANCE')] })
    expect(JSON.stringify(strips)).not.toContain('r-1')
    // At most four show; the rest fold behind "Show {n} more" (the card's).
    expect(STRIPS_SHOWN).toBe(4)
  })

  it('one strip per hold kind with its N: a work order held twice counts once; by number; each reason once; the earliest since', () => {
    const read = readWith(
      [
        blocker('BRAND_PAUSE', 'BRAND', '2026-11-13T09:00:00Z', { type: 'WorkOrder', id: 'wo-2' }),
        blocker('BRAND_PAUSE', 'BRAND', '2026-11-12T09:00:00Z', { type: 'WorkOrder', id: 'wo-1' }),
        blocker('NO_MOVE', 'US', '2026-11-11T09:00:00Z', { type: 'WorkOrder', id: 'wo-1' }),
        blocker('NO_MOVE', 'US', '2026-11-10T09:00:00Z', { type: 'WorkOrder', id: 'wo-1' }),
      ],
      [
        { kind: 'PRODUCTION', words: words('Leather check'), since: '2026-11-10' },
        { kind: 'PRODUCTION', words: words('Trims missing'), since: '2026-11-11' },
        { kind: 'QUALITY', words: words('Shade difference'), since: '2026-11-09' },
        { kind: 'BRAND', words: words("Paused at the customer's request"), since: '2026-11-12' },
      ],
      [wo('wo-2', 'WO-00022'), wo('wo-1', 'WO-00021')],
    )
    const { strips } = stripsOf(order('IN_PRODUCTION'), read)
    // The quality words have no blocker row here (no work order of the order is held by quality): no quality strip is made up.
    expect(kinds(strips)).toEqual(['production', 'pause'])
    expect(held(strips, 'production')).toEqual({ key: 'production', kind: 'production', blocker: 'NO_MOVE', reasons: [words('Leather check'), words('Trims missing')], workOrders: { reached: [{ id: 'wo-1', number: 'WO-00021', shared: false }], notReached: 0 }, since: '2026-11-10T09:00:00Z' })
    // One customer pause on two work orders = ONE strip "on 2 work orders" (its words are the strip's own: no reason list).
    expect(held(strips, 'pause')).toEqual({ key: 'pause', kind: 'pause', blocker: 'BRAND_PAUSE', reasons: [], workOrders: { reached: [{ id: 'wo-1', number: 'WO-00021', shared: false }, { id: 'wo-2', number: 'WO-00022', shared: false }], notReached: 0 }, since: '2026-11-12T09:00:00Z' })
  })

  it('F13: a shared work order (reached, it makes other customers\' work) and one not reached — two cases, never confused', () => {
    const read = readWith(
      [
        blocker('NO_MOVE', 'US', '2026-11-10T09:00:00Z', { type: 'WorkOrder', id: 'wo-s' }),
        blocker('NO_MOVE', 'US', '2026-11-11T09:00:00Z', null),
        blocker('NO_MOVE', 'US', '2026-11-12T09:00:00Z', null),
        blocker('QUALITY_HOLD', 'US', '2026-11-12T09:00:00Z', null),
      ],
      [],
      [wo('wo-s', 'WO-00019', true)],
      1,
    )
    const { strips } = stripsOf(order('IN_PRODUCTION'), read)
    // The shared one is named (the reader reaches it) and marked; those not reached are counted, never more than the read leaves out.
    expect(held(strips, 'production').workOrders).toEqual({ reached: [{ id: 'wo-s', number: 'WO-00019', shared: true }], notReached: 1 })
    expect(held(strips, 'quality').workOrders).toEqual({ reached: [], notReached: 1 })
    // Without the work part (withheld) the not-reached rows are counted as they come; a number comes from the order read's chain.
    const chained = order('IN_PRODUCTION')
    const first = chained.chain.workOrders[0]!
    const withheld = { ...readWith([blocker('NO_MOVE', 'US', '2026-11-10T09:00:00Z', { type: 'WorkOrder', id: first.id }), blocker('NO_MOVE', 'US', null, null), blocker('NO_MOVE', 'US', null, null)]), work: null }
    expect(held(stripsOf(chained, withheld).strips, 'production').workOrders).toEqual({ reached: [{ id: first.id, number: first.number, shared: false }], notReached: 2 })
  })

  it('a failed (or reading) production read keeps the yes, the credit and the deposit from the order read; holds are said apart', () => {
    const waiting: Order = { ...order('PENDING_APPROVAL'), waits: ['REQUEST_PENDING', 'CREDIT_HOLD'], openApprovals: [task('SALES_ORDER', 't-own', '2026-11-03T09:00:00Z'), task('CREDIT_OVERRIDE', 't-credit', '2026-11-02T09:00:00Z')] }
    for (const [state, holds] of [[FAILED_STATE, 'failed'], [LOADING_STATE, 'reading']] as const) {
      const failed = stripsOf(waiting, null, null, state)
      expect(kinds(failed.strips), holds).toEqual(['yes', 'credit'])
      expect(failed.holds).toBe(holds)
      expect(failed.strips[0]).toMatchObject({ task: { taskId: 't-own' } })
      // Confirmed and its deposit open: the order read's own gate (the request, its due day) while the production read is out.
      const confirmed = stripsOf(order('CONFIRMED'), null, null, state)
      expect(confirmed.strips, holds).toEqual([{ key: 'deposit', kind: 'deposit', state: 'WAITING', requestId: deposit().id, due: deposit().dueDate, since: deposit().createdAt }])
      // Paid: nothing waits; a deposit never asked: production waits for one (no request to record a payment on).
      expect(stripsOf(order('CONFIRMED', { chain: { ...order('CONFIRMED').chain, depositRequests: [PAID] } }), null, null, state).strips).toEqual([])
      expect(stripsOf(order('CONFIRMED', { chain: { ...order('CONFIRMED').chain, depositRequests: [] } }), null, null, state).strips).toMatchObject([{ kind: 'deposit', state: 'MISSING', requestId: null }])
    }
    // Read: the deposit is the list's own row (the production read decides whether it still holds the release).
    expect(stripsOf(order('CONFIRMED'), { ...CONFIRMED_READ, work: null }).strips).toMatchObject([{ kind: 'deposit', state: 'WAITING', requestId: '0190f0e2-1818-7000-8000-000000000001' }])
    expect(stripsOf(order('CONFIRMED'), readWith([])).strips).toEqual([])
  })

  it('the yes: asked of whom (its task, or a request the reader sees no task of), nobody asked yet; the credit hold alone; a credit yes in work', () => {
    const nobody = stripsOf({ ...order('PENDING_APPROVAL'), waits: ['NO_REQUEST'] }, null, APPROVAL_NOBODY, FAILED_STATE).strips
    expect(nobody).toEqual([{ key: 'yes', kind: 'yes', task: null, asked: false, who: null, since: null }])
    const asked = stripsOf({ ...order('PENDING_APPROVAL'), waits: ['REQUEST_PENDING'] }, null, APPROVAL_PENDING, FAILED_STATE).strips
    expect(asked).toEqual([{ key: 'yes', kind: 'yes', task: null, asked: true, who: APPROVAL_PENDING.requests[0]!.approver, since: APPROVAL_PENDING.requests[0]!.requestedAt }])
    // An older answer without `waits`: the yes's own read says why.
    expect(kinds(stripsOf({ ...order('PENDING_APPROVAL'), waits: undefined }, null, APPROVAL_PENDING, FAILED_STATE).strips)).toEqual(['yes'])
    // Held by its credit only: the credit strip, nobody asked for the override yet; no yes strip of the order's own.
    expect(stripsOf({ ...order('PENDING_APPROVAL'), waits: ['CREDIT_HOLD'] }, null, null, FAILED_STATE).strips).toEqual([{ key: 'credit', kind: 'credit', task: null, asked: false, who: null, since: null }])
    // A release held by the credit while the order is in work: its override's yes is a strip too (never hidden: it is no request).
    const inWork = stripsOf({ ...order('IN_PRODUCTION'), openApprovals: [task('CREDIT_OVERRIDE', 't-release', '2026-11-15T09:00:00Z')] }, readWith([]))
    expect(inWork.strips).toMatchObject([{ kind: 'credit', asked: true, task: { taskId: 't-release' } }])
    // An old change's yes is a request (Requests & changes), never a strip.
    expect(stripsOf({ ...order('IN_PRODUCTION'), openApprovals: [task('SALES_ORDER_CHANGE', 't-change', '2026-11-15T09:00:00Z')] }, readWith([])).strips).toEqual([])
  })

  it('after production nothing stops the work: no strip, though the office read still sends the live holds (B-OO-007, plan §5)', () => {
    const read = readWith([blocker('QUALITY_HOLD', 'US', '2026-11-12T09:00:00Z', { type: 'WorkOrder', id: 'wo-1' })], [{ kind: 'QUALITY', words: words('Shade difference'), since: '2026-11-12' }], [wo('wo-1', 'WO-00021')])
    for (const status of ['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const) {
      const value = { ...order(status), openApprovals: [task('CREDIT_OVERRIDE', 't-credit', '2026-11-02T09:00:00Z')] }
      expect(stripsOf(value, read), status).toEqual({ strips: [], holds: 'read' })
      expect(stripsOf(value, null, null, FAILED_STATE), status).toEqual({ strips: [], holds: 'read' })
    }
    // Before and during production the same hold is a strip.
    expect(kinds(stripsOf(order('PARTLY_SHIPPED'), read).strips)).toEqual(['quality'])
  })
})
// ---- end F-OO-104
