import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SALES_ORDER_PRIORITY_LEVELS } from '@nexus/factory-domain/sales/orders-depth/rules'
import { SEASON_STATES as DOMAIN_SEASON_STATES } from '@nexus/factory-domain/sales/seasons/rules'
import { FREEZE_STATES as DOMAIN_FREEZE_STATES, ORDER_FREEZE_FIELDS, ORDER_FREEZE_STAGES } from '@nexus/factory-domain/sales/order-changes/freeze'
import { CHANGE_YES_STATES as DOMAIN_YES, CUSTOMER_DECISIONS as DOMAIN_DECISIONS } from '@nexus/factory-domain/sales/order-changes/priced'
import { FINISH_SOURCES as DOMAIN_FINISH, RISK_STATES as DOMAIN_RISK } from '@nexus/factory-domain/planning/promise-keep/risk'
import { GATE_KINDS as DOMAIN_GATES, MILESTONE_KINDS as DOMAIN_MILESTONE_KINDS, MILESTONE_STATES as DOMAIN_MILESTONE_STATES } from '@nexus/factory-domain/planning/milestones/rules'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { hasOwnWords } from '../../../admin/import/model'
import { layoutFromAddress, listAddress, rowsFromAddress, rowsQuery, ROW_VIEWS, TILES } from '../model'
import { TILE_KEYS } from '../api'
import { importHeldOf, ORDERS_IMPORTER } from '../import/use-orders-import'
import { designScreen as importScreen } from '../import/fixtures'
import { designScreen as pdfScreen } from '../confirmation/fixtures'
import { designScreen as listScreen } from '../list/fixtures'
import { designScreen as recordScreen } from '../record/fixtures'
import { isoWeek, mondayOf, siteOf, weekColumns } from '../week/model'
import { pricedProblemWords } from './view/DepthDialogs'
import {
  CHANGE_YES_STATES,
  CUSTOMER_DECISIONS,
  EXTRA_DEPOSIT_KINDS,
  FINISH_SOURCES,
  FREEZE_FIELDS,
  FREEZE_STAGES,
  FREEZE_STATES,
  MILESTONE_KINDS,
  MILESTONE_STATES,
  orderDepthSchema,
  PRIORITY_LEVELS,
  RISK_STATES,
  SEASON_STATES,
  WAIT_REASONS,
} from './api'
import {
  APPROVAL_CREDIT,
  APPROVAL_NOBODY,
  APPROVAL_PENDING,
  CHANGES,
  CONFIRMATION_NONE,
  CONFIRMATION_OUTDATED,
  CONFIRMATION_SENT,
  CONFIRMATION_WAITING,
  DEPOSIT_KINDS_OFF,
  depthCan,
  FREEZE_CUT,
  FREEZE_FINISHED,
  FREEZE_NONE,
  MATERIALS,
  orderDepth,
  PROMISE_LINES,
  TECH_PACK,
} from './demo/fixtures'
import {
  askHeld,
  changeCounts,
  confirmationHeld,
  confirmationRecipient,
  confirmationState,
  depositKindChoices,
  depthCanOf,
  depthEditHeld,
  forecastSites,
  forecastsOf,
  freezeRows,
  frozenCells,
  frozenGroups,
  frozenOffer,
  onlyMeasurements,
  frozenProblemsOf,
  materialRows,
  NAMESPACE,
  packRows,
  PRICED_EMPTY,
  pricedBodyOf,
  pricedChanges,
  pricedProblems,
  printHeld,
  priorityBody,
  putBackOffered,
  selectionHeld,
  selectionOutcome,
  urgentReasonProblem,
  waitPhrases,
  withdrawHeld,
  writeProblemOf,
} from './model'
import { LINE_BLK, LINE_RED, order, TODAY } from '../_demo/fixtures'

describe('B-W2b-323 — the lists this app mirrors are the domain’s', () => {
  it('priority, season, freeze, the changes, the forecast and the milestones', () => {
    expect([...PRIORITY_LEVELS]).toEqual([...SALES_ORDER_PRIORITY_LEVELS])
    expect([...SEASON_STATES]).toEqual([...DOMAIN_SEASON_STATES])
    expect([...FREEZE_FIELDS]).toEqual([...ORDER_FREEZE_FIELDS])
    expect([...FREEZE_STAGES]).toEqual([...ORDER_FREEZE_STAGES])
    expect([...FREEZE_STATES]).toEqual([...DOMAIN_FREEZE_STATES])
    expect([...CHANGE_YES_STATES]).toEqual([...DOMAIN_YES])
    expect([...CUSTOMER_DECISIONS]).toEqual([...DOMAIN_DECISIONS])
    expect([...FINISH_SOURCES]).toEqual([...DOMAIN_FINISH])
    expect([...RISK_STATES]).toEqual([...DOMAIN_RISK])
    expect([...MILESTONE_KINDS]).toEqual([...DOMAIN_MILESTONE_KINDS])
    expect([...MILESTONE_STATES]).toEqual([...DOMAIN_MILESTONE_STATES])
  })
})

describe('rights, priority and the selection', () => {
  it('the depth reads by permission', () => {
    expect(depthCanOf(['orders.view', 'planning.promise.view'])).toMatchObject({ view: true, manage: false, promise: true, planning: false })
    expect(depthCan('sales')).toMatchObject({ manage: true, price: true, promise: true, planning: false, importRun: true })
    expect(depthCan('manager')).toMatchObject({ manage: false, planning: true })
  })

  it('a closed or cancelled order keeps its priority; no right says so', () => {
    expect(depthEditHeld('IN_PRODUCTION', { manage: true })).toBeNull()
    expect(depthEditHeld('CLOSED', { manage: true })?.key).toBe('held.final')
    expect(depthEditHeld('CONFIRMED', { manage: false })?.key).toBe('held.noManage')
  })

  it('URGENT asks one line of reason; another level carries none', () => {
    expect(urgentReasonProblem('URGENT', ' ')).toBe('priority.problem.reason')
    expect(urgentReasonProblem('URGENT', 'a\nb')).toBe('priority.problem.oneLine')
    expect(urgentReasonProblem('URGENT', 'x'.repeat(501))).toBe('priority.problem.long')
    expect(urgentReasonProblem('HIGH', '')).toBeNull()
    expect(priorityBody('HIGH', 'ignored')).toEqual({ priorityLevel: 'HIGH', urgentReason: null })
    expect(priorityBody('URGENT', '  apre il negozio ')).toEqual({ priorityLevel: 'URGENT', urgentReason: 'apre il negozio' })
  })

  it('Set priority is held before the click and says what it did', () => {
    expect(selectionHeld(0, { manage: true })?.key).toBe('held.noneSelected')
    expect(selectionHeld(201, { manage: true })).toEqual({ key: 'held.tooMany', params: { max: 200 } })
    expect(selectionHeld(3, { manage: false })?.key).toBe('held.noManage')
    expect(selectionHeld(3, { manage: true })).toBeNull()
    expect(selectionOutcome({ priorityLevel: 'HIGH', changed: ['a', 'b'], unchanged: [], skipped: [{ orderId: 'c', number: 'SO-1' }], unknown: 1 }).map((entry) => entry.key)).toEqual(['selection.changed', 'selection.skipped', 'selection.unknown'])
    expect(selectionOutcome({ priorityLevel: 'LOW', changed: [], unchanged: [], skipped: [], unknown: 0 })).toEqual([{ key: 'selection.nothing' }])
  })
})

describe('the yes an order waits for', () => {
  it('in words, the most pressing first; ask and take back held by the API’s may', () => {
    expect(waitPhrases(APPROVAL_CREDIT).map((entry) => entry.key)).toEqual(['wait.CREDIT_HOLD', 'wait.REQUEST_PENDING'])
    expect(askHeld(APPROVAL_NOBODY, { manage: true })).toBeNull()
    expect(askHeld(APPROVAL_PENDING, { manage: true })?.key).toBe('held.askStanding')
    expect(withdrawHeld(APPROVAL_PENDING, { manage: true })).toBeNull()
    expect(withdrawHeld(APPROVAL_CREDIT, { manage: true })?.key).toBe('held.withdrawNotYours')
    expect([...WAIT_REASONS].sort()).toEqual(['CREDIT_HOLD', 'MEASUREMENTS', 'NO_REQUEST', 'REQUEST_PENDING'])
    // B-W2b-368: the factory review comes last among the reasons; an order waiting only for it shows no yes banner.
    expect(waitPhrases({ reasons: [{ reason: 'MEASUREMENTS' }, { reason: 'CREDIT_HOLD' }] }).map((entry) => entry.key)).toEqual(['wait.CREDIT_HOLD', 'wait.MEASUREMENTS'])
    expect(onlyMeasurements({ reasons: [{ reason: 'MEASUREMENTS' }] })).toBe(true)
    expect(onlyMeasurements({ reasons: [{ reason: 'MEASUREMENTS' }, { reason: 'CREDIT_HOLD' }] })).toBe(false)
    expect(onlyMeasurements({ reasons: [] })).toBe(false)
  })
})

describe('what is frozen (SAL-218)', () => {
  it('the cut sizes are locked with the stage they reached; none without a rule', () => {
    const cells = frozenCells(FREEZE_CUT)
    expect(cells.map((cell) => `${cell.seq}:${cell.size}:${cell.stage}:${cell.state}`)).toEqual(['10:48:CUT:CHANGE_REQUEST', '10:50:CUT:CHANGE_REQUEST'])
    expect(frozenGroups(cells, LINE_BLK)).toEqual([{ stage: 'CUT', state: 'CHANGE_REQUEST', sizes: ['48', '50'] }])
    expect(frozenGroups(cells, LINE_RED)).toEqual([])
    expect(frozenCells(FREEZE_NONE)).toEqual([])
  })

  it('each field at its strictest verdict', () => {
    const rows = Object.fromEntries(freezeRows(FREEZE_CUT).map((row) => [row.field, `${row.state}:${row.frozenFrom}`]))
    expect(rows).toEqual({ SIZE_QUANTITY: 'CHANGE_REQUEST:CUT', COLOURWAY: 'CHANGE_REQUEST:CUT', OPTION: 'OPEN:null', DELIVERY_DATE: 'OPEN:null', SHIP_TO: 'OPEN:null', PRICE: 'CHANGE_REQUEST:RELEASED' })
    expect(freezeRows(FREEZE_FINISHED).find((row) => row.field === 'SIZE_QUANTITY')?.state).toBe('BLOCKED')
  })

  it('an amendment’s frozen refusals and what they may become', () => {
    const problems = [{ path: 'body/lines/10/SIZE_QUANTITY' }, { path: 'body/lines/10/SIZE_QUANTITY' }, { path: 'body/DELIVERY_DATE' }, { path: 'body/lines/0/sizes' }]
    expect(frozenProblemsOf(problems)).toEqual([
      { seq: 10, field: 'SIZE_QUANTITY' },
      { seq: null, field: 'DELIVERY_DATE' },
    ])
    expect(frozenOffer([{ seq: 10, field: 'SIZE_QUANTITY' }], FREEZE_CUT)).toBe('priced')
    expect(frozenOffer([{ seq: 10, field: 'SIZE_QUANTITY' }], FREEZE_FINISHED)).toBe('blocked')
    expect(frozenOffer([], FREEZE_CUT)).toBeNull()
  })
})

describe('the priced change (SAL-219)', () => {
  const amendment = { lines: [{ id: LINE_BLK, sizes: [{ size: '50', quantity: 3 }] }] }

  it('the draft is checked before the preview; the reason before Apply', () => {
    expect(pricedProblems({ ...PRICED_EMPTY, fee: '0' }, TODAY)).toEqual({ fee: 'priced.problem.fee' })
    expect(pricedProblems({ ...PRICED_EMPTY, deposit: 'pct', pct: '120' }, TODAY)).toEqual({ pct: 'priced.problem.pct' })
    expect(pricedProblems({ ...PRICED_EMPTY, dueDate: '2026-10-01' }, TODAY)).toEqual({ dueDate: 'priced.problem.dueDate' })
    expect(pricedProblems(PRICED_EMPTY, TODAY, { price: true, final: true })).toEqual({ reason: 'priced.problem.reason' })
    expect(pricedProblems({ ...PRICED_EMPTY, fee: '25,50' }, TODAY)).toEqual({})
  })

  it('the body: the office’s words, the fee with a dot, the deposit as chosen (left out = the order’s own percent)', () => {
    expect(pricedBodyOf({ ...PRICED_EMPTY, fee: '25,50', labels: { [LINE_BLK]: ' Una giacca in più ', [LINE_RED]: '' } }, amendment, true)).toEqual({ lines: amendment.lines, labels: { [LINE_BLK]: 'Una giacca in più' }, fee: '25.50' })
    expect(pricedBodyOf({ ...PRICED_EMPTY, deposit: 'none' }, amendment, true).deposit).toBeNull()
    expect(pricedBodyOf({ ...PRICED_EMPTY, deposit: 'pct', pct: '30', kind: 'CAPARRA' }, amendment, true).deposit).toEqual({ pct: '30', kind: 'CAPARRA' })
    expect(pricedBodyOf({ ...PRICED_EMPTY, deposit: 'amount', amount: '100,00', dueDate: '2026-11-06' }, amendment, true).deposit).toEqual({ amount: '100.00', kind: 'ACCONTO', dueDate: '2026-11-06' })
    expect(pricedBodyOf({ ...PRICED_EMPTY, kind: 'CAPARRA' }, amendment, true).deposit).toEqual({ kind: 'CAPARRA' })
    // Without the price grain no money travels.
    expect(pricedBodyOf({ ...PRICED_EMPTY, fee: '25', deposit: 'pct', pct: '30' }, amendment, false)).toEqual({ lines: amendment.lines })
  })

  it('the caparra penitenziale is shown and held while it is off', () => {
    expect(depositKindChoices(DEPOSIT_KINDS_OFF)).toEqual([
      { kind: 'ACCONTO', available: true },
      { kind: 'CAPARRA', available: true },
      { kind: 'CAPARRA_PENITENZIALE', available: false },
    ])
    expect(depositKindChoices(null).find((entry) => entry.kind === 'CAPARRA_PENITENZIALE')?.available).toBe(false)
    expect([...EXTRA_DEPOSIT_KINDS]).toEqual(['ACCONTO', 'CAPARRA', 'CAPARRA_PENITENZIALE'])
  })

  it('the priced requests, newest first; the put-back for a turned-down one', () => {
    const list = pricedChanges(CHANGES.changes)
    expect(list.map((change) => change.revision)).toEqual([3, 2])
    expect(changeCounts(list[0]!)).toEqual({ changed: 1, added: 0, removed: 0, before: 8, after: 9 })
    expect(putBackOffered(list[1]!)).toBe(true)
    expect(putBackOffered(list[0]!)).toBe(false)
  })

  it('its refusals in this app’s words, from their place', () => {
    const t = createTranslator('en', messagesFor('en', [NAMESPACE])[NAMESPACE]!)
    const words = pricedProblemWords([{ path: 'body/lines/10/SIZE_QUANTITY' }, { path: 'body/deposit/amount' }], order('IN_PRODUCTION'), t)
    expect(words).toEqual(['DEMO-JKT-01 · BLK: Sizes and quantities cannot change any more', 'The extra deposit is refused as it is (its kind may be off, or it is more than the growth).'])
  })
})

describe('materials, the confirmation, the tech pack, the forecast', () => {
  it('the customer’s materials with their lots; more used than received is said', () => {
    const rows = materialRows(MATERIALS)
    expect(rows.map((row) => [row.itemCode, row.short, row.lots.map((lot) => lot.code)])).toEqual([
      ['ETI-DEMO-01', false, ['LOT-CLI-0012']],
      ['ZIP-DEMO-07', true, ['LOT-CLI-0013']],
    ])
  })

  it('the confirmation’s state, why Make and Send are held, the row verb', () => {
    expect(confirmationState(CONFIRMATION_SENT)).toBe('upToDate')
    expect(confirmationState(CONFIRMATION_OUTDATED)).toBe('outdated')
    expect(confirmationState(CONFIRMATION_NONE)).toBe('none')
    expect(confirmationState(CONFIRMATION_WAITING)).toBe('notYet')
    expect(confirmationHeld(CONFIRMATION_WAITING, { manage: true })?.key).toBe('held.confirmationWaiting')
    expect(confirmationHeld(CONFIRMATION_SENT, { manage: false })?.key).toBe('held.noManage')
    expect(confirmationHeld(CONFIRMATION_SENT, { manage: true })).toBeNull()
    expect(printHeld('PENDING_APPROVAL')?.key).toBe('held.confirmationWaiting')
    expect(printHeld('CANCELLED')?.key).toBe('held.confirmationCancelled')
    expect(printHeld('IN_PRODUCTION')).toBeNull()
  })

  it('the recipient: the quote’s contact with an e-mail, else the orders contact', () => {
    const contacts = [
      { id: 'a', name: 'Acquisti', email: 'acquisti@example.com', status: 'ACTIVE', roles: ['ORDERS'] },
      { id: 'b', name: 'Giulia', email: 'giulia@example.com', status: 'ACTIVE', roles: ['SALES'] },
      { id: 'c', name: 'Senza mail', email: null, status: 'ACTIVE', roles: ['ORDERS'] },
    ]
    expect(confirmationRecipient(contacts, 'b')).toEqual({ name: 'Giulia', email: 'giulia@example.com' })
    expect(confirmationRecipient(contacts, 'c')).toEqual({ name: 'Acquisti', email: 'acquisti@example.com' })
    expect(confirmationRecipient([contacts[2]!], null)).toBeNull()
  })

  it('the tech pack: in force, a newer version, opened from the version in force', () => {
    expect(packRows(TECH_PACK).map((row) => [row.state, row.named, row.current])).toEqual([
      ['inForce', 3, 3],
      ['newer', 1, 2],
    ])
    expect(packRows({ inquiry: null })).toEqual([])
  })

  it('the forecast of this order’s lines, from the sites its lines name (or the person’s)', () => {
    const forecasts = forecastsOf(PROMISE_LINES, PROMISE_LINES[1]!.order.id)
    expect([...forecasts.keys()]).toEqual([PROMISE_LINES[1]!.id])
    expect(forecastSites(order('IN_PRODUCTION'), [{ id: 's1' }, { id: 's2' }])).toEqual(['s1', 's2'])
    const withSite = order('IN_PRODUCTION')
    expect(forecastSites({ lines: withSite.lines.map((line) => ({ ...line, siteId: 's9' })) }, [{ id: 's1' }])).toEqual(['s9'])
  })
})

describe('By promise week (never re-ranked)', () => {
  it('ISO weeks from the Monday', () => {
    expect(mondayOf('2026-10-29')).toBe('2026-10-26')
    expect(mondayOf('2026-11-01')).toBe('2026-10-26')
    expect(isoWeek('2026-10-26')).toBe(44)
    expect(isoWeek('2026-12-28')).toBe(53)
    expect(isoWeek('2027-01-04')).toBe(1)
  })

  it('Late first, this week on, No promise last; cards by the backlog’s own place', () => {
    const columns = weekColumns(PROMISE_LINES, TODAY)
    expect(columns.map((column) => column.key)).toEqual(['EARLIER', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', 'NONE'])
    expect(columns[0]!.cards.map((card) => card.number)).toEqual(['SO-2026-0083'])
    expect(columns[1]!.cards).toEqual([])
    expect(columns.find((column) => column.key === '2026-11-02')!.cards.map((card) => [card.number, card.units])).toEqual([
      ['SO-2026-0088', 4],
      ['SO-2026-0084', 16],
    ])
    expect(columns.find((column) => column.key === '2026-11-16')!.cards.map((card) => card.number)).toEqual(['SO-2026-0084', 'SO-2026-0081'])
    expect(columns.find((column) => column.current)?.key).toBe('2026-10-26')
    expect(columns.at(-1)!.cards.map((card) => card.number)).toEqual(['SO-2026-0086'])
  })

  it('the site: the address’s, else the first by code', () => {
    expect(siteOf([{ id: 'b', code: 'B' }, { id: 'a', code: 'A' }], null)).toBe('a')
    expect(siteOf([{ id: 'b', code: 'B' }, { id: 'a', code: 'A' }], 'b')).toBe('b')
    expect(siteOf([], null)).toBeNull()
  })
})

describe('the list’s new view, tile and layout; the import; the new tab', () => {
  it('?reaccept=true is the API’s own filter; ?view=week the layout', () => {
    const params = (text: string) => new URLSearchParams(text)
    expect(rowsFromAddress(params('reaccept=true'))).toBe('reaccept')
    expect(rowsQuery('reaccept', '')).toMatchObject({ reaccept: true })
    expect(listAddress('/w/D/sales/orders', { rows: 'reaccept', q: '', layout: 'week' })).toBe('/w/D/sales/orders?view=week&reaccept=true')
    expect(layoutFromAddress(params('view=week'))).toBe('week')
    expect(ROW_VIEWS).toContain('reaccept')
    expect(TILES.find((tile) => tile.key === 'waitingForCustomer')?.rows).toBe('reaccept')
    expect(TILE_KEYS).toContain('waitingForCustomer')
  })

  it('Import orders: held with its reason; the importer has its own words', () => {
    expect(importHeldOf(['orders.view'])).toBe('import.held.manage')
    expect(importHeldOf(['orders.manage', 'files.upload'])).toBe('import.held.run')
    expect(importHeldOf(['orders.manage', 'imports.run', 'files.upload'])).toBeNull()
    expect(hasOwnWords(ORDERS_IMPORTER)).toBe(true)
  })

  it('refusals in words: the order moved (read again), the letterhead incomplete, a state that does not allow it', () => {
    expect(writeProblemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/version' }]))).toEqual({ key: 'problem.write.moved', reload: true })
    expect(writeProblemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'company/vatNumber' }, { path: 'company/rea' }]))).toEqual({ key: 'problem.write.letterhead', reload: false })
    expect(writeProblemOf(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'problem.write.state', reload: true })
    expect(writeProblemOf(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/to' }])).key).toBe('problem.write.noRecipient')
  })

  it('the confirmation tab is a built page', () => {
    expect(OFFICE_PAGES.has('/sales/orders/[id]/confirmation')).toBe(true)
  })

  it('the depth read parses the API’s answer (unknown fields dropped)', () => {
    const parsed = orderDepthSchema.parse({ ...orderDepth(), priority: { ...orderDepth().priority, words: { en: 'x', it: 'x' } }, season: { ...orderDepth().season!, notice: null } })
    expect(parsed.priority).toEqual(orderDepth().priority)
  })
})

describe('the words exist in both languages', () => {
  it('every code the screens say', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!)
      const has = (key: string) => expect(t(key, { count: 2 }), `${locale}: ${key}`).not.toBe(key)
      for (const level of PRIORITY_LEVELS) {
        has(`priority.level.${level}`)
        has(`priority.means.${level}`)
      }
      for (const state of SEASON_STATES) has(`season.stateValue.${state}`)
      for (const reason of WAIT_REASONS) has(`wait.${reason}`)
      for (const stage of [...FREEZE_STAGES, 'none']) has(`stage.${stage}`)
      for (const field of FREEZE_FIELDS) has(`field.${field}`)
      for (const state of CHANGE_YES_STATES) has(`changeYes.state.${state}`)
      for (const decision of CUSTOMER_DECISIONS) has(`decision.${decision}`)
      for (const kind of EXTRA_DEPOSIT_KINDS) has(`depositKind.${kind}`)
      for (const status of ['OPEN', 'PAID', 'WAIVED', 'CANCELLED']) has(`depositStatus.${status}`)
      for (const source of FINISH_SOURCES) has(`finish.${source}`)
      for (const risk of RISK_STATES) has(`risk.${risk}`)
      for (const kind of MILESTONE_KINDS) has(`milestone.kind.${kind}`)
      for (const gate of DOMAIN_GATES) has(`gate.${gate}`)
      for (const state of ['none', 'upToDate', 'outdated', 'notYet']) has(`confirmation.stateValue.${state}`)
      for (const mode of ['default', 'none', 'pct', 'amount']) has(`priced.depositMode.${mode}`)
      for (const kind of ['ADDED', 'REMOVED', 'CHANGED']) has(`priced.lineKind.${kind}`)
      for (const kind of ['changed', 'added', 'removed']) has(`pricedList.count.${kind}`)
      for (const key of ['held.noManage', 'held.final', 'held.noneSelected', 'held.tooMany', 'held.notWaiting', 'held.askStanding', 'held.withdrawNotYours', 'held.putBackNot', 'held.confirmationWaiting', 'held.confirmationCancelled', 'held.confirmationNot', 'import.held.manage', 'import.held.run'])
        has(key)
      for (const kind of ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'internal']) has(`problem.read.${kind}`)
      for (const kind of ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'step_up', 'internal', 'invalid', 'moved', 'state', 'season', 'noRecipient', 'letterhead']) has(`problem.write.${kind}`)
      for (const key of ['notice.priority', 'notice.season', 'notice.seasonCleared', 'notice.asked', 'notice.withdrawn', 'notice.confirmationSame', 'notice.planned', 'notice.putBack', 'notice.putBackDeposit', 'notice.priced', 'notice.pricedWaiting']) has(key)
      void DOMAIN_MILESTONE_STATES
    }
  })
})

const LEFT_KEY = /\b(?:common|held|import|tab|confirmation|problem|priority|season|wait|notice|stage|field|frozen|freeze|offer|priced|pricedList|decision|changeYes|depositKind|putBack|materials|pack|forecast|finish|risk|milestone|gate|list|week|selection|send)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/
const NOT_KEYS = /\b[\w.-]+@[\w.-]+\.\w+\b|\b[\w-]+\.(?:pdf|csv|xlsx)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('SCR-429 and SCR-430: every case draws in both languages with no key left on screen', () => {
  for (const screen of [importScreen, pdfScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(NOT_KEYS, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(120)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html, `${screen.screen}/${item.id} (${locale}): a permission name on screen`).not.toMatch(/\b(?:orders|files|imports|planning)\.(?:view|manage|read|run|apply)\b/)
        }
      }
    })
  }
})

describe('SCR-038 and SCR-039: the B-W2b-323 cases draw with no depth key left on screen', () => {
  for (const screen of [listScreen, recordScreen] as unknown as DesignScreen<unknown>[]) {
    const mine = screen.cases.filter((item) => item.id.startsWith('w2b-323'))
    it(`${screen.screen}: ${mine.length} cases × it, en`, () => {
      expect(mine.length).toBeGreaterThan(10)
      for (const item of mine) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(NOT_KEYS, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html, `${screen.screen}/${item.id} (${locale}): a permission name on screen`).not.toMatch(/\b(?:orders|files|imports|planning)\.(?:view|manage|read|run|apply)\b/)
        }
      }
    })
  }
})
