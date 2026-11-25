import { describe, expect, it, vi } from 'vitest'
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
// ---- F-OO-105: the strips' doors and their draws
import { readFileSync } from 'node:fs'
import type { ComponentType } from 'react'
import { renderView, textOf } from '../../../../../lib/record-thread/parts/testing'
import { designScreen } from '../fixtures'
import { abilitiesOf } from '../../model'
import { rolePermissions } from '../../../../../shell/design-data'
import { actsCanOf } from '../../../../../lib/production/work-order-acts/model'
import { stripDoorsOf, workOrderHref, type StripDoor, type StripDoorsInput } from './where'
// ---- end F-OO-105
// ---- F-OO-107: the moves row and the band's own rules it reads
import { cancelHeld, closeHeld, readOnlyOnPage, readyHeld } from '../../model'
import { elsewhereDoor } from '../shipments/elsewhere/model'
import { WHERE_MOVES, whereMovesOf } from './where'
// ---- end F-OO-107
import { HOLD_ORDER_FROM, holdOrderMoveOf } from './where' // F-OO-108: Hold the whole order…
import { workActsRead } from './fixtures' // F-OO-108: a read with each row's version and rights
// ---- F-OO-106: the order's own credit hold — its doors, lines, refusals, notices; the hook's two acts with a fake API
import { createElement } from 'react'
import { ApiError } from '../../../../../lib/api/errors'
import type { ApiClient } from '../../../../../lib/api/client'
import { render } from '../../../../../lib/record-thread/parts/testing'
import { creditAskNoticeOf, creditCheckNoticeOf, creditDoorsOf, creditHoldWaits, creditLinesOf, creditRefusalOf, refuseLineOf, CREDIT_ASK_NOTE_MAX, type CreditState } from './where'
import type { CreditCustomer } from '../credit/api'
import { useOverviewActs } from '../use-overview-acts'
import type { RecordActsBase, RecordDialog } from '../record-model'
// ---- F-MS-101: the stage set by hand — the row under the dots, its one door, the domain's words
import { HAND_AT, HAND_BY, HAND_FREE_READ, HAND_NOWORK_READ, HAND_OLD_READ, HAND_PAUSED_READ, HAND_READ } from './fixtures'
import { handDoorOf, handRowOf, pausedByCustomer } from './where'
import { HAND_BACK_BY, HAND_BACK_READ } from './fixtures' // F-SC-W1: a set back below the floor
import { stagePicksHeldOf, stagePicksOf } from './where' // F-SC-W1: the steps of the stages into the ONE dialog
import { STAGE_SET_REFUSAL_WORDS } from '@nexus/factory-domain/production-brand/stage-set'
// ---- end F-MS-101

// F-OO-106: the DS Modal draws only after it mounts in a browser — here a plain section, so a dialog's words are read on the server
// too (as lines-held's and facts' dialog tests do). Only an open dialog draws; no other case changes.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})
// ---- end F-OO-106

// quick-check fix (W07/W11): a catalogue is FLAT ('where.credit.check' → text; lib/i18n/messages.ts), so `.orders!.where.credit` was
// undefined (a type error, and a throw at run time). The Italian texts under a key prefix, as one string (never empty: the keys exist).
const itWordsUnder = (...prefixes: readonly string[]): string => {
  const words = Object.entries(messagesFor('it', ['orders']).orders!).filter(([key]) => prefixes.some((prefix) => key.startsWith(prefix))).map(([, text]) => text)
  expect(words.length, prefixes.join(', ')).toBeGreaterThan(0)
  return JSON.stringify(words)
}

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
  /** F-OO-106: an order as the strips may get it — the list rows' `waits` / `madeToMeasure` beside the order read (which has neither). */
  type StripOrder = Order & { readonly waits?: readonly string[] | null; readonly madeToMeasure?: { readonly units: number; readonly waitingReview: number; readonly riders: null } | null }
  /** The strips as the card makes them: from the ONE waiting call (OverviewTab's own), the production read, the yes's read. */
  const stripsOf = (value: StripOrder, read: OrderProduction | null, approval: Approval | null = null, state?: ProductionState) => {
    const production = state ?? (read ? ready(read) : null)
    return whereStripsOf(value, read, approval, orderWaitingOf(value, { production, requests: { value: [] }, can: { recordPayment: true } }, 'en'))
  }
  const kinds = (strips: readonly WhereStrip[]) => strips.map((strip) => strip.kind)
  const held = (strips: readonly WhereStrip[], kind: WhereStrip['kind']) => strips.find((strip) => strip.kind === kind) as Extract<WhereStrip, { kind: 'quality' | 'production' | 'pause' | 'other' }>

  it('the order of strips, most blocking first: the yes, the credit, the review, the deposit, quality, production, the pause, another kind', () => {
    const open = deposit()
    const waiting: StripOrder = {
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
    const waiting: StripOrder = { ...order('PENDING_APPROVAL'), waits: ['REQUEST_PENDING', 'CREDIT_HOLD'], openApprovals: [task('SALES_ORDER', 't-own', '2026-11-03T09:00:00Z'), task('CREDIT_OVERRIDE', 't-credit', '2026-11-02T09:00:00Z')] }
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
    // Walk #2: a credit yes asked that this reader sees no task of (no approvals list: Production, Warehouse) is still asked — the
    // yes's read names it (creditHold.requestTaskId); "nobody asked" only when that read says none is asked.
    const creditRead = (requestTaskId: string | null): Approval => ({ ...APPROVAL_NOBODY, reasons: [{ reason: 'CREDIT_HOLD' }], creditHold: { checkId: 'c-hold', requestTaskId }, requests: [] })
    expect(stripsOf({ ...order('PENDING_APPROVAL'), openApprovals: [], waits: undefined }, null, creditRead('t-hidden'), FAILED_STATE).strips).toEqual([{ key: 'credit', kind: 'credit', task: null, asked: true, who: null, since: null }])
    expect(stripsOf({ ...order('PENDING_APPROVAL'), openApprovals: [], waits: undefined }, null, creditRead(null), FAILED_STATE).strips).toEqual([{ key: 'credit', kind: 'credit', task: null, asked: false, who: null, since: null }])
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

// ---- F-OO-105 (order overview §1.3; review F1, F8, F13): each strip's real doors — held with words, ≤ 3 buttons, Read-only words only ----
describe('F-OO-105: the strips\' doors — the band\'s yes, the payment, the row\'s Lift, Quality, the review; held with words', () => {
  const words = (en: string) => ({ en, it: `${en} (it)` })
  const task = (over: Partial<OpenApproval> = {}): OpenApproval => ({ taskId: 't-1', kind: 'SALES_ORDER', kindLabel: { en: 'Sales order', it: 'Ordine di vendita' }, requestedAt: '2026-11-18T09:30:00Z', requester: { name: 'Luca Prova', me: false }, approver: { kind: 'ROLE', name: 'Finance', me: false }, version: 1, requireStepUp: false, approve: { allowed: true, why: null }, reject: { allowed: true, why: null }, withdraw: { allowed: false, why: null }, ...over })
  const OTHER = 'This request waits for another approver: it is not addressed to you or to a role you hold over its company.'
  const SELF = 'You asked for this: nobody approves their own request, the Owner included.'
  const askedByOther: Approval = { ...APPROVAL_PENDING, requests: APPROVAL_PENDING.requests.map((request) => ({ ...request, mine: false })), may: { ask: false, withdraw: false } }
  const owner = rolePermissions('owner')
  const input = (over: Partial<StripDoorsInput> = {}): StripDoorsInput => ({ prefix: '/w/DEMO', order: order('IN_PRODUCTION'), can: abilitiesOf(owner), readOnly: false, busy: false, approval: null, depthCan: { manage: true }, work: [], acts: actsCanOf(owner), ...over })
  const yes = (strip: Partial<Extract<WhereStrip, { kind: 'yes' | 'credit' }>> = {}): WhereStrip => ({ key: 'yes', kind: 'yes', task: null, asked: false, who: null, since: null, ...strip })
  const hold = (kind: 'quality' | 'production' | 'pause' | 'other', reached: { id: string; number: string; shared?: boolean }[], notReached = 0): WhereStrip => ({ key: kind, kind, blocker: 'NO_MOVE', reasons: [words('x')], workOrders: { reached: reached.map((entry) => ({ shared: false, ...entry })), notReached }, since: null })
  const kindsOf = (doors: readonly StripDoor[]) => doors.map((door) => (door.kind === 'yes' ? `yes:${door.door.kind}` : door.kind))
  const heldOf = (doors: readonly StripDoor[]) => doors.map((door) => ('held' in door ? (door.held?.key ?? null) : door.kind === 'yes' && door.door.kind === 'decide' ? (door.door.confirmHeld?.key ?? null) : null))
  /** The visible buttons a strip draws: the yes as YesDoorView draws it (decide 2, the asker's held yes 1), every other door 1. */
  const buttons = (doors: readonly StripDoor[]) => doors.reduce((sum, door) => sum + (door.kind === 'yes' ? (door.door.kind === 'decide' ? 2 : door.door.kind === 'selfAsked' ? 1 : 0) : 1), 0)
  const all: StripDoor[][] = []
  const doorsOf = (strip: WhereStrip, over: Partial<StripDoorsInput> = {}) => {
    const doors = stripDoorsOf(strip, input(over))
    all.push(doors)
    return doors
  }

  it('the order\'s yes, as the band\'s banner: the approver decides here; the asker sees it held and takes it back; anyone else reads who decides', () => {
    // The approver who did not ask: Confirm the order + Refuse… (YesDoorView), nothing else.
    expect(kindsOf(doorsOf(yes({ task: task(), asked: true, who: 'Finance' }), { approval: askedByOther }))).toEqual(['yes:decide'])
    // The asker: the yes held ("another person decides") and Take the request back (theirs).
    const asker = doorsOf(yes({ task: task({ requester: { name: 'Giulia Esempio', me: true }, approve: { allowed: false, why: SELF }, reject: { allowed: false, why: SELF } }), asked: true, who: 'Finance' }), { approval: APPROVAL_PENDING })
    expect([kindsOf(asker), heldOf(asker)]).toEqual([['yes:selfAsked', 'withdraw'], [null, null]])
    // Anyone else: who decides is the strip's own words; Take the request back held with why (not theirs; no right to change orders).
    const other = task({ approve: { allowed: false, why: OTHER }, reject: { allowed: false, why: OTHER } })
    expect([kindsOf(doorsOf(yes({ task: other, asked: true, who: 'Finance' }), { approval: askedByOther })), heldOf(doorsOf(yes({ task: other, asked: true, who: 'Finance' }), { approval: askedByOther }))]).toEqual([['withdraw'], ['held.withdrawNotYours']])
    expect(heldOf(doorsOf(yes({ task: other, asked: true }), { approval: askedByOther, depthCan: { manage: false } }))).toEqual(['held.noManage'])
    // Nobody asked yet: Ask for a yes (held with the depth's words for who may not); the yes's read not in: no door to guess.
    expect([kindsOf(doorsOf(yes(), { approval: APPROVAL_NOBODY })), heldOf(doorsOf(yes(), { approval: APPROVAL_NOBODY }))]).toEqual([['ask'], [null]])
    expect(heldOf(doorsOf(yes(), { approval: APPROVAL_NOBODY, depthCan: { manage: false } }))).toEqual(['held.noManage'])
    expect(doorsOf(yes(), { approval: null })).toEqual([])
    // A write running: the approver's yes held with its words.
    expect(heldOf(doorsOf(yes({ task: task(), asked: true }), { busy: true, approval: askedByOther }))).toEqual(['held.busy'])
  })

  it('the credit hold: its override\'s yes the same way (Approve: Credit override + Refuse…); nobody asked: no door here yet (F-OO-106)', () => {
    const credit = task({ kind: 'CREDIT_OVERRIDE', kindLabel: { en: 'Credit override', it: 'Sblocco fido' } })
    expect(kindsOf(doorsOf(yes({ key: 'credit', kind: 'credit', task: credit, asked: true, who: 'Finance' })))).toEqual(['yes:decide'])
    expect(doorsOf(yes({ key: 'credit', kind: 'credit', task: { ...credit, approve: { allowed: false, why: OTHER }, reject: { allowed: false, why: OTHER } }, asked: true, who: 'Finance' }))).toEqual([])
    expect(doorsOf(yes({ key: 'credit', kind: 'credit' }))).toEqual([])
  })

  it('the deposit: Record the payment (held without the finance right, beside Money ›); none asked: Money ›', () => {
    const waiting: WhereStrip = { key: 'deposit', kind: 'deposit', state: 'WAITING', requestId: 'd-1', due: '2026-11-04', since: null }
    expect(doorsOf(waiting)).toEqual([{ kind: 'payment', requestId: 'd-1', held: null }])
    // F-OM-104 (P0-B11): Money › lands on Payments (#payments).
    expect(doorsOf(waiting, { can: abilitiesOf(rolePermissions('sales')) })).toEqual([{ kind: 'payment', requestId: 'd-1', held: { key: 'held.noPayments' } }, { kind: 'tab', tab: 'money', anchor: 'payments' }])
    expect(doorsOf(waiting, { busy: true })).toEqual([{ kind: 'payment', requestId: 'd-1', held: { key: 'held.busy' } }])
    expect(doorsOf({ ...waiting, state: 'MISSING', requestId: null, due: null })).toEqual([{ kind: 'tab', tab: 'money', anchor: 'payments' }])
  })

  it('quality: Release on Quality › — Quality\'s holds of the work order (its work-order filter); none reached: words only', () => {
    expect(doorsOf(hold('quality', [{ id: '0190f0e2-9191-7000-8000-000000000022', number: 'WO-00022' }]))).toEqual([{ kind: 'quality', href: '/w/DEMO/quality/holds?subjectType=WorkOrder&subjectId=0190f0e2-9191-7000-8000-000000000022', number: 'WO-00022' }])
    expect(doorsOf(hold('quality', [], 2))).toEqual([])
  })

  it('production and the pause: Lift… on ONE work order (its row\'s own rule and words); several: Production › holds; only a shared one: its page', () => {
    const row = (id: string, rights: { hold: boolean }) => ({ ...WORK.workOrders[0]!, id, number: 'WO-00021', status: 'ON_HOLD', held: true, version: 7, rights: { manage: rights.hold, release: rights.hold, hold: rights.hold, why: null } })
    const lift = doorsOf(hold('production', [{ id: 'wo-1', number: 'WO-00021' }]), { work: [row('wo-1', { hold: true })] })
    expect(lift).toMatchObject([{ kind: 'lift', label: 'wo.act.lift', held: null, row: { id: 'wo-1' } }])
    expect(doorsOf(hold('pause', [{ id: 'wo-1', number: 'WO-00021' }]), { work: [row('wo-1', { hold: true })] })).toMatchObject([{ kind: 'lift', label: 'wo.liftPause', held: null }])
    // Sales: the row's own words — production does it (a planner or the production manager).
    // F-PT-301 (plan D2 / L9): without the hold right the Lift… door is not drawn (never a grey one) — on Overview as on Production.
    expect(doorsOf(hold('production', [{ id: 'wo-1', number: 'WO-00021' }]), { work: [row('wo-1', { hold: false })], acts: actsCanOf(rolePermissions('sales')) })).toEqual([])
    // Several, or one beside a work order not reached, or the row not read: Production › holds (each row's own Lift; one Lift for N is F-OO-109).
    const tab = [{ kind: 'tab', tab: 'production', anchor: 'holds' }]
    expect(doorsOf(hold('production', [{ id: 'wo-1', number: 'WO-00021' }, { id: 'wo-2', number: 'WO-00022' }]), { work: [row('wo-1', { hold: true })] })).toEqual(tab)
    expect(doorsOf(hold('pause', [{ id: 'wo-1', number: 'WO-00021' }], 1), { work: [row('wo-1', { hold: true })] })).toEqual(tab)
    expect(doorsOf(hold('production', [{ id: 'wo-1', number: 'WO-00021' }]), { work: [] })).toEqual(tab)
    // Only a shared one: its own page (it is lifted there); nothing reached: words only.
    expect(doorsOf(hold('pause', [{ id: 'wo-s', number: 'WO-00019', shared: true }], 1))).toEqual([{ kind: 'workOrder', href: workOrderHref('/w/DEMO', 'wo-s'), number: 'WO-00019' }])
    expect(workOrderHref('/w/DEMO', 'wo-s')).toBe('/w/DEMO/production/work-orders/wo-s')
    expect(doorsOf(hold('pause', [], 1))).toEqual([])
    expect(doorsOf(hold('other', [{ id: 'wo-1', number: 'WO-00021' }]))).toEqual(tab)
  })

  it('the review: Open the review › on its one unit (the review banner\'s own door), held without the measurements right; several: none here', () => {
    const unit = { ...order('PENDING_APPROVAL').lines[0]!, kind: 'MADE_TO_MEASURE', rider: { profileId: 'p-1', name: 'Demo Rider', garmentType: 'JACKET', revision: 2 } }
    const one = { ...order('PENDING_APPROVAL'), lines: [unit] }
    const review: WhereStrip = { key: 'review', kind: 'review', count: 1, since: null }
    expect(doorsOf(review, { order: one })).toEqual([{ kind: 'review', href: '/w/DEMO/sales/made-to-measure/p-1?do=review', held: null }])
    expect(doorsOf(review, { order: one, can: abilitiesOf(rolePermissions('finance')) })).toEqual([{ kind: 'review', href: null, held: { key: 'where.strip.reviewDoor.noRight' } }])
    expect(doorsOf(review, { order: { ...one, lines: [unit, { ...unit, id: 'line-2' }] } })).toEqual([])
  })

  it('Read-only: words only — no door on any strip; never more than 3 buttons in a strip', () => {
    const strips: WhereStrip[] = [
      yes({ task: task(), asked: true }),
      yes({ key: 'credit', kind: 'credit', task: task({ kind: 'CREDIT_OVERRIDE' }), asked: true }),
      { key: 'review', kind: 'review', count: 1, since: null },
      { key: 'deposit', kind: 'deposit', state: 'WAITING', requestId: 'd-1', due: null, since: null },
      hold('quality', [{ id: 'wo-1', number: 'WO-00021' }]),
      hold('production', [{ id: 'wo-1', number: 'WO-00021' }, { id: 'wo-2', number: 'WO-00022' }]),
      hold('pause', [{ id: 'wo-s', number: 'WO-00019', shared: true }]),
    ]
    const readOnly = rolePermissions('read_only')
    for (const strip of strips) expect(stripDoorsOf(strip, input({ readOnly: true, can: abilitiesOf(readOnly), acts: actsCanOf(readOnly), approval: APPROVAL_NOBODY })), strip.key).toEqual([])
    // Every door list this block made: the budget of the plan (at most 3 visible buttons per row group, F8).
    expect(all.length).toBeGreaterThan(10)
    for (const doors of all) expect(buttons(doors), JSON.stringify(kindsOf(doors))).toBeLessThanOrEqual(3)
  })

  it('the words exist in both languages, office "tu" in Italian', () => {
    const KEYS = ['where.strips', 'where.strip.yes.waits', 'where.strip.yes.asked', 'where.strip.yes.nobody', 'where.strip.credit.waits', 'where.strip.credit.asked' /* walk #2 */, 'where.strip.credit.nobody', 'where.strip.reviewUnits', 'where.strip.reviewDoor.open', 'where.strip.reviewDoor.noRight', 'where.strip.reviewDoor.several', 'where.strip.deposit.waiting', 'where.strip.deposit.overdue', 'where.strip.deposit.open', 'where.strip.quality', 'where.strip.qualityPlain', 'where.strip.production', 'where.strip.productionPlain', 'where.strip.pause', 'where.strip.andMore', 'where.strip.qualityWho', 'where.strip.release', 'where.strip.releaseOf', 'where.strip.openWo', 'where.strip.failed']
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of KEYS) expect(t(key, { who: 'X', date: 'D', reasons: 'R', numbers: 'N', number: 'N', count: 2 }), `${locale} ${key}`).not.toBe(key)
      // F-CO-K2: "Show {n} more" / "Show fewer" are the shared overview kit's words now (its Strips part says them); the order's went.
      const kit = createTranslator(locale, messagesFor(locale, ['record-overview'])['record-overview']!)
      for (const key of ['strips.showMore', 'strips.showFewer']) expect(kit(key, { count: 2 }), `${locale} ${key}`).not.toBe(key)
      for (const key of ['where.strip.showMore', 'where.strip.showFewer']) expect(t(key, { count: 2 }), `${locale} ${key}`).toBe(key)
      for (const key of ['where.strip.review', 'where.strip.on', 'where.strip.notReached', 'where.strip.onlyNotReached', 'where.strip.shared']) for (const count of [1, 2]) expect(t(key, { count, numbers: 'N' }), `${locale} ${key} ${count}`).not.toBe(key)
    }
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    const it = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect(en('where.strip.on', { count: 2, numbers: 'WO-00021, WO-00022' })).toBe('on 2 work orders: WO-00021, WO-00022')
    expect(it('where.strip.on', { count: 1, numbers: 'WO-00021' })).toBe('su 1 ordine di lavoro: WO-00021')
    expect([en('where.strip.notReached', { count: 1 }), it('where.strip.notReached', { count: 1 })]).toEqual(['and 1 work order outside what you can open', 'e 1 ordine di lavoro fuori da ciò che puoi aprire'])
    expect([en('where.strip.credit.waits', { who: 'Finance' }), it('where.strip.credit.waits', { who: 'Finance' })]).toEqual(["Credit hold — waits for Finance's yes", 'Blocco fido — aspetta il sì di Finance'])
    // Walk #2: asked of someone this reader cannot name — the yes strip's own words ("a yes that is asked"), never "nobody asked".
    expect([en('where.strip.credit.asked'), it('where.strip.credit.asked')]).toEqual(['Credit hold — waits for a yes that is asked', 'Blocco fido — aspetta un sì già chiesto'])
    expect([en('where.strip.release'), it('where.strip.release')]).toEqual(['Release on Quality ›', 'Sblocca in Qualità ›'])
    // Office "tu": the Italian never says "voi" / "vostro" (the portal's).
    const strip = itWordsUnder('where.')
    expect(strip).not.toMatch(/\b(?:voi|vostr[oaie])\b/i)
  })
})

describe('F-OO-105: the strips drawn — the yes for its approver, asker and anyone else; the holds for the Owner, Sales and Read-only', () => {
  const view = designScreen.view as ComponentType<{ model: unknown }>
  const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
  /** The strips' own markup (section 1's list). */
  const stripsOf = (html: string): string => {
    const from = html.indexOf('class="fw-so-strips"')
    return from < 0 ? '' : html.slice(from, html.indexOf('</ul>', from))
  }

  it('the yes: the approver gets Confirm the order and Refuse…; the asker the held yes and Take the request back; anyone else who decides', () => {
    const approver = stripsOf(draw('f-op-101-approver-yes'))
    expect(textOf(approver)).toContain("Waits for Finance's yes")
    for (const words of ['Confirm the order', 'Refuse…']) expect(textOf(approver), words).toContain(words)
    expect(approver).toMatch(/<time datetime="2026-11-18T09:30:00Z"/i)
    const asker = stripsOf(draw('f-op-101-self-asked'))
    expect(asker).toContain('aria-description="You asked for this yes: another person decides"')
    expect(textOf(asker)).toContain('Take the request back')
    const other = stripsOf(draw('f-op-101-who-decides'))
    expect(textOf(other)).toContain("Waits for Finance's yes")
    expect(textOf(other)).not.toContain('Confirm the order')
    // Its Take back is held with why (only the asker; the production manager changes no order).
    expect(other).toMatch(/aria-disabled="true"[^>]*aria-description="Changing an order needs the sales right to manage orders"[^>]*>Take the request back/)
    const it = textOf(stripsOf(draw('f-op-101-approver-yes', 'it')))
    for (const words of ['Aspetta il sì di Finance', 'Conferma l', 'Rifiuta']) expect(it, words).toContain(words)
  })

  it('the holds (Owner): one strip per kind with its work orders, who releases quality, the shared one and the one not reached; each its door', () => {
    const html = stripsOf(draw('f-oo-105-holds'))
    const text = textOf(html)
    for (const words of ['Quality hold — Shade difference on the leather', 'on 1 work order: WO-00022', 'Quality releases it: a quality inspector or the Owner, with a code', 'Release on Quality ›', 'Production hold — Leather check with the tannery', 'on 1 work order: WO-00021', 'Lift the hold…', "Paused at the customer's request", 'on 2 work orders: WO-00019 and 1 work order outside what you can open', "WO-00019 also makes another customer's work: it is lifted on its own page", 'Open WO-00019 ›']) expect(text, words).toContain(words)
    // Most blocking first: quality, production, the customer's pause.
    const at = ['Quality hold', 'Production hold', 'Paused at the customer'].map((words) => text.indexOf(words))
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(html).toContain('href="/w/DEMO/quality/holds?subjectType=WorkOrder&amp;subjectId=')
    expect(html).toContain('aria-label="Release on Quality: the holds of WO-00022"')
    expect(html).toMatch(/data-tone="danger"/)
    // The Owner may lift: the button is live.
    expect(html).not.toMatch(/aria-description="[^"]*"[^>]*>Lift the hold…/)
    const it = textOf(stripsOf(draw('f-oo-105-holds', 'it')))
    for (const words of ['Blocco qualità — Differenza di tonalità della pelle', 'su 1 ordine di lavoro: WO-00022', 'Sblocca in Qualità ›', 'Fermo di produzione — Verifica della pelle con la conceria', 'Togli il blocco…', 'In pausa su richiesta del cliente', 'e 1 ordine di lavoro fuori da ciò che puoi aprire', 'Apri WO-00019 ›']) expect(it, words).toContain(words)
  })

  // Plan D2 / L9 (F-PT-301): hidden without the right, on Overview too — Sales sees no Lift door (never a grey one) and ONE line says
  // who does it; Read-only reads the same words without that line and without any button.
  it('Sales: no Lift the hold… (hidden), one line says who does it; Read-only: the same words, no button at all (and the deposit, the credit, "Show 1 more")', () => {
    const sales = stripsOf(draw('f-oo-105-holds-sales'))
    expect(sales).not.toMatch(/>Lift the hold…/)
    expect(sales).not.toMatch(/aria-disabled="true"[^>]*>Lift/)
    expect(textOf(sales)).toContain('Production does this — a planner or the production manager')
    const readOnly = stripsOf(draw('f-oo-105-read-only'))
    expect(textOf(readOnly)).toContain('Quality hold — Shade difference on the leather')
    expect(readOnly).not.toContain('<button')
    expect(readOnly).not.toContain('<a ')
    // The deposit: Finance records it; the production manager reads it held beside Money ›.
    const finance = stripsOf(draw('f-oo-105-deposit'))
    expect(textOf(finance)).toContain('Deposit not paid yet · due 04/11/2026')
    // F-OM-204 (the lead's one word): the same dialog as Money's row — "Record a payment" on both.
    expect(finance).toMatch(/<button[^>]*>Record a payment<\/button>/)
    const manager = stripsOf(draw('f-oo-105-deposit-manager'))
    expect(manager).toMatch(/aria-description="Recording payments needs the finance right"[^>]*>Record a payment/)
    expect(textOf(manager)).toContain('Money ›')
    // The credit hold's yes for its approver.
    const credit = textOf(stripsOf(draw('f-oo-105-credit')))
    for (const words of ["Credit hold — waits for Finance's yes", 'Approve: Credit override', 'Refuse…']) expect(credit, words).toContain(words)
    // Five strips: four drawn, "Show 1 more" under them.
    const more = draw('f-oo-105-more')
    expect(stripsOf(more).match(/<li class="fw-so-ov-row fw-so-strip"/g) ?? []).toHaveLength(4)
    expect(textOf(more)).toContain('Show 1 more')
  })

  it('source: the yes door is DepthBand\'s YesDoorView (imported, never copied); Lift is the row\'s own act; the strips read the ONE waiting list', () => {
    const card = readFileSync(new URL('../view/overview/WhereCard.tsx', import.meta.url), 'utf8') + readFileSync(new URL('../view/overview/StripRow.tsx', import.meta.url), 'utf8') /* F-PT-301: the strip row moved to its own file */
    expect(card).toContain("import { YesDoorView } from '../../../depth/view/DepthBand'")
    expect(card).toContain('<YesDoorView door={door.door} onYes={actions?.yes} />')
    expect(card).toContain("actions?.workOrderActs?.onAct?.(door.row, 'lift')")
    expect(card).toContain("actions?.onDialog?.({ kind: 'depositPayment', requestId: door.requestId })")
    expect(card).toContain('whereStripsOf(order, read, approval, waiting)')
    // where.ts takes the yes rule from the depth (yesDoorOf, askHeld, withdrawHeld) and the Lift rule from the row's acts — no copy.
    const rules = readFileSync(new URL('./where.ts', import.meta.url), 'utf8')
    for (const part of ["from '../../depth/model'", 'rowActsOf(row, input.acts)', 'yesDoorOf(strip.task, input.busy)', "holdsAddress({ view: 'open', subjectType: 'WorkOrder', subjectId: first.id })"]) expect(rules, part).toContain(part)
    // The strips' CSS: DS tone tokens only (light and dark), no raw colour. F-CO-K2: it moved to the shared overview kit's ONE
    // stylesheet (the strips are its Strips / Strip parts); where.css keeps none of it.
    const css = readFileSync(new URL('../../../../../lib/record-overview/record-overview.css', import.meta.url), 'utf8')
    for (const rule of ['.fw-so-strips {', '.fw-so-strip {', ".fw-so-strip[data-tone='danger'] {", '.fw-so-strip-said {']) expect(css, rule).toContain(rule)
    expect(css).toContain('var(--nds-danger)')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
    const where = readFileSync(new URL('../view/overview/where.css', import.meta.url), 'utf8')
    for (const rule of ['.fw-so-strips {', '.fw-so-strip {', ".fw-so-strip[data-tone='danger'] {", '.fw-so-strip-said {']) expect(where, rule).not.toContain(rule)
  })
})
// ---- end F-OO-105

// ---- F-OO-107 (order overview §1.5; review F8): the moves row — the order's own moves only, each held by the band's own rule ----
describe('F-OO-107: the moves row — Mark ready…, More ▾ (made elsewhere, Cancel, Close): status × role, the band\'s own held words', () => {
  const ROLES = { Owner: 'owner', Sales: 'sales', Planner: 'planner', Warehouse: 'warehouse', 'Read-only': 'read_only' } as const
  type RoleName = keyof typeof ROLES
  /** The order at a state as the API lists its actions (B-OO-003: a waiting order may be cancelled too — F-OO-110: the demo lists it). */
  const at = (status: OrderStatus): Order => order(status)
  const movesOf = (status: OrderStatus, role: RoleName) => {
    const permissions = rolePermissions(ROLES[role])
    const can = abilitiesOf(permissions)
    const value = at(status)
    // As the card: Read-only by the band's rule; the made-elsewhere door held by its container's own rule.
    const readOnly = readOnlyOnPage(can, { assignSupervisor: permissions.includes('production.brand.manage'), qualityHold: permissions.includes('quality.holds.place') })
    return { value, can, permissions, readOnly, moves: whereMovesOf(value, { can, readOnly, elsewhere: { held: elsewhereDoor(value, permissions) } }) }
  }
  const ids = (moves: ReturnType<typeof whereMovesOf>) => (moves ? [moves.shown.map((move) => move.id), moves.more.map((move) => move.id)] : null)
  // F-OO-108: a held move's words are a phrase (its key) or the hold plan's own words (said by their English here).
  const heldOf = (moves: ReturnType<typeof whereMovesOf>, id: (typeof WHERE_MOVES)[number]) => {
    const held = [...(moves?.shown ?? []), ...(moves?.more ?? [])].find((move) => move.id === id)?.held ?? null
    return held ? ('key' in held ? held.key : held.en) : null
  }
  /** [in view, under More ▾] per state, for every role that changes anything on the page. */
  // F-OO-108: Hold the whole order… is in view while there is work it may stop (confirmed to partly shipped).
  const BY_STATUS: Readonly<Record<OrderStatus, readonly [string[], string[]] | null>> = {
    PENDING_APPROVAL: [[], ['cancel']],
    CONFIRMED: [['hold'], ['elsewhere', 'cancel']],
    IN_PRODUCTION: [['ready', 'hold'], ['elsewhere', 'cancel']],
    READY: [['hold'], ['elsewhere', 'cancel']],
    PARTLY_SHIPPED: [['hold'], ['elsewhere']],
    SHIPPED: [[], ['close']],
    DELIVERED: [[], ['close']],
    CLOSED: null,
    CANCELLED: null,
  }

  it('status × role (Owner, Sales, Planner, Warehouse, Read-only): which moves, where; Read-only sees none; never more than 3 in view', () => {
    for (const status of ORDER_STATUSES) {
      for (const role of Object.keys(ROLES) as RoleName[]) {
        const { moves, readOnly } = movesOf(status, role)
        if (role === 'Read-only') {
          expect(readOnly, status).toBe(true)
          expect(moves, `${status} ${role}`).toBeNull()
          continue
        }
        expect(readOnly, `${status} ${role}`).toBe(false)
        expect(ids(moves), `${status} ${role}`).toEqual(BY_STATUS[status])
        if (moves) expect(moves.shown.length + (moves.more.length > 0 ? 1 : 0), `${status} ${role}`).toBeLessThanOrEqual(3)
      }
    }
    // The labels are the band's own words; Make work orders…, Create shipment…, Change promise and the yes are never here (F8).
    const { moves } = movesOf('IN_PRODUCTION', 'Owner')
    expect([...moves!.shown, ...moves!.more].map((move) => move.label.key)).toEqual(['action.ready', 'where.hold.label', 'elsewhere.title', 'action.cancel'])
    expect(WHERE_MOVES).toEqual(['ready', 'hold', 'elsewhere', 'cancel', 'close'])
  })

  it('parity: each move\'s held words are the band\'s own function\'s (readyHeld, cancelHeld, closeHeld, the made-elsewhere door)', () => {
    for (const status of ORDER_STATUSES) {
      for (const role of ['Owner', 'Sales', 'Planner', 'Warehouse'] as const) {
        const { value, can, permissions, moves } = movesOf(status, role)
        for (const move of [...(moves?.shown ?? []), ...(moves?.more ?? [])]) {
          // F-OO-108: Hold the whole order… is held by the hold plan (here no work part is read: still being read).
          const band = move.id === 'ready' ? readyHeld(value, can) : move.id === 'cancel' ? cancelHeld(value, can) : move.id === 'close' ? closeHeld(value, can) : move.id === 'hold' ? holdOrderMoveOf(value, undefined, null)!.held : elsewhereDoor(value, permissions)
          expect(move.held, `${status} ${role} ${move.id}`).toEqual(band)
        }
      }
    }
    // What each reader reads, in words: Sales marks ready and cancels, a shipment made elsewhere is the warehouse's; the planner and
    // the warehouse change no order (the band hides Cancel from them: here it is held with why); closing unsettled needs orders.close.
    expect(['ready', 'elsewhere', 'cancel'].map((id) => heldOf(movesOf('IN_PRODUCTION', 'Sales').moves, id as never))).toEqual([null, 'elsewhere.held.noRight', null])
    expect(['ready', 'elsewhere', 'cancel'].map((id) => heldOf(movesOf('IN_PRODUCTION', 'Planner').moves, id as never))).toEqual(['held.noManage', 'elsewhere.held.noRight', 'held.noManage'])
    expect(['ready', 'elsewhere', 'cancel'].map((id) => heldOf(movesOf('IN_PRODUCTION', 'Warehouse').moves, id as never))).toEqual(['held.noManage', null, 'held.noManage'])
    expect([heldOf(movesOf('SHIPPED', 'Owner').moves, 'close'), heldOf(movesOf('SHIPPED', 'Sales').moves, 'close')]).toEqual([null, 'held.notSettled'])
    // A waiting order is cancelled too (B-OO-003), from the same dialog.
    expect(heldOf(movesOf('PENDING_APPROVAL', 'Sales').moves, 'cancel')).toBeNull()
    // No elsewhere door offered here (a design case without its container): no item for it.
    expect(whereMovesOf(order('IN_PRODUCTION'), { can: abilitiesOf(rolePermissions('owner')), readOnly: false, elsewhere: null })!.more.map((move) => move.id)).toEqual(['cancel'])
  })

  it('source: built from the band\'s own functions (none changes here); the same dialogs as the band; the made-elsewhere dialog drawn here', () => {
    const rules = readFileSync(new URL('./where.ts', import.meta.url), 'utf8')
    expect(rules).toContain("import { cancelHeld, closeHeld, isShippedInFull, readyHeld } from '../../model'")
    expect(rules).toContain("import { CANCEL_STATUSES } from '@nexus/factory-domain/sales/orders/orders'")
    expect(rules).not.toMatch(/function (?:readyHeld|cancelHeld|closeHeld|nextStep)\b/)
    // Make work orders… and Create shipment… make the next record (Linked records, the band): never in section 1's moves.
    const from = rules.indexOf('export function whereMovesOf(')
    const moves = rules.slice(from, rules.indexOf('// ---- end F-OO-107', from))
    expect(moves).toContain('readyHeld(order, input.can)')
    for (const gone of ['makeHeldOf', 'makeWorkOrders', 'createShipment', 'promise']) expect(moves, gone).not.toContain(gone)
    const card = readFileSync(new URL('../view/overview/WhereCard.tsx', import.meta.url), 'utf8')
    for (const part of ['actions?.onDialog?.({ kind: id })', 'actions?.onRecordElsewhere?.()', "'aria-label': t('where.moreOf', { number: order.number })"]) expect(card, part).toContain(part)
    // F-OO-111: the made-elsewhere dialog is the page's, mounted once (OrderRecordView): the band's ⋯ opens it on every tab.
    expect(card).not.toContain('{model.elsewhere?.dialog}')
    expect(card.indexOf('<Moves ')).toBeGreaterThan(card.indexOf('F-OO-103: the moves slot'))
  })

  it('drawn: under the stages, Mark ready… and More ▾ (its name says the order); held with the band\'s words; Read-only and a cancelled order: no row', () => {
    const view = designScreen.view as ComponentType<{ model: unknown }>
    const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
    const html = draw('overview')
    const row = html.slice(html.indexOf('class="fw-so-where-moves"'), html.indexOf('</div>', html.indexOf('class="fw-so-where-moves"')))
    // F-MS-101 (R21) / F-SC-W1: the quiet line's words; the moves row still comes after it (the door is not a move).
    expect(html.indexOf('Stages are set by the floor and quality, or by hand when their records are wrong or missing')).toBeGreaterThan(-1)
    expect(html.indexOf('class="fw-so-where-moves"')).toBeGreaterThan(html.indexOf('Stages are set by the floor and quality, or by hand when their records are wrong or missing'))
    expect(row).toMatch(/<button[^>]*>Mark ready…<\/button>/)
    expect(row).toContain('aria-label="More moves for SO-2026-0088"')
    expect(textOf(row)).toContain('More')
    // The production manager changes no order: Mark ready… held with the band's words.
    expect(draw('f-op-301-so2-overview')).toMatch(/aria-disabled="true"[^>]*aria-description="Changing an order needs the sales right to manage orders"[^>]*>Mark ready…/)
    for (const id of ['f-oo-105-read-only', 'f-oo-102-cancelled']) expect(draw(id), id).not.toContain('fw-so-where-moves')
    // Shipped: no Mark ready…; Close order… waits under More ▾.
    const shipped = draw('f-oo-102-shipped')
    expect(shipped).toContain('class="fw-so-where-moves"')
    expect(shipped).not.toContain('>Mark ready…<')
    const it = draw('overview', 'it')
    expect(it).toMatch(/<button[^>]*>Segna come pronto…<\/button>/)
    expect(it).toContain('aria-label="Altre azioni per SO-2026-0088"')
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['where.moves', 'where.more', 'where.moreOf']) expect(t(key, { number: 'SO-1' }), `${locale} ${key}`).not.toBe(key)
    }
  })
})
// ---- end F-OO-107

// ---- F-OO-106 (order overview §1.3, §1.4; review F8, F16; B-OO-004): the order's own credit hold, decided from its strip ------------
describe('F-OO-106: the credit strip — Check credit again, Ask for a yes… only when one may be asked, the last no, who checks it', () => {
  const CHECK = '0190f0e2-9797-7000-8000-000000000001'
  const customer = (over: Partial<CreditCustomer> = {}, held: Partial<NonNullable<CreditCustomer['held']>> = {}): CreditCustomer => ({
    party: { id: 'p-1', code: 'MOTO-DEMO', name: 'Moto Demo S.r.l.' },
    onHold: false,
    findings: ['OVER_LIMIT'],
    held: { checkId: CHECK, step: 'ORDER', checkedAt: '2026-11-10T09:00:00Z', request: null, lastAnswer: null, ...held },
    may: { checkAgain: true, ask: true },
    ...over,
  })
  const read = (value: CreditCustomer | null, problem: string | null = null): CreditState => ({ view: true, record: { value, problem } })
  const task = (over: Partial<OpenApproval> = {}): OpenApproval => ({ taskId: 't-c', kind: 'CREDIT_OVERRIDE', kindLabel: { en: 'Credit override', it: 'Sblocco fido' }, requestedAt: '2026-11-18T09:30:00Z', requester: { name: 'Luca Prova', me: false }, approver: { kind: 'ROLE', name: 'Finance', me: false }, version: 1, requireStepUp: false, approve: { allowed: true, why: null }, reject: { allowed: true, why: null }, withdraw: { allowed: false, why: null }, ...over })
  const strip = (over: Partial<Extract<WhereStrip, { kind: 'yes' | 'credit' }>> = {}): WhereStrip => ({ key: 'credit', kind: 'credit', task: null, asked: false, who: null, since: null, ...over })
  const owner = rolePermissions('owner')
  const input = (over: Partial<StripDoorsInput> = {}): StripDoorsInput => ({ prefix: '/w/DEMO', order: order('PENDING_APPROVAL'), can: abilitiesOf(owner), readOnly: false, busy: false, approval: null, depthCan: { manage: true }, work: [], acts: actsCanOf(owner), ...over })
  const kinds = (doors: readonly StripDoor[]) => doors.map((door) => (door.kind === 'yes' ? `yes:${door.door.kind}` : door.kind))

  it('may → shown / held: Check credit again (held without the credit right), Ask for a yes… only when may.ask; never beside an open yes', () => {
    expect(creditDoorsOf(read(customer()), null)).toEqual([{ kind: 'creditCheck', held: null }, { kind: 'creditAsk', checkId: CHECK, held: null }])
    // F8: no Ask unless one may be asked (a yes open on the hold, or no right to ask): it is never shown held.
    expect(creditDoorsOf(read(customer({ may: { checkAgain: true, ask: false } })), null)).toEqual([{ kind: 'creditCheck', held: null }])
    expect(creditDoorsOf(read(customer({ may: { checkAgain: false, ask: false } })), null)).toEqual([{ kind: 'creditCheck', held: { key: 'where.credit.held.noRight' } }])
    expect(creditDoorsOf(read(customer()), { key: 'held.busy' })).toEqual([{ kind: 'creditCheck', held: { key: 'held.busy' } }, { kind: 'creditAsk', checkId: CHECK, held: { key: 'held.busy' } }])
    // Not read (no right; still reading), nothing held any more: no door; the read failed: Try again.
    expect(creditDoorsOf({ view: false, record: null }, null)).toEqual([])
    expect(creditDoorsOf({ view: true, record: null }, null)).toEqual([])
    expect(creditDoorsOf(read(null), null)).toEqual([])
    expect(creditDoorsOf(read(customer({ held: null })), null)).toEqual([])
    expect(creditDoorsOf(read(null, 'problem.read.unavailable'), null)).toEqual([{ kind: 'creditRetry' }])
    expect(creditDoorsOf(null, null)).toEqual([])
    // On the strip, after the override's yes: the approver — Approve, Refuse…, Check credit again (3 buttons, F8); no Ask beside it.
    const approver = stripDoorsOf(strip({ task: task(), asked: true, who: 'Finance' }), input({ credit: read(customer({ may: { checkAgain: true, ask: false } }, { request: { taskId: 't-c', status: 'PENDING', approver: 'Finance', requestedAt: '2026-11-18T09:30:00Z', dueAt: null } })) }))
    expect(kinds(approver)).toEqual(['yes:decide', 'creditCheck'])
    // Nobody asked (Finance said no): Check credit again and Ask for a yes…; Read-only: no door at all.
    expect(kinds(stripDoorsOf(strip(), input({ credit: read(customer()) })))).toEqual(['creditCheck', 'creditAsk'])
    expect(stripDoorsOf(strip(), input({ readOnly: true, credit: read(customer()) }))).toEqual([])
    // A write of the page runs: both held with its words.
    expect(stripDoorsOf(strip(), input({ busy: true, credit: read(customer()) }))).toEqual([{ kind: 'creditCheck', held: { key: 'held.busy' } }, { kind: 'creditAsk', checkId: CHECK, held: { key: 'held.busy' } }])
  })

  it('the credit is read only while the order waits on its own credit hold', () => {
    const waiting = order('PENDING_APPROVAL')
    expect(creditHoldWaits(waiting)).toBe(false)
    expect(creditHoldWaits(waiting, { creditHold: { checkId: CHECK, requestTaskId: null } })).toBe(true)
    expect(creditHoldWaits({ ...waiting, openApprovals: [task()] })).toBe(true)
    expect(creditHoldWaits({ ...waiting, waits: ['CREDIT_HOLD'] })).toBe(true)
    // A release held by the credit while the order is in work: that hold is the work order's, not the order's (no read).
    expect(creditHoldWaits({ ...order('IN_PRODUCTION'), openApprovals: [task()] })).toBe(false)
  })

  it('409 "checked meanwhile" (the check id is the lock), "Nobody to ask", no rule any more, asked already — each in words', () => {
    const conflict = (message: string | null, code = 'conflict') => new ApiError('conflict', 409, code, 'x', null, message ? [{ path: 'credit', message }] : [])
    expect(creditRefusalOf(conflict('Checked meanwhile.'))).toEqual({ key: 'where.credit.refused.meanwhile' })
    // A newer check, or the hold gone (invalid_state, no issue): checked meanwhile too.
    expect(creditRefusalOf(conflict(null, 'invalid_state'))).toEqual({ key: 'where.credit.refused.meanwhile' })
    expect(creditRefusalOf(conflict('Nobody to ask.'))).toEqual({ key: 'where.credit.refused.nobody' })
    expect(creditRefusalOf(conflict('No rule.'))).toEqual({ key: 'where.credit.refused.noRule' })
    expect(creditRefusalOf(conflict('Asked already.'))).toEqual({ key: 'where.credit.refused.asked' })
    expect(creditRefusalOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ key: 'where.credit.held.noRight' })
    expect(creditRefusalOf(new ApiError('unavailable', 0, 'network', 'x'))).toEqual({ key: 'problem.write.unavailable' })
    // The "Nobody to ask" words, both languages (office "tu").
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    const it = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect(en('where.credit.refused.nobody')).toBe('No credit rule names someone else who may say yes: the customer pays, or Finance raises the limit.')
    expect(it('where.credit.refused.nobody')).toBe("Nessuna regola del fido indica un'altra persona che può dire sì: il cliente paga, oppure l'Amministrazione alza il fido.")
    expect([en('where.credit.refused.meanwhile'), it('where.credit.refused.meanwhile')]).toEqual(['It was checked meanwhile: the credit was read again', 'È stato controllato nel frattempo: il fido è stato riletto'])
  })

  it('the lastAnswer line: "{who} said no on {date}" (the reason only when sent: the price grain), taken back; who checks it without the right', () => {
    const at = '2026-11-18T10:00:00Z'
    const no = (reason?: string | null, by: string | null = 'Marco Demo') => creditLinesOf(read(customer({ findings: [] }, { lastAnswer: { status: 'REJECTED', at, by, ...(reason === undefined ? {} : { reason }) } })), true)
    expect(no()).toEqual([{ phrase: { key: 'where.credit.saidNo', params: { who: 'Marco Demo' } }, date: at }])
    expect(no(null)).toEqual([{ phrase: { key: 'where.credit.saidNo', params: { who: 'Marco Demo' } }, date: at }])
    expect(no('Two invoices are overdue')).toEqual([{ phrase: { key: 'where.credit.saidNoWhy', params: { who: 'Marco Demo', reason: 'Two invoices are overdue' } }, date: at }])
    expect(no(undefined, null)).toEqual([{ phrase: { key: 'where.credit.saidNoSomeone' }, date: at }])
    const back = (by: string | null) => creditLinesOf(read(customer({ findings: [] }, { lastAnswer: { status: 'WITHDRAWN', at, by, reason: null } })), true)
    expect(back('Luca Prova')).toEqual([{ phrase: { key: 'where.credit.takenBack', params: { who: 'Luca Prova' } }, date: at }])
    expect(back(null)).toEqual([{ phrase: { key: 'where.credit.takenBackSystem' }, date: at }])
    // What the check found, in words (the customer on hold named once: D6 — the credit strip names it when it is the cause).
    expect(creditLinesOf(read(customer({ findings: ['OVER_LIMIT'], onHold: true })), true)).toEqual([{ phrase: { key: 'where.credit.found' }, findings: ['OVER_LIMIT', 'ON_HOLD'] }])
    expect(creditLinesOf(read(customer({ findings: ['ON_HOLD'], onHold: true })), true)).toEqual([{ phrase: { key: 'where.credit.found' }, findings: ['ON_HOLD'] }])
    // No credit right: who checks it, in words; the read failed: said; still reading or not waiting: nothing.
    expect(creditLinesOf({ view: false, record: null }, true)).toEqual([{ phrase: { key: 'where.credit.whoDecides' } }])
    expect(creditLinesOf(read(null, 'problem.read.unavailable'), true)).toEqual([{ phrase: { key: 'where.credit.failed' } }])
    expect(creditLinesOf(read(null), true)).toEqual([])
    expect(creditLinesOf(read(customer()), false)).toEqual([])
    // What a no does, beside a yes decided here: the credit's leaves it held, the order's cancels it; nothing for anyone else.
    const decide = stripDoorsOf(strip({ task: task(), asked: true }), input())
    expect(refuseLineOf(strip({ task: task(), asked: true }), decide)).toEqual({ key: 'where.refuse.credit' })
    expect(refuseLineOf(strip({ key: 'yes', kind: 'yes', task: task({ kind: 'SALES_ORDER' }), asked: true }), decide)).toEqual({ key: 'where.refuse.order' })
    expect(refuseLineOf(strip(), stripDoorsOf(strip(), input({ credit: read(customer()) })))).toBeNull()
  })

  it('the answer notices: passed — confirmed (or still waits for its other step); still held — a yes asked of whom, or nobody may say yes', () => {
    const answer = (result: 'PASS' | 'WARN' | 'HOLD', asked: boolean, orderGoesOn: boolean) => ({ checkId: 'c-2', result, asked, orderGoesOn })
    expect(creditCheckNoticeOf(answer('PASS', false, true), null)).toEqual({ tone: 'success', words: { key: 'where.credit.passed' } })
    expect(creditCheckNoticeOf(answer('WARN', false, false), null)).toEqual({ tone: 'success', words: { key: 'where.credit.passedWaits' } })
    expect(creditCheckNoticeOf(answer('HOLD', true, false), 'Finance')).toEqual({ tone: 'info', words: { key: 'where.credit.stillAsked', params: { who: 'Finance' } } })
    expect(creditCheckNoticeOf(answer('HOLD', true, false), null)).toEqual({ tone: 'info', words: { key: 'where.credit.stillAskedSomeone' } })
    expect(creditCheckNoticeOf(answer('HOLD', false, false), null)).toEqual({ tone: 'warning', words: { key: 'where.credit.stillNobody' } })
    expect(creditAskNoticeOf('Finance')).toEqual({ tone: 'success', words: { key: 'where.credit.asked', params: { who: 'Finance' } } })
    expect(creditAskNoticeOf(null)).toEqual({ tone: 'success', words: { key: 'where.credit.askedSomeone' } })
  })

  it('walk #2: the credit part reads the yes\'s read — a hold the order read does not name is seen; without the credit right, who decides', () => {
    // The order read sends no `waits`, and no CREDIT_OVERRIDE task this reader may see: only the yes's read names the hold.
    const value: Order = { ...order('PENDING_APPROVAL'), openApprovals: [] }
    const hold = { creditHold: { checkId: CHECK, requestTaskId: 't-hidden' } }
    const base = { api: {} as unknown as ApiClient, orderId: value.id, current: { current: value }, version: () => value.version, setNotice: () => undefined, load: async () => undefined, loadParts: () => undefined, write: async () => undefined } as unknown as RecordActsBase
    const creditOf = (permissions: readonly string[], approval: typeof hold | null): CreditState | null | undefined => {
      let credit: CreditState | null | undefined
      function Harness() {
        credit = useOverviewActs({ base, credit: { permissions, approval } }).model.credit
        return null
      }
      render(createElement(Harness), 'en')
      return credit
    }
    // Production, Warehouse (no credit right): the strip's "who decides" line (creditLinesOf); nothing is read.
    expect(creditOf([], hold)).toEqual({ view: false, record: null })
    expect(creditLinesOf(creditOf([], hold) ?? null, true)).toEqual([{ phrase: { key: 'where.credit.whoDecides' } }])
    // Sales or Finance (the credit right): the hold's credit is read (keyed: its read starts on mount).
    expect(creditOf(['sales.credit.view'], hold)).toEqual({ view: true, record: null })
    // The yes's read not there yet (or failed): no hold claimed.
    expect(creditOf([], null)).toBeNull()
  })

  it('the hook: Check credit again and Ask send no version (the check id is the lock), through the page\'s one write; a refusal stays in the dialog', async () => {
    const value: Order = { ...order('PENDING_APPROVAL'), openApprovals: [] }
    const after = customer({ may: { checkAgain: true, ask: false } }, { request: { taskId: 't-new', status: 'PENDING', approver: 'Finance', requestedAt: '2026-11-20T09:00:00Z', dueAt: null } })
    const run = async (act: 'check' | 'ask', answer: () => Promise<unknown>) => {
      const calls: { method: string; path: string; body?: unknown; key?: unknown }[] = []
      const dialogs: (RecordDialog | null)[] = []
      const notices: unknown[] = []
      const writes: { success: unknown; keep: unknown; answered?: unknown }[] = []
      const rereads: string[] = []
      const api = {
        post: (path: string, options: { body: unknown; idempotencyKey?: unknown }) => (calls.push({ method: 'POST', path, body: options.body, key: options.idempotencyKey }), answer()),
        get: async (path: string) => (calls.push({ method: 'GET', path }), { record: { type: 'SalesOrder', id: value.id, label: value.number, step: 'ORDER' }, customers: [after], readAt: '2026-11-20T09:00:00Z' }),
      } as unknown as ApiClient
      const base = {
        api,
        orderId: value.id,
        current: { current: value },
        version: () => value.version,
        setNotice: (notice: unknown) => notices.push(notice),
        load: async () => undefined,
        loadParts: () => undefined,
        write: async (task: () => Promise<Order | null>, success: string | null, keep?: boolean) => {
          const entry: { success: unknown; keep: unknown; answered?: unknown } = { success, keep }
          writes.push(entry)
          entry.answered = await task()
        },
      } as unknown as RecordActsBase
      let acts: ReturnType<typeof useOverviewActs>['actions']['credit']
      function Harness() {
        acts = useOverviewActs({ setDialog: (dialog) => dialogs.push(dialog), base, credit: { permissions: ['sales.credit.view', 'sales.credit.checks'], reread: () => rereads.push('yes + headline') } }).actions.credit
        return null
      }
      render(createElement(Harness), 'en')
      if (act === 'check') acts!.onCheck!()
      else acts!.onAsk!(CHECK, '  Please look today  ')
      for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
      return { calls, dialogs, notices, writes, rereads }
    }
    // Still held, a yes asked: the check (no version in the body), the credit read again names who decides now.
    const held = await run('check', async () => ({ checkId: 'c-2', result: 'HOLD', asked: true, orderGoesOn: false }))
    expect(held.calls).toEqual([
      { method: 'POST', path: `/sales/credit/records/SalesOrder/${value.id}/check`, body: {}, key: expect.any(String) },
      { method: 'GET', path: `/sales/credit/records/SalesOrder/${value.id}` },
    ])
    expect(held.writes).toEqual([{ success: null, keep: true, answered: null }])
    expect(held.dialogs).toEqual([{ kind: 'creditCheck' }, null])
    expect(held.notices).toEqual([{ tone: 'info', words: { key: 'where.credit.stillAsked', params: { who: 'Finance' } } }])
    expect(held.rereads).toEqual(['yes + headline'])
    // Passed: the order goes on — no credit read after it (the order is read again by the write).
    const passed = await run('check', async () => ({ checkId: 'c-2', result: 'PASS', asked: false, orderGoesOn: true }))
    expect(passed.calls.map((call) => call.method)).toEqual(['POST'])
    expect(passed.notices).toEqual([{ tone: 'success', words: { key: 'where.credit.passed' } }])
    // Checked meanwhile: said in the dialog, nothing else claimed.
    const meanwhile = await run('check', async () => Promise.reject(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'credit', message: 'Checked meanwhile.' }])))
    expect(meanwhile.dialogs).toEqual([{ kind: 'creditCheck' }, { kind: 'creditCheck', refused: { key: 'where.credit.refused.meanwhile' } }])
    expect(meanwhile.notices).toEqual([])
    // Ask: on the hold's check, the word trimmed; asked of whom the read names now.
    const asked = await run('ask', async () => ({ taskId: 't-new' }))
    expect(asked.calls[0]).toEqual({ method: 'POST', path: `/sales/credit/checks/${CHECK}/ask`, body: { note: 'Please look today' }, key: expect.any(String) })
    expect(asked.notices).toEqual([{ tone: 'success', words: { key: 'where.credit.asked', params: { who: 'Finance' } } }])
    // Nobody to ask: in the dialog, which keeps its check.
    const nobody = await run('ask', async () => Promise.reject(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'credit', message: 'Nobody to ask.' }])))
    expect(nobody.dialogs.at(-1)).toEqual({ kind: 'creditAsk', checkId: CHECK, refused: { key: 'where.credit.refused.nobody' } })
    expect(CREDIT_ASK_NOTE_MAX).toBe(1000)
  })

  describe('drawn', () => {
    const view = designScreen.view as ComponentType<{ model: unknown }>
    const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
    const stripsOf = (html: string): string => {
      const from = html.indexOf('class="fw-so-strips"')
      return from < 0 ? '' : html.slice(from, html.indexOf('</ul>', from))
    }

    it('Sales after Finance said no: what was found, who said no and when, Check credit again and Ask for a yes… — never an amount', () => {
      const html = stripsOf(draw('f-oo-106-credit-sales'))
      const text = textOf(html)
      for (const words of ['Credit hold — nobody asked for a yes yet', 'Found: Over the limit · Invoices overdue', 'Marco Demo said no on 18/11/2026', 'Check credit again', 'Ask for a yes…']) expect(text, words).toContain(words)
      expect(html).toMatch(/<button[^>]*>Check credit again<\/button>/)
      // No money field drawn: no currency, no amount.
      expect(text).not.toMatch(/€|EUR|\d+[.,]\d{2}\b/)
      const it = textOf(stripsOf(draw('f-oo-106-credit-sales', 'it')))
      for (const words of ['Trovato: Oltre il fido · Fatture scadute', 'Marco Demo ha detto no il 18/11/2026', 'Controlla di nuovo il fido', 'Chiedi un sì…']) expect(it, words).toContain(words)
    })

    it('the Owner reads the no\'s words (the price grain) and the customer on hold; the approver: Approve, Refuse…, Check — no Ask, and what a no does', () => {
      const owner = textOf(stripsOf(draw('f-oo-106-credit-owner')))
      expect(owner).toContain('Marco Demo said no on 18/11/2026: “Two invoices are overdue since October”')
      expect(owner).toContain('Found: Over the limit · On credit hold')
      const approver = stripsOf(draw('f-oo-106-credit-approver'))
      for (const words of ["Credit hold — waits for Finance's yes", 'Approve: Credit override', 'Refuse…', 'Check credit again', 'A no leaves it held: nothing is cancelled']) expect(textOf(approver), words).toContain(words)
      expect(textOf(approver)).not.toContain('Ask for a yes…')
      expect((approver.match(/<button/g) ?? []).length).toBeLessThanOrEqual(3)
    })

    it('no credit right: who checks it, in words, no door; the read failed: said, with Try again', () => {
      const manager = stripsOf(draw('f-oo-106-credit-manager'))
      expect(textOf(manager)).toContain('Sales or Finance check the credit again or ask for a yes')
      expect(manager).not.toContain('Check credit again')
      const failed = stripsOf(draw('f-oo-106-credit-failed'))
      expect(textOf(failed)).toContain('The credit could not be read')
      expect(failed).toMatch(/<button[^>]*>Try again<\/button>/)
    })

    it('the dialogs: Check credit again says what it does; Ask for a yes… says "nobody to ask" and holds Ask with it', () => {
      const check = textOf(draw('f-oo-106-check-dialog'))
      for (const words of ["Check Moto Demo S.r.l.'s credit again?", 'If it passes, the order is confirmed at once.', 'Check again']) expect(check, words).toContain(words)
      const ask = draw('f-oo-106-ask-nobody')
      expect(textOf(ask)).toContain("Ask for a yes on SO-2026-0088's credit")
      expect(textOf(ask)).toContain('A word for who decides (optional)')
      expect(ask).toMatch(/aria-description="No credit rule names someone else who may say yes: the customer pays, or Finance raises the limit\."[^>]*>[^<]*Ask</)
      expect(textOf(draw('f-oo-106-ask-nobody', 'it'))).toContain('Chiedi un sì sul fido di SO-2026-0088')
    })

    it('source: the view fetches nothing (the hook reads the credit, with sales.credit.view only); the client reads no amount', () => {
      const card = readFileSync(new URL('../view/overview/WhereCard.tsx', import.meta.url), 'utf8') + readFileSync(new URL('../view/overview/StripRow.tsx', import.meta.url), 'utf8') /* F-PT-301: the strip row moved to its own file */
      expect(card).not.toMatch(/from '[^']*credit\/api'/)
      expect(card).toContain("actions?.onDialog?.({ kind: 'creditAsk', checkId: door.checkId })")
      const hook = readFileSync(new URL('../use-overview-acts.ts', import.meta.url), 'utf8')
      expect(hook).toContain("input?.permissions.includes('sales.credit.view')")
      expect(hook).toContain('const key = view && waits && order ?')
      const client = readFileSync(new URL('../credit/api.ts', import.meta.url), 'utf8')
      for (const money of ['limit:', 'exposure', 'openOrders', 'available', 'overLimitBy', 'usedPct', 'amount']) expect(client, money).not.toContain(money)
      const container = readFileSync(new URL('../OrderRecord.tsx', import.meta.url), 'utf8')
      // Walk #2: + the yes's read (a credit hold the order read does not name), so the hook is mounted after the depth read.
      expect(container).toContain("credit: { permissions: session.permissions, reread: () => { depth.actions.onRetry?.('approval'); production.again(['headline']) }, approval: depth.model.approval?.value ?? null /* walk #2 */ } /* F-OO-106 */")
      expect(container.indexOf('const overview = useOverviewActs(')).toBeGreaterThan(container.indexOf('const depth = useOrderDepth('))
    })

    it('the words exist in both languages, office "tu" in Italian', () => {
      const KEYS = ['check', 'ask', 'held.noRight', 'whoDecides', 'failed', 'found', 'saidNo', 'saidNoWhy', 'saidNoSomeone', 'saidNoSomeoneWhy', 'takenBack', 'takenBackSystem', 'checkTitle', 'checkBody', 'checkGo', 'askTitle', 'askBody', 'askNote', 'askHint', 'askGo', 'passed', 'passedWaits', 'stillAsked', 'stillAskedSomeone', 'stillNobody', 'asked', 'askedSomeone', 'refused.meanwhile', 'refused.nobody', 'refused.noRule', 'refused.asked'].map((key) => `where.credit.${key}`)
      for (const locale of LOCALES) {
        const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
        for (const key of [...KEYS, 'where.refuse.credit', 'where.refuse.order']) expect(t(key, { who: 'X', date: 'D', reason: 'R', findings: 'F', customer: 'C', number: 'N', count: 2 }), `${locale} ${key}`).not.toBe(key)
      }
      const words = itWordsUnder('where.credit.', 'where.refuse.')
      expect(words).not.toMatch(/\b(?:voi|vostr[oaie])\b/i)
    })
  })
})
// ---- end F-OO-106

// ---- F-OO-108 (order overview §1.4, §1.5; B-OO-005, review F13, F16; W07's note): Hold the whole order… and Quality's door ----------
describe('F-OO-108: Hold the whole order… in the moves row — the domain plan, held with words; Release on Quality held without its right', () => {
  const MANAGE = { manage: true, release: true, hold: true }
  const NONE = { manage: false, release: false, hold: false }
  const owner = actsCanOf(rolePermissions('owner'))
  const sales = actsCanOf(rolePermissions('sales'))

  it('offered while there is work to stop; held while not read and with the plan\'s words when it holds none; hidden without the right (D2)', () => {
    expect(HOLD_ORDER_FROM).toEqual(['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'])
    for (const status of ['PENDING_APPROVAL', 'SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const) expect(holdOrderMoveOf(order(status), workActsRead(MANAGE).work, owner), status).toBeNull()
    expect(holdOrderMoveOf(order('IN_PRODUCTION'), undefined, owner)!.held).toEqual({ key: 'where.hold.reading' })
    // Plan D2 / L9: the work orders withheld from this reader (no right to see them): not drawn (never a grey door).
    expect(holdOrderMoveOf(order('IN_PRODUCTION'), null, owner)).toBeNull()
    // The Owner: live, on the plan (WO-00021 held with its version; WO-00022 on hold already and WO-00019 shared are left out with why).
    const live = holdOrderMoveOf(order('IN_PRODUCTION'), workActsRead(MANAGE).work, owner)!
    expect(live.held).toBeNull()
    expect([live.hold!.plan.numbers, live.hold!.plan.versions, live.hold!.plan.left.map((entry) => entry.number), live.hold!.plan.notReached, live.hold!.units]).toEqual([['WO-00021'], { [WORK.workOrders[0]!.id]: 7 }, ['WO-00022', 'WO-00019'], 1, 12])
    // D2: Sales (the plan's NO_RIGHT) and a page without the acts: hidden — held with words only by the order's state.
    expect(holdOrderMoveOf(order('IN_PRODUCTION'), workActsRead(NONE).work, sales)).toBeNull()
    expect(holdOrderMoveOf(order('IN_PRODUCTION'), workActsRead(MANAGE).work, null)).toBeNull()
    // Nothing in work yet: the plan's words; only made-to-measure units: each from its own page.
    const empty = { ...WORK, workOrders: [], mtm: [], workOrdersLeftOut: 0 }
    expect(holdOrderMoveOf(order('CONFIRMED'), empty, owner)!.held).toEqual({ it: 'Ancora niente da fermare: nessun ordine di lavoro è stato creato per questo ordine.', en: 'Nothing to hold yet: no work order is made for this order.' })
    expect(holdOrderMoveOf(order('CONFIRMED'), { ...empty, mtm: WORK.mtm }, owner)!.held).toEqual({ key: 'where.hold.onlyUnits' })
    // Every open one on hold already.
    const held = workActsRead(MANAGE).work!
    const allHeld = { ...held, workOrders: held.workOrders.filter((entry) => !entry.sharedWithOtherCustomers).map((entry) => ({ ...entry, held: true, status: 'ON_HOLD' })), workOrdersLeftOut: 0 }
    expect(holdOrderMoveOf(order('IN_PRODUCTION'), allHeld, owner)!.held).toEqual({ it: 'Ogni ordine di lavoro aperto di questo ordine è già in sospeso.', en: 'Every open work order of this order is on hold already.' })
    // In the row: in view after Mark ready…, before More ▾ — at most 3 in view.
    const moves = whereMovesOf(order('IN_PRODUCTION'), { can: abilitiesOf(rolePermissions('owner')), readOnly: false, elsewhere: { held: null }, work: workActsRead(MANAGE).work, acts: owner })!
    expect(moves.shown.map((move) => move.id)).toEqual(['ready', 'hold'])
  })

  it('Release on Quality ›: held with who releases it for a reader without quality.holds.view (Sales, Planner, Finance); a link for Quality and the Owner', () => {
    const strip: WhereStrip = { key: 'quality', kind: 'quality', blocker: 'QUALITY_HOLD', reasons: [], workOrders: { reached: [{ id: 'w-1', number: 'WO-00022', shared: false }], notReached: 0 }, since: null }
    const input = (acts: ReturnType<typeof actsCanOf>): StripDoorsInput => ({ prefix: '/w/DEMO', order: order('IN_PRODUCTION'), can: abilitiesOf(rolePermissions('owner')), readOnly: false, busy: false, approval: null, depthCan: { manage: true }, work: [], acts })
    // F-PT-301 (L9): without quality.holds.view, no Release door at all (the strip's line says who releases it).
    for (const role of ['sales', 'planner', 'finance'] as const) expect(stripDoorsOf(strip, input(actsCanOf(rolePermissions(role)))), role).toEqual([])
    for (const permissions of [rolePermissions('owner'), ['workorders.view', 'quality.holds.view']]) expect(stripDoorsOf(strip, input(actsCanOf(permissions))), permissions.length > 2 ? 'owner' : 'quality').toEqual([{ kind: 'quality', href: '/w/DEMO/quality/holds?subjectType=WorkOrder&subjectId=w-1', number: 'WO-00022' }])
  })

  describe('drawn', () => {
    const view = designScreen.view as ComponentType<{ model: unknown }>
    const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
    const rowOf = (html: string) => html.slice(html.indexOf('class="fw-so-where-moves"'), html.indexOf('</div>', html.indexOf('class="fw-so-where-moves"')))

    it('the Owner: Hold the whole order… live beside Mark ready…; Sales: hidden; nothing yet: the plan\'s words; no Release door for Sales', () => {
      expect(rowOf(draw('f-oo-108-moves'))).toMatch(/<button[^>]*>Hold the whole order…<\/button>/)
      expect(rowOf(draw('f-oo-108-moves'))).not.toMatch(/aria-description="[^"]*"[^>]*>Hold the whole order…/)
      // D2 (lead, round T): Sales has no Hold the whole order… at all (hidden, never grey).
      expect(draw('f-oo-108-moves-sales')).not.toContain('Hold the whole order…')
      expect(rowOf(draw('f-oo-108-nothing'))).toMatch(/aria-description="Nothing to hold yet: no work order is made for this order\."[^>]*>Hold the whole order…/)
      expect(rowOf(draw('f-oo-108-moves', 'it'))).toContain("Metti in sospeso tutto l'ordine…".replace("'", '&#x27;'))
      // F-PT-301 (L9): Sales' Release on Quality › is not drawn (the Quality page would refuse it); the strip's own line says who
      // releases it.
      const sales = draw('f-oo-105-holds-sales')
      expect(sales).not.toContain('Release on Quality ›')
      expect(textOf(sales)).toContain(createTranslator('en', messagesFor('en', ['orders']).orders!)('where.strip.qualityWho'))
    })

    it('the words exist in both languages, office "tu" in Italian', () => {
      for (const locale of LOCALES) {
        const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
        for (const key of ['label', 'reading', 'onlyUnits', 'leftTitle', 'left'] /* F-PT-301: qualityNoRight went with the held door */) expect(t(`where.hold.${key}`, { number: 'N', words: 'W' }), `${locale} ${key}`).not.toBe(`where.hold.${key}`)
        for (const key of ['notReached', 'units', 'stale', 'notice']) for (const count of [1, 2]) expect(t(`where.hold.${key}`, { count, numbers: 'N', number: 'SO-1' }), `${locale} ${key} ${count}`).not.toBe(`where.hold.${key}`)
      }
      expect(itWordsUnder('where.hold.')).not.toMatch(/\b(?:voi|vostr[oaie])\b/i)
    })
  })
})
// ---- end F-OO-108

// ---- F-OO-109 (order overview §1.3; N5, B-OO-006; W07's note): Lift… for a strip on N work orders — the ONE lift ---------------------
describe('F-OO-109: the strip\'s Lift… on several of its own work orders opens the ONE lift (all or none); one stays today\'s Lift…', () => {
  const owner = rolePermissions('owner')
  const input = (over: Partial<StripDoorsInput> = {}): StripDoorsInput => ({ prefix: '/w/DEMO', order: order('IN_PRODUCTION'), can: abilitiesOf(owner), readOnly: false, busy: false, approval: null, depthCan: { manage: true }, work: [], acts: actsCanOf(owner), ...over })
  const row = (id: string, number: string, hold: boolean) => ({ ...WORK.workOrders[0]!, id, number, status: 'ON_HOLD', held: true, version: 7, rights: { manage: hold, release: hold, hold, why: null } })
  const pause = (reached: { id: string; number: string; shared?: boolean }[], notReached = 0): WhereStrip => ({ key: 'pause', kind: 'pause', blocker: 'BRAND_PAUSE', reasons: [], workOrders: { reached: reached.map((entry) => ({ shared: false, ...entry })), notReached }, since: null })
  const TWO = [{ id: 'w-1', number: 'WO-00021' }, { id: 'w-2', number: 'WO-00022' }]

  it('several own, each read: ONE Lift with the strip\'s kind, the shared ones and those not reached carried; held for Sales; busy', () => {
    const work = [row('w-1', 'WO-00021', true), row('w-2', 'WO-00022', true)]
    expect(stripDoorsOf(pause([...TWO, { id: 'w-s', number: 'WO-00019', shared: true }], 1), input({ work }))).toEqual([{ kind: 'liftMany', holdKind: 'BRAND', workOrders: TWO, shared: ['WO-00019'], notReached: 1, label: 'wo.liftPause', held: null }])
    const production: WhereStrip = { ...pause(TWO), key: 'production', kind: 'production', blocker: 'NO_MOVE' } as WhereStrip
    expect(stripDoorsOf(production, input({ work }))).toMatchObject([{ kind: 'liftMany', holdKind: 'PRODUCTION', label: 'wo.act.lift', held: null }])
    // Sales (no hold right on a row): held with who does it; a write running: held with its words.
    // F-PT-301 (L9): one of them not liftable by this reader: no ONE Lift (hidden, not held).
    expect(stripDoorsOf(pause(TWO), input({ work: [row('w-1', 'WO-00021', true), row('w-2', 'WO-00022', false)] }))).toEqual([])
    expect(stripDoorsOf(pause(TWO), input({ work, busy: true }))).toMatchObject([{ kind: 'liftMany', held: { key: 'held.busy' } }])
    // A row not read, or the acts not here: Production › holds (each row's own Lift there), as before.
    expect(stripDoorsOf(pause(TWO), input({ work: [work[0]!] }))).toEqual([{ kind: 'tab', tab: 'production', anchor: 'holds' }])
    expect(stripDoorsOf(pause(TWO), input({ work, acts: null }))).toEqual([{ kind: 'tab', tab: 'production', anchor: 'holds' }])
    // One of its own alone: today's Lift… on that row (unchanged).
    expect(stripDoorsOf(pause([TWO[0]!]), input({ work }))).toMatchObject([{ kind: 'lift', label: 'wo.liftPause', row: { id: 'w-1' } }])
    // Read-only: no door.
    expect(stripDoorsOf(pause(TWO), input({ work, readOnly: true }))).toEqual([])
  })

  it('drawn: the Owner\'s Lift the customer\'s pause… is live; Sales\' is hidden — one line: Production does it', () => {
    const view = designScreen.view as ComponentType<{ model: unknown }>
    const draw = (id: string) => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, 'en')
    const stripsOf = (html: string): string => html.slice(html.indexOf('class="fw-so-strips"'), html.indexOf('</ul>', html.indexOf('class="fw-so-strips"')))
    const owner = stripsOf(draw('f-oo-109-lift'))
    expect(textOf(owner)).toContain('on 4 work orders: WO-00019, WO-00021 and 1 more and 1 work order outside what you can open')
    expect(owner).toMatch(/<button[^>]*>Lift the customer&#x27;s pause…<\/button>/)
    // F-PT-301 (L9): Sales has no lift door (hidden, never grey); the strip's one line says who does it.
    const sales = stripsOf(draw('f-oo-109-lift-sales'))
    expect(sales).not.toContain('Lift the customer&#x27;s pause…')
    expect(textOf(sales)).toContain('Production does this — a planner or the production manager')
    const card = readFileSync(new URL('../view/overview/WhereCard.tsx', import.meta.url), 'utf8') + readFileSync(new URL('../view/overview/StripRow.tsx', import.meta.url), 'utf8') /* F-PT-301: the strip row moved to its own file */
    expect(card).toContain('actions?.workOrderActs?.onLiftMany?.({ kind: door.holdKind, workOrders: door.workOrders, shared: door.shared, notReached: door.notReached })')
  })

  it('the words exist in both languages, office "tu" in Italian', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['body', 'list', 'on', 'noneOn', 'reading', 'readFailed', 'allOrNone', 'customer', 'held.failed', 'held.none', 'meanwhile']) expect(t(`where.lift.${key}`, { number: 'N', words: 'W' }), `${locale} ${key}`).not.toBe(`where.lift.${key}`)
      for (const key of ['title', 'titlePause', 'notReached', 'go', 'stale', 'notice']) for (const count of [1, 2]) expect(t(`where.lift.${key}`, { count, numbers: 'N' }), `${locale} ${key} ${count}`).not.toBe(`where.lift.${key}`)
    }
    expect(itWordsUnder('where.lift.')).not.toMatch(/\b(?:voi|vostr[oaie])\b/i)
  })
})
// ---- end F-OO-109

// ---- F-MS-101 (set the stage by hand, 04 §2; review R4, R5, R19, R21): the hand stage's row under the dots and its ONE door ------------

describe('F-MS-101: the stage set by hand — the row under the dots (who, when, why, the floor) and its one door', () => {
  const TODAY = '2026-10-29'
  type HandStage = NonNullable<Headline['stage']>['byHand']
  const at = (code: BrandStage, byHand: HandStage = null): Headline => ({ ...HEADLINE, stage: { ...HEADLINE.stage!, code, byHand, version: 3 } })
  const ROLES = { Owner: 'owner', Planner: 'planner', 'Production manager': 'production_manager', Sales: 'sales', Warehouse: 'warehouse', 'Read-only': 'read_only' } as const
  type RoleName = keyof typeof ROLES
  /** As the card: the hand right is production.brand.manage; Read-only by the band's rule. */
  const rightsOf = (role: RoleName) => {
    const permissions = rolePermissions(ROLES[role])
    const brand = permissions.includes('production.brand.manage')
    return { brand, readOnly: readOnlyOnPage(abilitiesOf(permissions), { assignSupervisor: brand, qualityHold: permissions.includes('quality.holds.place') }) }
  }
  const noWork = (value: Order): Order => ({ ...value, chain: { ...value.chain, workOrders: [] } })

  it('the row: Sewing over the floor\'s Preparing — who (an office person), when, why, what the floor says; the office\'s note', () => {
    expect(handRowOf(order('IN_PRODUCTION'), HAND_READ.headline, TODAY)).toEqual({
      stage: 'SEWING',
      tone: 'info',
      by: 'Bea Esempio',
      at: HAND_AT,
      reason: { key: 'where.manual.reasons.OUTAGE' },
      lines: [{ key: 'where.manual.floor', stage: 'SEWING', floor: 'PREPARING' }],
      note: 'Tablet del reparto taglio offline dalle 14:00.',
      stripNote: { key: 'where.manual.tag' },
    })
    // Nothing set (or an older answer without the field, or the headline not read): no row.
    for (const headline of [HAND_FREE_READ.headline, HEADLINE, null, undefined]) expect(handRowOf(order('IN_PRODUCTION'), headline, TODAY)).toBeNull()
    // Without the notes gate the API sends no who and no note: neither is said (never "by —").
    const hidden = handRowOf(order('IN_PRODUCTION'), at('SEWING', { ...HAND_BY, by: null, note: null }), TODAY)
    expect([hidden?.by, hidden?.note]).toEqual([null, null])
    // A blank note is no note; a reason code this page does not know is not said (never the code).
    expect(handRowOf(order('IN_PRODUCTION'), at('SEWING', { ...HAND_BY, note: '   ' }), TODAY)?.note).toBeNull()
    expect(handRowOf(order('IN_PRODUCTION'), at('SEWING', { ...HAND_BY, reasonCode: 'NOT_A_CODE' }), TODAY)?.reason).toBeNull()
    for (const code of ['OUTAGE', 'FEW_PEOPLE', 'OUTSIDE', 'OTHER']) expect(handRowOf(order('IN_PRODUCTION'), at('SEWING', { ...HAND_BY, reasonCode: code }), TODAY)?.reason).toEqual({ key: `where.manual.reasons.${code}` })
    // The row names an office person or nobody: never a person of the floor (the read has no such field).
    expect(JSON.stringify(handRowOf(order('IN_PRODUCTION'), HAND_READ.headline, TODAY))).not.toMatch(/operator|operatore|station|postazione/i)
  })

  it('F-SC-W1: set back below the floor (a wrong scan): the floor\'s counts, and it clears when they come back to it or pass where the floor was', () => {
    expect(handRowOf(order('IN_PRODUCTION'), HAND_BACK_READ.headline, TODAY)).toMatchObject({ stage: 'CUTTING', reason: { key: 'where.manual.reasons.OTHER' }, lines: [{ key: 'where.manual.floorBack', stage: 'CUTTING', floor: 'QUALITY', past: 'QUALITY' }], note: HAND_BACK_BY.note })
    // The floor moved on since the set (Sewing → Quality check): `past` is where it was at the set (floorAtSet), not where it is now.
    expect(handRowOf(order('IN_PRODUCTION'), at('CUTTING', { ...HAND_BACK_BY, floorAtSet: 'SEWING' }), TODAY)?.lines).toEqual([{ key: 'where.manual.floorBack', stage: 'CUTTING', floor: 'QUALITY', past: 'SEWING' }])
    // An older answer without floorAtSet: judged against the floor now (below it: back; above it: ahead, today's line).
    expect(handRowOf(order('IN_PRODUCTION'), at('CUTTING', { ...HAND_BACK_BY, floorAtSet: undefined }), TODAY)?.lines).toEqual([{ key: 'where.manual.floorBack', stage: 'CUTTING', floor: 'QUALITY', past: 'QUALITY' }])
    expect(handRowOf(order('IN_PRODUCTION'), at('SEWING', { ...HAND_BY, floorAtSet: null }), TODAY)?.lines).toEqual([{ key: 'where.manual.floor', stage: 'SEWING', floor: 'PREPARING' }])
    // A set ahead keeps today's line, Ready to ship included.
    expect(handRowOf(order('IN_PRODUCTION'), at('READY', { ...HAND_BY, stage: 'READY', floor: { code: 'QUALITY', words: { en: 'Quality check', it: 'Controllo qualità' } }, floorAtSet: 'QUALITY' }), TODAY)?.lines).toEqual([{ key: 'where.manual.floor', stage: 'READY', floor: 'QUALITY' }])
  })

  it('after 7 days (the domain\'s handSetOld): the warning tone and "check it" with its days; 6 days stays info', () => {
    expect(handRowOf(order('IN_PRODUCTION'), HAND_OLD_READ.headline, TODAY)).toMatchObject({ tone: 'warning', lines: [{ key: 'where.manual.floor', stage: 'SEWING', floor: 'PREPARING' }, { key: 'where.manual.old', days: 9 }] })
    expect(handRowOf(order('IN_PRODUCTION'), at('SEWING', { ...HAND_BY, at: '2026-10-23T09:00:00Z' }), TODAY)).toMatchObject({ tone: 'info', lines: [{ key: 'where.manual.floor' }] })
    expect(handRowOf(order('IN_PRODUCTION'), at('SEWING', { ...HAND_BY, at: '2026-10-22T09:00:00Z' }), TODAY)).toMatchObject({ tone: 'warning', lines: [{ key: 'where.manual.floor' }, { key: 'where.manual.old', days: 7 }] })
  })

  it('no work order on the order (as SEED-SO-W39-02): "No work order records this order" instead of the floor\'s line; cancelled ones record nothing', () => {
    expect(handRowOf(noWork(order('IN_PRODUCTION')), HAND_NOWORK_READ.headline, TODAY)).toMatchObject({ stage: 'CUTTING', reason: { key: 'where.manual.reasons.FEW_PEOPLE' }, lines: [{ key: 'where.manual.noWork' }], note: null })
    const value = order('IN_PRODUCTION')
    const cancelled: Order = { ...value, chain: { ...value.chain, workOrders: value.chain.workOrders.map((entry) => ({ ...entry, status: 'CANCELLED' })) } }
    expect(handRowOf(cancelled, HAND_READ.headline, TODAY)?.lines).toEqual([{ key: 'where.manual.noWork' }])
  })

  it('only while the work is current: never on a waiting, shipped, delivered, closed or cancelled order, whatever a late read says (R5)', () => {
    for (const status of ['PENDING_APPROVAL', 'SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const) expect(handRowOf(order(status), HAND_READ.headline, TODAY), status).toBeNull()
    for (const status of ['IN_PRODUCTION', 'PARTLY_SHIPPED'] as const) expect(handRowOf(order(status), HAND_READ.headline, TODAY)?.stage, status).toBe('SEWING')
  })

  it('the door: status × role — In production and Partly shipped; held on Confirmed (R4); never after production, waiting or Ready (R5); Read-only none', () => {
    const KIND: Readonly<Record<OrderStatus, 'set' | null>> = { PENDING_APPROVAL: null, CONFIRMED: 'set', IN_PRODUCTION: 'set', READY: null, PARTLY_SHIPPED: 'set', SHIPPED: null, DELIVERED: null, CLOSED: null, CANCELLED: null }
    for (const status of ORDER_STATUSES) {
      for (const role of Object.keys(ROLES) as RoleName[]) {
        const { brand, readOnly } = rightsOf(role)
        const door = handDoorOf(order(status), HAND_FREE_READ.headline, brand, readOnly, false)
        if (role === 'Read-only') {
          expect(readOnly, status).toBe(true)
          expect(door, `${status} ${role}`).toBeNull()
          continue
        }
        expect(readOnly, `${status} ${role}`).toBe(false)
        expect(door?.kind ?? null, `${status} ${role}`).toBe(KIND[status])
        if (!door || door.kind !== 'set') continue
        // The right speaks first (Production does this); a Confirmed order: production has not started yet; else it may be set.
        expect(door.held, `${status} ${role}`).toEqual(!brand ? { key: 'wo.heldHold' } : status === 'CONFIRMED' ? STAGE_SET_REFUSAL_WORDS.NOT_STARTED : null)
      }
    }
    // The right is the health raise's (production.brand.manage): Owner, Planner, Production manager — never Sales or the warehouse.
    expect((Object.keys(ROLES) as RoleName[]).filter((role) => rightsOf(role).brand)).toEqual(['Owner', 'Planner', 'Production manager'])
    expect(STAGE_SET_REFUSAL_WORDS.NOT_STARTED.en).toBe('Production has not started yet: a stage is set by hand only once the order is in production.')
  })

  it('F-SC-W1: the door by the stage — open at every stage (Quality check: Ready by hand, warned; Ready to ship: back); no stage, still reading; a write', () => {
    for (const code of BRAND_STAGES) expect(handDoorOf(order('IN_PRODUCTION'), at(code), true, false, false), code).toEqual({ kind: 'set', held: null })
    expect(handDoorOf(order('PARTLY_SHIPPED'), at('READY'), true, false, false)).toEqual({ kind: 'set', held: null })
    expect(handDoorOf(order('IN_PRODUCTION'), { ...HEADLINE, stage: null }, true, false, false)).toEqual({ kind: 'set', held: STAGE_SET_REFUSAL_WORDS.NOTHING_LEFT })
    for (const headline of [null, undefined]) expect(handDoorOf(order('IN_PRODUCTION'), headline, true, false, false)).toEqual({ kind: 'set', held: { key: 'where.manual.held.reading' } })
    // A write running: held.busy — after the state's own words; without the right, the right's words first.
    expect(handDoorOf(order('IN_PRODUCTION'), at('SEWING'), true, false, true)).toEqual({ kind: 'set', held: { key: 'held.busy' } })
    expect(handDoorOf(order('IN_PRODUCTION'), at('QUALITY'), true, false, true)).toEqual({ kind: 'set', held: { key: 'held.busy' } })
    expect(handDoorOf(order('IN_PRODUCTION'), at('QUALITY'), false, false, true)).toEqual({ kind: 'set', held: { key: 'wo.heldHold' } })
  })

  it('the customer\'s own pause holds the set and Change… ("lift the pause first", R19); Clear… stays open; our own hold allows it', () => {
    expect(pausedByCustomer(HAND_PAUSED_READ.headline)).toBe(true)
    expect(handDoorOf(order('IN_PRODUCTION'), HAND_PAUSED_READ.headline, true, false, false)).toEqual({ kind: 'set', held: STAGE_SET_REFUSAL_WORDS.PAUSED })
    const paused = HAND_PAUSED_READ.headline!
    expect(handDoorOf(order('IN_PRODUCTION'), { ...paused, stage: { ...paused.stage!, byHand: HAND_BY } }, true, false, false)).toEqual({ kind: 'standing', change: STAGE_SET_REFUSAL_WORDS.PAUSED, clear: null })
    expect(STAGE_SET_REFUSAL_WORDS.PAUSED.en).toBe("Paused at the customer's request: lift the pause first.")
    // Our own production hold (NO_MOVE) or quality's: the Blocked pill stays, and the stage may be set.
    const ours: Headline = { ...at('SEWING'), held: true, waiting: { ...HEADLINE.waiting, blockers: [{ kind: 'NO_MOVE', on: 'US', words: { en: 'On hold', it: 'In sospeso' }, since: null, ref: null, sub: null }] } }
    expect(pausedByCustomer(ours)).toBe(false)
    expect(handDoorOf(order('IN_PRODUCTION'), ours, true, false, false)).toEqual({ kind: 'set', held: null })
  })

  it('while a hand stage stands: Change… and Clear… (held by the right, a write), never the Set door; at Quality check it may still be changed (D9)', () => {
    for (const status of ['IN_PRODUCTION', 'PARTLY_SHIPPED'] as const) expect(handDoorOf(order(status), HAND_READ.headline, true, false, false), status).toEqual({ kind: 'standing', change: null, clear: null })
    expect(handDoorOf(order('IN_PRODUCTION'), HAND_READ.headline, false, false, false)).toEqual({ kind: 'standing', change: { key: 'wo.heldHold' }, clear: { key: 'wo.heldHold' } })
    expect(handDoorOf(order('IN_PRODUCTION'), HAND_READ.headline, true, false, true)).toEqual({ kind: 'standing', change: { key: 'held.busy' }, clear: { key: 'held.busy' } })
    expect(handDoorOf(order('IN_PRODUCTION'), HAND_READ.headline, true, true, false)).toBeNull()
    expect(handDoorOf(order('IN_PRODUCTION'), at('QUALITY', { ...HAND_BY, stage: 'QUALITY' }), true, false, false)).toEqual({ kind: 'standing', change: null, clear: null })
    for (const status of ['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const) expect(handDoorOf(order(status), HAND_READ.headline, true, false, false), status).toBeNull()
  })

  it('the door is not a move: WHERE_MOVES stays; every word in both languages (office "tu", "la fase" feminine), none says "never by hand"', () => {
    expect(WHERE_MOVES).toEqual(['ready', 'hold', 'elsewhere', 'cancel', 'close'])
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      const keys = ['open', 'tag', 'noWork', 'change', 'clear', 'held.reading', 'reasons.OUTAGE', 'reasons.FEW_PEOPLE', 'reasons.OUTSIDE', 'reasons.OTHER']
      for (const key of keys) expect(t(`where.manual.${key}`), `${locale} ${key}`).not.toBe(`where.manual.${key}`)
      for (const key of ['by', 'floor', 'floorBack' /* F-SC-W1 */, 'old', 'stagesLink', 'changeAria', 'clearAria', 'stepAria' /* F-SC-W1 */, 'stepFloorAria' /* pt-sc-fx1 */]) expect(t(`where.manual.${key}`, { who: 'x', floor: 'x', stage: 'x', age: 'x', number: 'x', past: 'x' }), `${locale} ${key}`).not.toMatch(/^where\.manual\.|\{\w+\}/)
    }
    const it = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect([it('where.manual.tag'), it('where.manual.noWork'), it('where.manual.old', { age: '9 g' })]).toEqual(['Impostata a mano', "Nessun ordine di lavoro registra questo ordine: resta finché non la togli o l'ordine parte", 'Impostata a mano 9 g fa: controllala'])
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    expect(en('where.manual.floorBack', { floor: 'Quality check', stage: 'Cutting', past: 'Quality check' })).toBe("The floor's counts say Quality check: it clears by itself when the floor's counts come back to Cutting or pass Quality check")
    expect(en('where.manual.old', { age: '9 d' })).toBe('Set by hand 9 d ago: check it')
    expect(en('where.manual.stepAria', { number: 'SO-1', stage: 'Sewing' })).toBe('Set the stage of SO-1 to Sewing…')
    // pt-sc-fx1: the floor's own step — its stage first (the visible word in its name), never the Clear… door's name.
    expect(en('where.manual.stepFloorAria', { number: 'SO-1', stage: 'Preparing' })).toBe("Preparing: back to the floor's stage — clears the stage set by hand on SO-1…")
    expect(it('where.manual.stepFloorAria', { number: 'SO-1', stage: 'In preparazione' })).toBe('In preparazione: torna alla fase del reparto — toglie la fase impostata a mano su SO-1…')
    expect(en('where.manual.stepFloorAria', { number: 'SO-1', stage: 'Preparing' })).not.toBe(en('where.manual.clearAria', { number: 'SO-1' }))
    // The right's words in Admin's role matrix say the new rule (never "never Ready to ship").
    const adminEn = createTranslator('en', messagesFor('en', ['admin']).admin!)
    const adminIt = createTranslator('it', messagesFor('it', ['admin']).admin!)
    expect(adminEn('perm.production_brand_manage')).toContain("set its order's stage by hand with a reason, forward or back")
    expect(adminIt('perm.production_brand_manage')).toContain('impostare a mano la fase di un suo ordine con un motivo, avanti o indietro')
    for (const words of [adminEn('perm.production_brand_manage'), adminIt('perm.production_brand_manage')]) expect(words).not.toMatch(/never Ready to ship|mai Pronto per la spedizione/)
    expect(itWordsUnder('where.manual.')).not.toMatch(/\b(?:voi|vostr[oaie])\b/i)
  })

  it('F-SC-W1: the steps of the stages — every one but the stage shown; while a hand stage stands the floor\'s own opens Clear…; none while the door is held', () => {
    const picks = (headline: Headline | null | undefined, can = true, readOnly = false, busy = false) => stagePicksOf(headline, handDoorOf(order('IN_PRODUCTION'), headline, can, readOnly, busy))?.map((pick) => `${pick.stage}:${pick.kind}`) ?? null
    // Nothing set, the floor at Sewing: the four other stages, each opening Set with it picked.
    expect(picks(HAND_FREE_READ.headline)).toEqual(['PREPARING:set', 'CUTTING:set', 'QUALITY:set', 'READY:set'])
    expect(stagePicksOf(HAND_FREE_READ.headline, { kind: 'set', held: null })![3]).toEqual({ stage: 'READY', kind: 'set', dialog: { kind: 'stageByHand', mode: 'set', pick: 'READY' } })
    // Sewing set over the floor's Preparing: Preparing opens Clear…; the others Change… with that step picked.
    expect(picks(HAND_READ.headline)).toEqual(['PREPARING:clear', 'CUTTING:set', 'QUALITY:set', 'READY:set'])
    const standing = stagePicksOf(HAND_READ.headline, { kind: 'standing', change: null, clear: null })!
    expect(standing[0]).toEqual({ stage: 'PREPARING', kind: 'clear', dialog: { kind: 'stageClear' } })
    expect(standing[1]).toEqual({ stage: 'CUTTING', kind: 'set', dialog: { kind: 'stageByHand', mode: 'change', pick: 'CUTTING' } })
    // Cutting set back below the floor's Quality check: Quality check opens Clear….
    expect(picks(HAND_BACK_READ.headline)).toEqual(['PREPARING:set', 'SEWING:set', 'QUALITY:clear', 'READY:set'])
    // Held (the right, the customer's pause, a write), Read-only, no stage read, after production: no steps — the stages stay as they were.
    for (const [name, value] of [['Sales', picks(HAND_READ.headline, false)], ['busy', picks(HAND_FREE_READ.headline, true, false, true)], ['paused', picks(HAND_PAUSED_READ.headline)], ['Read-only', picks(HAND_READ.headline, true, true)], ['no stage', picks({ ...HEADLINE, stage: null })], ['not read', picks(null)]] as const) expect(value, name).toBeNull()
    expect(stagePicksOf(HAND_READ.headline, handDoorOf(order('SHIPPED'), HAND_READ.headline, true, false, false))).toBeNull()
    expect(stagePicksOf(HAND_FREE_READ.headline, handDoorOf(order('CONFIRMED'), HAND_FREE_READ.headline, true, false, false))).toBeNull()
    // Why they are not buttons, said once (Production's stage bar): the door's own held words.
    expect(stagePicksHeldOf(handDoorOf(order('IN_PRODUCTION'), HAND_READ.headline, false, false, false))).toEqual({ key: 'wo.heldHold' })
    expect(stagePicksHeldOf(handDoorOf(order('CONFIRMED'), HAND_FREE_READ.headline, true, false, false))).toEqual(STAGE_SET_REFUSAL_WORDS.NOT_STARTED)
    expect(stagePicksHeldOf(handDoorOf(order('IN_PRODUCTION'), HAND_FREE_READ.headline, true, false, false))).toBeNull()
    expect(stagePicksHeldOf(null)).toBeNull()
  })

  it('source: the rules and words are the domain\'s (stage-set), never a web copy; the comments say the new rule (R21)', () => {
    const rules = readFileSync(new URL('./where.ts', import.meta.url), 'utf8')
    expect(rules).toContain("from '@nexus/factory-domain/production-brand/stage-set'")
    expect(rules).not.toMatch(/function (?:handSetOld|handStands|shownStageOf|handStageChoicesOf)\b/)
    expect(rules).not.toMatch(/never by hand|never set here|never a hand\b/)
    const strip = readFileSync(new URL('../../../../../lib/production/view/StageStrip.tsx', import.meta.url), 'utf8')
    expect(strip).toContain('is SHOWN here, never set')
    expect(readFileSync(new URL('../view/overview/where.css', import.meta.url), 'utf8')).not.toContain('never by hand')
  })
})
// ---- end F-MS-101
