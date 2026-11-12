import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor, placeholdersOf } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { designScreen as historyScreen } from '../../../shell/panels/approvals/fixtures'
import { hasApprovalHistory, historyProblem, lineDetail, lineWords, mayReadHistory } from '../../../shell/panels/approvals/model'
import { HISTORY_ACTIONS } from '../../../shell/panels/approvals/api'
import { designScreen as automationScreen } from '../../admin/automation/fixtures'
import { DEPTH_ROWS, depthModel } from './depth/fixtures'
import { designScreen } from './fixtures'
import {
  amountOf,
  bulkHeld,
  controlsOf,
  countsOf,
  decimalMoney,
  decisionProblem,
  filterRows,
  heldOf,
  inboxAddress,
  INBOX_VIEWS,
  KNOWN_REFUSALS,
  kindsOf,
  nextReview,
  openIdOf,
  refusalOf,
  rowsOf,
  selectHeld,
  TILE_OF,
  valueText,
  type InboxRow,
} from './inbox'

/** Home › Approvals in depth (SCR-030, B-W2b-307), the approval history (SCR-352) and Approval rules (SCR-167): rules, words, cases. */

const NS = 'approvals-depth'
const params = (pairs: Record<string, string>) => ({ get: (name: string) => pairs[name] ?? null })
const free = { offline: false, busy: false }
const { WAITING_ROWS, PRICE_KEYS, PO, CHANGED, QUOTE, CHANGE_ORDER } = DEPTH_ROWS
const byKey = (key: string) => WAITING_ROWS.find((row) => row.key === key)!

describe('one inbox of every request (PLT-085)', () => {
  it('the three sources in one list: the queue oldest first, my requests newest first; Today’s own rows are not listed twice', () => {
    const keys = WAITING_ROWS.map((row) => row.source)
    expect(new Set(keys)).toEqual(new Set(['task', 'quote', 'attention']))
    const since = WAITING_ROWS.map((row) => row.since)
    expect([...since].sort()).toEqual(since)
    const doubled = rowsOf('waiting', { tasks: [], quotes: [], items: [CHANGE_ORDER.item!, { ...CHANGE_ORDER.item!, kind: 'QUOTE_APPROVAL', key: 'q' }, { ...CHANGE_ORDER.item!, kind: 'APPROVAL_TASK', key: 't' }] })
    expect(doubled.map((row) => row.kind)).toEqual(['CHANGE_ORDER'])
    // My requests and the decided ones never list Today’s rows (they are not mine to ask).
    expect(rowsOf('mine', { tasks: [], quotes: [], items: [CHANGE_ORDER.item!] })).toEqual([])
    const overdue = rowsOf('overdue', { tasks: [PO.task!, PRICE_KEYS.map(byKey)[0]!.task!], quotes: [], items: [] })
    expect(overdue.map((row) => row.task!.id)).toEqual([PO.task!.id])
  })

  it('one filter model: a kind, words, the changed ones — and the kinds with their counts', () => {
    const text = (row: InboxRow) => `${row.task?.summary ?? ''} ${row.item?.record.label ?? ''} ${row.quote?.number ?? ''}`
    expect(filterRows(WAITING_ROWS, { kind: 'PRICE_CHANGE', q: '', changed: false }, text)).toHaveLength(4)
    expect(filterRows(WAITING_ROWS, { kind: null, q: 'eco-demo', changed: false }, text).map((row) => row.kind)).toEqual(['CHANGE_ORDER'])
    expect(filterRows(WAITING_ROWS, { kind: null, q: '', changed: true }, text).map((row) => row.key)).toEqual([CHANGED.key])
    expect(kindsOf(WAITING_ROWS).find((entry) => entry.kind === 'PRICE_CHANGE')?.count).toBe(4)
  })

  it('the address keeps the view, the filters and the review', () => {
    const read = controlsOf(params({ view: 'mine', kind: 'PRICE_CHANGE', q: ' giacca ', changed: '1', open: 'x' }))
    expect(read).toEqual({ view: 'mine', kind: 'PRICE_CHANGE', q: ' giacca ', changed: true, open: 'x' })
    expect(inboxAddress(read)).toBe('?view=mine&kind=PRICE_CHANGE&q=giacca&changed=1&open=x')
    expect(controlsOf(params({ view: 'nope' })).view).toBe('waiting')
    expect(inboxAddress(controlsOf(null))).toBe('')
    expect(INBOX_VIEWS.map((view) => TILE_OF[view])).toEqual(['WAITING_FOR_ME', 'OVERDUE', 'ASKED_BY_ME', 'DECIDED_7_DAYS'])
  })

  it('the tiles add their sources; a source not read yet is "—" (null), never 0; one the person does not read counts 0', () => {
    const late = { date: '2026-11-01', days: -3, word: 'OVERDUE' as const }
    // Today's approvals as read; its quote and engine rows are the other sources' (never counted twice).
    const today = { items: [{ kind: 'CHANGE_ORDER', due: late }, { kind: 'CHANGE_ORDER', due: null }, { kind: 'QUOTE_APPROVAL', due: null }, { kind: 'APPROVAL_TASK', due: null }] }
    const tasks = { WAITING_FOR_ME: 4, OVERDUE: 1, ASKED_BY_ME: 2, DECIDED_7_DAYS: 3 }
    expect(countsOf({ tasks, quotes: { waiting: 1, mine: 0, decided: 2 }, today, reads: { tasks: true, quotes: true, today: true } })).toEqual({ waiting: 7, overdue: 2, mine: 2, decided: 5 })
    expect(countsOf({ tasks: null, quotes: { waiting: 1, mine: 0, decided: 2 }, today, reads: { tasks: true, quotes: true, today: true } }).waiting).toBeNull()
    expect(countsOf({ tasks: null, quotes: null, today, reads: { tasks: false, quotes: false, today: true } })).toEqual({ waiting: 2, overdue: 1, mine: 0, decided: 0 })
  })
})

describe('deciding: four eyes, the re-check, Approve N of one kind', () => {
  it('held with the reason before the click: its own page, my own request, not mine, changed, gone, offline', () => {
    expect(heldOf(CHANGE_ORDER, free)).toBe('inbox.held.ownPage')
    expect(heldOf(byKey(PRICE_KEYS[0]!), free)).toBeNull()
    const task = byKey(PRICE_KEYS[0]!).task!
    expect(heldOf({ ...byKey(PRICE_KEYS[0]!), task: { ...task, requester: { ...task.requester, me: true } } }, free)).toBe('inbox.held.own')
    expect(heldOf({ ...byKey(PRICE_KEYS[0]!), task: { ...task, approve: { allowed: false, why: 'x' } } }, free)).toBe('inbox.held.notYours')
    expect(heldOf(CHANGED, free)).toBe('inbox.held.changed')
    expect(heldOf({ ...byKey(PRICE_KEYS[0]!), task: { ...task, recheck: 'GONE' } }, free)).toBe('inbox.held.gone')
    expect(heldOf({ ...byKey(PRICE_KEYS[0]!), task: { ...task, status: 'APPROVED' } }, free)).toBe('inbox.held.notWaiting')
    expect(heldOf(byKey(PRICE_KEYS[0]!), { offline: true, busy: false })).toBe('inbox.held.offline')
    expect(heldOf(QUOTE, free)).toBeNull()
    expect(heldOf({ ...QUOTE, quote: { ...QUOTE.quote!, mayDecide: false, held: 'NEEDS_MARGIN' } }, free)).toBe('inbox.held.needsMargin')
  })

  it('only requests of one kind with no signature are ticked; a signed release is approved one by one', () => {
    expect(selectHeld(PO, free)).toBe('inbox.held.signedOneByOne')
    expect(selectHeld(byKey(PRICE_KEYS[1]!), free)).toBeNull()
    expect(bulkHeld([])).toBe('inbox.held.pickSome')
    expect(bulkHeld(PRICE_KEYS.map(byKey))).toBeNull()
    expect(bulkHeld([byKey(PRICE_KEYS[0]!), QUOTE])).toBe('inbox.held.oneKind')
  })

  it('after a decision the next request opens, else the one before; Today’s rows open their own page', () => {
    const ids = WAITING_ROWS.map(openIdOf).filter((id): id is string => id !== null)
    expect(nextReview(WAITING_ROWS, ids[0]!)).toBe(ids[1])
    expect(nextReview(WAITING_ROWS, ids.at(-1)!)).toBe(ids.at(-2))
    expect(openIdOf(CHANGE_ORDER)).toBeNull()
    expect(CHANGE_ORDER.href).toContain('decide=order:')
  })

  it('a refusal in words, and whether the inbox reads again (STALE: it changed since you looked)', () => {
    const stale = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/STALE', message: 'It changed' }])
    expect(refusalOf(stale)).toBe('STALE')
    expect(decisionProblem(stale)).toEqual({ key: 'refusal.STALE', reload: true })
    expect(decisionProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/NEW_CODE' }]))).toEqual({ key: 'refusal.other', reload: true })
    expect(decisionProblem(new ApiError('step_up', 403, 'forbidden', 'x', null, [{ path: 'stepUp' }]))).toEqual({ key: 'sign.codeAgain', reload: false })
    expect(decisionProblem(new ApiError('conflict', 409, 'version_conflict', 'x'))).toEqual({ key: 'refusal.moved', reload: true })
    expect(decisionProblem(null)).toEqual({ key: 'problem.internal', reload: false })
  })

  it('money only with its grain: the Amount is the first money fact the API sent, with the currency', () => {
    expect(amountOf(PO.task!)).toEqual({ value: '6120', currency: 'EUR' })
    expect(amountOf({ facts: PO.task!.facts.filter((fact) => fact.grain === null) })).toBeNull()
    expect(decimalMoney('6120', 'EUR', 'en')).toMatch(/6,120/)
    expect(decimalMoney('16120.5', 'EUR', 'it')).toMatch(/16\.120,50/)
    expect(valueText(null, { yes: 'Yes', no: 'No' })).toBe('—')
    expect(valueText(true, { yes: 'Yes', no: 'No' })).toBe('Yes')
    expect(valueText(['a', 'b'], { yes: 'Yes', no: 'No' })).toBe('a, b')
  })
})

describe('the approval history on a record (PLT-104)', () => {
  it('who did what, the meaning of a signature, the words with the reason code', () => {
    expect(lineWords({ action: 'APPROVED', meaning: 'RELEASED', by: { kind: 'PERSON', id: 'p', name: 'Fiona', me: false } })).toEqual({ key: 'history.line.APPROVED_AS.other', params: { name: 'Fiona', meaning: 'RELEASED' } })
    expect(lineWords({ action: 'STALE', meaning: null, by: { kind: 'SYSTEM', id: null, name: 'System', me: false } }).key).toBe('history.line.STALE.system')
    expect(lineDetail({ words: ' Over budget ', reasonCode: 'OVER_BUDGET' })).toBe('OVER_BUDGET · Over budget')
    expect(lineDetail({ words: null, reasonCode: null })).toBeNull()
    expect([historyProblem(403), historyProblem(500), historyProblem(null)]).toEqual(['forbidden', 'unavailable', 'unavailable'])
    expect(['PurchaseOrder', 'Quote', 'ChangeOrder', 'Operation', 'InspectionPlan'].every(hasApprovalHistory)).toBe(true)
    expect(hasApprovalHistory('Customer')).toBe(false)
    // Read only with a view permission of the record's type (the API answers 404 otherwise): Finance approves orders it does not view.
    expect(mayReadHistory('PurchaseOrder', new Set(['approvals.view', 'approvals.decide']))).toBe(false)
    expect(mayReadHistory('PurchaseOrder', new Set(['purchasing.view']))).toBe(true)
    expect(mayReadHistory('TimesheetApproval', new Set(['people.timesheets.team']))).toBe(true)
  })
})

// ---- every key in both languages -----------------------------------------------------------------------------------------

const SRC = fileURLToPath(new URL('../../..', import.meta.url))
const MINE = ['areas/home/approvals/Approvals.tsx', 'areas/home/approvals/inbox.ts', 'areas/home/approvals/api.ts', 'areas/home/approvals/view/InboxView.tsx', 'areas/home/approvals/view/TaskReview.tsx', 'areas/home/approvals/view/BulkApprove.tsx', 'shell/panels/approvals', 'areas/admin/automation/approval-rules']
function files(path: string): string[] {
  const full = join(SRC, path)
  if (statSync(full).isFile()) return [full]
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(path, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && !/fixtures|demo/.test(entry.name) ? [join(full, entry.name)] : []))
}
const PREFIXES = ['history', 'meaning', 'status', 'inbox', 'refusal', 'problem', 'review', 'recheck', 'context', 'conversation', 'sign', 'rejectDialog', 'bulk', 'keys', 'tile', 'table', 'empty', 'filter', 'col', 'kind', 'row', 'rule', 'whyMe', 'band', 'notice', 'held', 'later', 'rules']
const has = (key: string) =>
  LOCALES.every((locale) => {
    const dictionary = CATALOGUE[locale][NS] ?? {}
    return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
  })

describe('every string of approvals-depth exists in it and en', () => {
  it('the same keys and placeholders in both languages, no empty text', () => {
    const en = CATALOGUE.en[NS] ?? {}
    const it_ = CATALOGUE.it[NS] ?? {}
    expect(Object.keys(en).length).toBeGreaterThan(250)
    expect(Object.keys(it_).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) {
      expect(it_[key]?.trim(), `it ${key}`).not.toBe('')
      expect(placeholdersOf(it_[key] ?? ''), key).toEqual(placeholdersOf(en[key] ?? ''))
    }
  })

  it('every key the inbox, the history and the rules name exists (literally or built)', () => {
    const pattern = new RegExp(`['"\`]((?:${PREFIXES.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
    const keys = new Set<string>()
    for (const path of MINE) for (const file of files(path)) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(match[1]!)
    for (const action of [...HISTORY_ACTIONS, 'APPROVED_AS']) for (const who of ['me', 'other', 'system']) keys.add(`history.line.${action}.${who}`)
    for (const meaning of ['REVIEWED', 'APPROVED', 'RELEASED', 'VERIFIED']) keys.add(`meaning.${meaning}`)
    for (const status of ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'STALE']) keys.add(`status.${status}`)
    for (const view of INBOX_VIEWS) keys.add(`tile.${view}`).add(`table.${view}`).add(`empty.${view}.title`).add(`empty.${view}.body`)
    for (const code of KNOWN_REFUSALS) keys.add(`refusal.${code}`)
    for (const tab of ['change', 'context', 'conversation', 'history']) keys.add(`review.tab.${tab}`)
    for (const kind of ['forbidden', 'unavailable', 'rate_limited', 'signed_out', 'step_up', 'invalid', 'internal']) keys.add(`problem.${kind}`)
    keys.add('history.problem.forbidden').add('history.problem.unavailable').add('review.not_found').add('review.forbidden')
    // A source's own words: Today's and the W1 review's (other catalogues), never this one.
    for (const key of [...keys]) if (key.startsWith('problem.read.') || key.startsWith('problem.write.')) keys.delete(key)
    expect(keys.size).toBeGreaterThan(150)
    expect([...keys].filter((key) => !has(key))).toEqual([])
  })
})

// ---- every design case, both languages -----------------------------------------------------------------------------------

const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[a-zA-Z_]+(?:\\.[a-zA-Z_]+)*\\b`)
function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
    .replace(/https?:\/\/[^"\s<]+/g, '')
    .replace(/(?:href|id|aria-[a-z]+|for|class|data-[a-z-]+)="[^"]*"/g, '')
}

describe('every design case of B-W2b-307 draws in both languages with no key left on screen', () => {
  const screens: [DesignScreen<unknown>, (id: string) => boolean][] = [
    [designScreen as DesignScreen<unknown>, (id) => id.startsWith('w2b-307-')],
    [historyScreen as DesignScreen<unknown>, () => true],
    [automationScreen as DesignScreen<unknown>, (id) => id.startsWith('w2b-307-')],
  ]
  for (const [screen, mine] of screens) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}`, () => {
        const cases = screen.cases.filter((item) => mine(item.id))
        expect(cases.length).toBeGreaterThan(5)
        for (const item of cases) {
          const html = render(screen, item.model, locale)
          // The history part draws nothing without approvals.view (never a locked box), and a few lines while it loads.
          expect(html.length, item.id).toBeGreaterThan(screen.screen === 'SCR-352' ? -1 : 200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the states the design names, made-up data only (no real address, no real mail)', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const wanted of ['inbox', 'selected', 'bulk', 'review', 'sign', 'reject', 'own', 'changed', 'mine', 'decided', 'empty', 'loading', 'error', 'offline', 'no-permission']) expect(ids).toContain(`w2b-307-${wanted}`)
    const admin = automationScreen.cases.map((entry) => entry.id)
    for (const wanted of ['approval-rules', 'rule', 'rule-test', 'rule-new', 'rules-read-only', 'rules-empty', 'rules-loading', 'rules-error', 'rules-offline', 'rules-no-permission']) expect(admin).toContain(`w2b-307-${wanted}`)
    const text = JSON.stringify([designScreen.cases, historyScreen.cases, automationScreen.cases])
    expect(text).not.toMatch(/@[a-z0-9-]+\.(com|it|net)/i)
    expect(text).not.toMatch(/\/Users\//)
  })

  it('the inbox: the tiles, the notice, Approve 3 in the selection row, and no key hint above the list', () => {
    const selected = designScreen.cases.find((entry) => entry.id === 'w2b-307-selected')!
    const html = render(designScreen as DesignScreen<unknown>, selected.model, 'en')
    expect(html).toContain('Waiting for me')
    expect(html).toContain('1 request changed since it was asked')
    expect(html).toContain('Approve 3')
    expect(html.slice(0, html.indexOf('fw-list'))).not.toMatch(/<kbd/i)
    const none = render(designScreen as DesignScreen<unknown>, { depth: depthModel({ can: { quotes: { view: false, manage: false, approve: false, send: false }, tasks: false, decide: false, today: true, rules: false }, grains: { price: false, cost: false, margin: false } }) }, 'en')
    expect(none).not.toContain('Amount')
  })
})
