import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EARNINGS_REFUSALS, PERIOD_CHECKS } from '@nexus/factory-domain/people/earnings/rules'
import { CHANGE_REASONS, VERSION_REFUSALS, VERSION_STATES } from '@nexus/factory-domain/people/piecerates/rates'
import { PRECONDITION_CODES, preconditionsOf, type SwitchFacts } from '@nexus/factory-domain/people/piecerates/switch'
import { GUARANTEED_BASES, INCENTIVE_KINDS, OWN_FAULT_PAYS, PAID_TIME_RATES, PERIOD_EFFECTS, SCHEME_REFUSALS, SCHEME_STATES, TEAM_SPLITS } from '@nexus/factory-domain/people/schemes/rules'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { correctEntry, createVersion, openStatement, readLedger, startPiecePay, statementPdf, type Precondition, type SwitchView } from './api'
import { ENTRIES, GATE_MISSING, GATE_ON, GATE_READY, GATE_STOPPED, HELD, PERIOD_PREVIEW, PERIODS, RATES, rateRows, SCHEME, VERSION } from './demo/fixtures'
import { designScreen } from './fixtures'
import {
  ackRows,
  blankRate,
  blankScheme,
  bodyOfRate,
  bodyOfScheme,
  byStyle,
  checkRows,
  confirmHeld,
  draftOfScheme,
  everOn,
  hasRight,
  heldSelectable,
  minorOfTyped,
  missingOf,
  moneyText,
  NAMESPACE,
  pieceAddressOf,
  pieceAddressText,
  pieceCan,
  pieceOfDraft,
  preconditionHref,
  preconditionWords,
  problemWords,
  rateText,
  refusalCode,
  rowsOfTile,
  runTarget,
  SCHEME_FIELDS_HELD,
  schemeHeld,
  startDayFloor,
  tableCodeOf,
  versionHeld,
  versionsOfRows,
  type VersionDraft,
} from './model'
import { designScreen as payScreen } from './record/fixtures'
import { designScreen as sheetScreen } from './sheet/fixtures'
import { designScreen as statementScreen } from './statement/fixtures'

/**
 * People › Piece rates (SCR-158, SCR-158-rate-sheet, SCR-158-statement, SCR-085-pay; B-W2b-62 on the API of B-W2b-34, -38, -43):
 * the rights, the address, the switch coming first, every sentence of the API said in our words, the drafts' rules, what a
 * statement walk reads, the calls as the API takes them, and every design case in both languages with no key on screen.
 */

const catalogue = (locale: 'it' | 'en') => createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE] ?? {})
const FACTS: SwitchFacts = {
  today: '2026-11-02',
  onFrom: '2026-11-02',
  scanSubject: 'WORKER',
  siteBasis: { kind: 'UNION_AGREEMENT', reference: 'Accordo 1' },
  performanceGateOpen: true,
  ccnlName: 'CCNL',
  ccnlArticle: 'art. 1',
  workerNotice: { id: 'n', label: '2026-10', kind: 'WORKER_FLOOR', status: 'PUBLISHED' },
  dpia: { id: 'd', versionNo: 1, status: 'STORED' },
  consultantName: 'Studio',
  consultantAgreedOn: '2026-10-01',
  scheme: { id: 's', name: 'Schema', status: 'ACTIVE', siteId: null, validFrom: '2026-10-01', validTo: null },
  siteId: 'site',
  ratesInForce: 1,
  activeWorkers: 4,
  workersNotTold: 0,
  earningCodes: 3,
  unmappedEarningCodes: [],
} as SwitchFacts

/** Each way a precondition can read: the API's sentences as the domain writes them. */
const VARIANTS: readonly Partial<SwitchFacts>[] = [
  {},
  { scanSubject: 'STATION' as SwitchFacts['scanSubject'] },
  { siteBasis: null },
  { performanceGateOpen: false },
  { workerNotice: null },
  { workerNotice: { id: 'n', label: '2026-09', kind: 'WORKER_FLOOR', status: 'DRAFT' } },
  { dpia: null },
  { dpia: { id: 'd', versionNo: 2, status: 'DRAFT' } },
  { ccnlName: null },
  { consultantName: null },
  { consultantAgreedOn: '2026-12-01' },
  { scheme: null },
  { scheme: { id: 's', name: 'Schema', status: 'DRAFT', siteId: null, validFrom: '2026-10-01', validTo: null } },
  { scheme: { id: 's', name: 'Schema', status: 'ACTIVE', siteId: 'other', validFrom: '2026-10-01', validTo: null } },
  { scheme: { id: 's', name: 'Schema', status: 'ACTIVE', siteId: null, validFrom: '2026-12-01', validTo: null } },
  { ratesInForce: 0 },
  { activeWorkers: 0 },
  { workersNotTold: 2 },
  { earningCodes: 0 },
  { unmappedEarningCodes: ['PIECES'] },
]

function viewOf(facts: SwitchFacts): SwitchView {
  return {
    ...GATE_READY,
    recorded: {
      ...GATE_READY.recorded,
      ccnlName: facts.ccnlName,
      ccnlArticle: facts.ccnlArticle,
      workerNotice: facts.workerNotice ? { id: facts.workerNotice.id, label: facts.workerNotice.label, status: facts.workerNotice.status } : null,
      dpia: facts.dpia,
      consultantName: facts.consultantName,
      consultantAgreedOn: facts.consultantAgreedOn,
      scheme: facts.scheme ? { ...facts.scheme, kind: 'PIECE_RATE', lineId: null } : null,
    },
    preconditions: preconditionsOf(facts) as unknown as Precondition[],
  }
}

describe('piece rates: who may do what', () => {
  it('reads the rights from the session; one person’s pay needs the permission AND the pay grain', () => {
    const can = pieceCan(['people.piecerates.view', 'people.earnings.records'])
    expect(can).toMatchObject({ view: true, manage: false, switch: false, records: true, pay: false })
    expect(hasRight(can)).toBe(false)
    expect(hasRight(pieceCan(['people.earnings.records', 'money.pay']))).toBe(true)
  })
})

describe('piece rates: the address', () => {
  it('holds the filters and the open records, and gives back the terms it does not own', () => {
    const address = pieceAddressOf(new URLSearchParams('tile=TRIAL&rates=all&q=cuc&open=v1&ledgerKind=SCAN&held=all&resolve=h1&entry=e1&period=p1&site=s1'))
    expect(address).toMatchObject({ tile: 'TRIAL', allVersions: true, q: 'cuc', open: 'v1', ledgerKind: 'SCAN', heldAll: true, resolve: 'h1', entry: 'e1', period: 'p1', site: 's1' })
    expect(pieceAddressOf(new URLSearchParams(pieceAddressText(address).slice(1)))).toEqual(address)
    expect(pieceAddressText(pieceAddressOf(null), new URLSearchParams('view=mine&tile=TRIAL'))).toBe('?view=mine')
  })
  it('ignores a tile or a kind it does not know, and never takes a person', () => {
    expect(pieceAddressOf(new URLSearchParams('tile=PEOPLE&ledgerKind=WORKER'))).toMatchObject({ tile: null, ledgerKind: null })
    expect(Object.keys(pieceAddressOf(null)).filter((key) => /employee|worker|person/i.test(key))).toEqual([])
  })
})

describe('piece rates: the switch comes first', () => {
  it('a site that was never on has nothing of a person; on, or stopped with a window behind it, it has', () => {
    expect(everOn(GATE_READY)).toBe(false)
    expect(everOn(GATE_MISSING)).toBe(false)
    expect(everOn(GATE_ON)).toBe(true)
    expect(everOn(GATE_STOPPED)).toBe(true)
    expect(everOn({ state: 'OFF', onFrom: null, earlierWindows: [{ from: '2026-01-01', to: '2026-02-01' }] })).toBe(true)
  })
  it('with piece pay off no case draws a period, a ledger or a held scan', () => {
    const screen = designScreen as DesignScreen<unknown>
    for (const id of ['off-missing', 'off-ready']) {
      const entry = screen.cases.find((row) => row.id === id)!
      const model = (entry.model as { model: { ever: boolean; periods: unknown; ledger: unknown; held: unknown } }).model
      expect(model).toMatchObject({ ever: false, periods: null, ledger: null, held: null })
    }
  })
  it('a start names the day it may start from: not before today, not before the last window ended', () => {
    expect(startDayFloor({ today: '2026-11-02', offFrom: null })).toBe('2026-11-02')
    expect(startDayFloor({ today: '2026-11-02', offFrom: '2026-11-05' })).toBe('2026-11-05')
  })
  it('links a precondition to where it is kept only while that page is built', () => {
    expect(preconditionHref('SITE_BASIS', '/w/DEMO', () => true)).toBe('/w/DEMO/production/settings')
    expect(preconditionHref('PERFORMANCE_GATE', '/w/DEMO', () => false)).toBeNull()
    expect(preconditionHref('RATES_PUBLISHED', '/w/DEMO', () => false)).toBe('#rates')
    expect(preconditionHref('CCNL', '/w/DEMO', () => true)).toBeNull()
  })
})

describe('piece rates: the API’s sentences in our words', () => {
  it('every sentence of the domain reaches its own key, in both languages, with its figures', () => {
    const seen = new Set<string>()
    for (const variant of VARIANTS) {
      const facts = { ...FACTS, ...variant }
      const view = viewOf(facts)
      for (const item of view.preconditions) {
        const words = preconditionWords(item, view)
        seen.add(words.key)
        for (const locale of LOCALES) {
          const text = catalogue(locale)(words.key, words.params)
          expect(text, `${item.code}: ${item.words}`).not.toContain(words.key)
          expect(text).not.toMatch(/\{\w+\}/)
        }
      }
    }
    expect(seen).toEqual(new Set(['SITE_BASIS.met', 'SITE_BASIS.station', 'SITE_BASIS.noBasis', 'PERFORMANCE_GATE.met', 'PERFORMANCE_GATE.off', 'WORKER_NOTICE.none', 'WORKER_NOTICE.wrong', 'WORKER_NOTICE.met', 'DPIA.none', 'DPIA.wrong', 'DPIA.met', 'CCNL.none', 'CCNL.met', 'CONSULTANT.none', 'CONSULTANT.met', 'CONSULTANT.later', 'SCHEME.none', 'SCHEME.met', 'SCHEME.notActive', 'SCHEME.otherSite', 'SCHEME.notInForce', 'RATES_PUBLISHED.noRates', 'RATES_PUBLISHED.noWorkers', 'RATES_PUBLISHED.notTold', 'RATES_PUBLISHED.met', 'EARNING_CODES.none', 'EARNING_CODES.unmapped', 'EARNING_CODES.met'].map((key) => `gate.${key}`)))
  })
  it('every refusal, check, state and choice the API can name is in both languages', () => {
    const keys = [
      ...[...VERSION_REFUSALS, ...SCHEME_REFUSALS, ...EARNINGS_REFUSALS].map((code) => `refusal.${code}`),
      ...PRECONDITION_CODES.flatMap((code) => ['label', 'law', 'plain', 'kept'].map((part) => `gate.${code}.${part}`)),
      ...VERSION_STATES.map((state) => `state.${state}`),
      ...CHANGE_REASONS.map((reason) => `why.${reason}`),
      ...INCENTIVE_KINDS.flatMap((kind) => [`kind.${kind}`, `kindHint.${kind}`]),
      ...GUARANTEED_BASES.map((basis) => `basisG.${basis}`),
      ...TEAM_SPLITS.map((split) => `split.${split}`),
      ...OWN_FAULT_PAYS.map((pay) => `own.${pay}`),
      ...PAID_TIME_RATES.map((rate) => `paid.${rate}`),
      ...SCHEME_STATES.map((state) => `schemeState.${state}`),
      ...PERIOD_EFFECTS.map((effect) => `effect.${effect}`),
      ...SCHEME_FIELDS_HELD.map((field) => `scheme.held.${field}`),
    ]
    for (const locale of LOCALES) {
      const t = catalogue(locale)
      for (const key of keys) expect(t(key, { pct: '50' }), key).not.toBe(key)
      for (const check of PERIOD_CHECKS) for (const count of [1, 2]) expect(t(`check.${check}`, { count })).not.toContain('check.')
    }
  })
  it('reads a refusal and a refused start from an API error, never its English', () => {
    const refused = new ApiError('conflict', 409, 'conflict', 'English', null, [{ path: 'refusal/NOT_CLOCKED_IN_YET' }])
    expect(refusalCode(refused)).toBe('NOT_CLOCKED_IN_YET')
    expect(problemWords(refused)).toEqual({ key: 'refusal.NOT_CLOCKED_IN_YET' })
    const start = new ApiError('conflict', 409, 'conflict', 'English', null, [{ path: 'preconditions/CCNL' }, { path: 'preconditions/SCHEME' }])
    expect(missingOf(start)).toEqual(['CCNL', 'SCHEME'])
    expect(problemWords(start)).toEqual({ key: 'problem.preconditions' })
    expect(problemWords(new Error('offline'))).toEqual({ key: 'problem.unavailable' })
    expect(problemWords(new ApiError('invalid', 400, 'validation_failed', 'English', null, [{ path: 'company/vatNumber' }]))).toEqual({ key: 'problem.companyData' })
  })
})

describe('piece rates: figures', () => {
  it('says money by the grain: null when the API dropped it, never 0', () => {
    expect(moneyText(undefined, 'EUR', 'it')).toBeNull()
    expect(moneyText(null, 'EUR', 'en')).toBeNull()
    expect(moneyText(1234, 'EUR', 'en')).toBe('€12.34')
    expect(rateText(undefined, 'EUR', 'en')).toBeNull()
    expect(rateText('0.123456', 'EUR', 'en')).toBe('€0.123456')
  })
  it('turns a typed amount into minor units; anything else is not an amount', () => {
    expect(minorOfTyped('12,50')).toBe(1250)
    expect(minorOfTyped('-3')).toBe(-300)
    expect(minorOfTyped('1.234')).toBeNull()
    expect(minorOfTyped('abc')).toBeNull()
  })
})

describe('piece rates: the rate table', () => {
  const rows = RATES.rows
  it('a tile is a filter: trials ending in 14 days or ended, versions not read by all', () => {
    expect(rowsOfTile(rows, 'TRIAL', '2026-11-02').map((row) => row.version.state)).toEqual(['PROVISIONAL', 'PROVISIONAL'])
    expect(rowsOfTile(rows, 'UNREAD', '2026-11-02').every((row) => row.version.readBy.of > row.version.readBy.read)).toBe(true)
    expect(rowsOfTile(rows, null, '2026-11-02')).toHaveLength(rows.length)
  })
  it('groups by style: the style is said on its first row only', () => {
    const grouped = byStyle(rows)
    expect(grouped.filter((row) => row.first)).toHaveLength(1)
    expect(grouped[0]!.version.versionNo).toBeGreaterThanOrEqual(grouped.at(-1)!.version.versionNo)
  })
  it('a row is chosen to confirm only once its trial let it, and a version confirms whole', () => {
    const ended = rows.find((row) => row.version.trialEndsOn === '2026-10-30')!
    const running = rows.find((row) => row.version.trialEndsOn === '2026-11-10')!
    expect(confirmHeld(ended, '2026-11-02')).toBeNull()
    expect(confirmHeld(running, '2026-11-02')).toEqual({ key: 'rates.held.trialRunning', params: { day: '2026-11-10' } })
    expect(confirmHeld(rows[0]!, '2026-11-02')).toEqual({ key: 'rates.held.notProvisional' })
    const sameVersion = rateRows().filter((row) => row.version.state === 'CONFIRMED')
    expect(versionsOfRows(rateRows(), sameVersion.map((row) => row.rate.id))).toEqual({ ids: [sameVersion[0]!.version.id], rates: 2 })
  })
})

describe('piece rates: a new rate version', () => {
  const rate = { ...blankRate('r'), operationId: 'op', standardMinutes: '96.5', ratePerMinute: '0,12' }
  const draft = (over: Partial<VersionDraft> = {}): VersionDraft => ({ tableId: 't', changeReason: 'NEW', changeNote: '', effectiveFrom: '2026-12-01', provisional: false, trialEndsOn: '', rates: [rate], ...over })
  it('says what SMV × €/min makes, by the domain’s own rule, and sends decimals with a point', () => {
    expect(pieceOfDraft(rate)).toBe('11.58')
    expect(pieceOfDraft({ ...rate, ratePerMinute: 'x' })).toBeNull()
    expect(bodyOfRate(rate)).toMatchObject({ operationId: 'op', sizeBand: 'ALL', basis: 'SMV_RATE', standardMinutes: '96.5', ratePerMinute: '0.12', ratePerPiece: null })
    expect(bodyOfRate({ ...blankRate('f'), operationId: 'op', basis: 'FIXED', ratePerPiece: '0,30' })).toMatchObject({ ratePerMinute: null, ratePerPiece: '0.30' })
  })
  it('holds Create version with why, before the click', () => {
    const today = '2026-11-02'
    expect(versionHeld(draft(), today)).toBeNull()
    expect(versionHeld(draft({ tableId: '' }), today)).toEqual({ key: 'version.held.table' })
    expect(versionHeld(draft({ changeReason: '' }), today)).toEqual({ key: 'version.held.reason' })
    expect(versionHeld(draft({ changeReason: 'CORRECTION' }), today)).toEqual({ key: 'version.held.correction' })
    expect(versionHeld(draft({ effectiveFrom: '2026-10-01' }), today)).toEqual({ key: 'version.held.past' })
    expect(versionHeld(draft({ provisional: true }), today)).toEqual({ key: 'version.held.trial' })
    expect(versionHeld(draft({ provisional: true, trialEndsOn: '2026-12-01' }), today)).toEqual({ key: 'version.held.trialOrder' })
    expect(versionHeld(draft({ rates: [] }), today)).toEqual({ key: 'version.held.noRates' })
    expect(versionHeld(draft({ rates: [rate, rate] }), today)).toEqual({ key: 'version.held.twice' })
    expect(versionHeld(draft({ rates: [{ ...rate, ratePerMinute: '' }] }), today)).toEqual({ key: 'version.held.values' })
  })
  it('makes a table’s code from its name', () => {
    expect(tableCodeOf('  Tariffe giacca è 2 ')).toBe('TARIFFE-GIACCA-2')
  })
})

describe('piece rates: the scheme', () => {
  it('a scheme in force gives a new draft from today; a draft is edited as it is', () => {
    expect(draftOfScheme(SCHEME, '2026-11-02', true).validFrom).toBe('2026-11-02')
    expect(draftOfScheme(SCHEME, '2026-11-02', false).validFrom).toBe(SCHEME.scheme.validFrom)
  })
  it('asks the domain’s own rules, and clears what another kind uses', () => {
    const blank = blankScheme('2026-11-02')
    expect(schemeHeld(blank, '2026-11-02')).toEqual({ key: 'scheme.held.name' })
    expect(schemeHeld({ ...blank, name: 'A', kind: 'STANDARD_MINUTE_BONUS' }, '2026-11-02')).toEqual({ key: 'scheme.held.efficiencyThresholdPct' })
    expect(schemeHeld({ ...blank, name: 'A', validFrom: '2026-10-01' }, '2026-11-02')).toEqual({ key: 'scheme.held.past' })
    expect(schemeHeld({ ...blank, name: 'A' }, '2026-11-02')).toBeNull()
    expect(bodyOfScheme({ ...blank, name: 'A', efficiencyThresholdPct: '110', ownFaultRatePct: '50', teamSplit: 'HOURS_PRESENT' })).toMatchObject({ efficiencyThresholdPct: null, ownFaultRatePct: null, teamSplit: null })
  })
})

describe('piece rates: periods, statements and held scans', () => {
  it('the band runs the earliest month not in review; none: a new one for this month', () => {
    expect(runTarget(PERIODS, '2026-11-02').month).toBe('2026-11')
    expect(runTarget([{ ...PERIODS[0]!, month: '2026-10', status: 'PREVIEW' }, PERIODS[0]!], '2026-11-02').month).toBe('2026-10')
    expect(runTarget([PERIODS[2]!], '2026-11-02')).toEqual({ month: '2026-11', period: null })
  })
  it('says what blocks first', () => {
    const rows = checkRows(PERIOD_PREVIEW)
    expect(rows[0]).toMatchObject({ blocking: true })
    expect(rows.at(-1)).toMatchObject({ blocking: false })
  })
  it('a decided hold cannot be chosen again', () => {
    expect(heldSelectable(HELD[0]!)).toBeNull()
    expect(heldSelectable(HELD[2]!)).toEqual({ key: 'held.decided' })
  })
  it('the tracker lists each worker once, the unread first', () => {
    const rows = ackRows(VERSION)
    expect(new Set(rows.map((row) => row.workerId)).size).toBe(rows.length)
    expect(rows[0]!.read).toBeNull()
  })
})

describe('piece rates: no name in a list (Owner answer W1)', () => {
  const NAMED = /\b(employeeId|workerId|employee|person)\b/
  it('the ledger and held rows carry no person, by the API’s shape and in the screen’s columns', () => {
    expect(Object.keys(ENTRIES[0]!).filter((key) => NAMED.test(key))).toEqual([])
    expect(Object.keys(HELD[0]!).filter((key) => NAMED.test(key))).toEqual([])
    for (const file of ['view/LedgerSection.tsx', 'view/HeldSection.tsx', 'view/PeriodsSection.tsx', 'view/RatesSection.tsx']) {
      const source = readFileSync(join(__dirname, file), 'utf8')
      expect(source, file).not.toMatch(/headerName:\s*t\('[^']*(worker|employee|person)/i)
      expect(source, file).not.toMatch(/\.person\b|employeeId/)
    }
  })
  it('the ledger read sends no person key', async () => {
    const { api, calls } = mockApi([{ status: 200, body: { entries: [], nextCursor: null, words: ['English'] } }])
    await readLedger(api, { siteId: 's1', periodId: 'p1', lineId: null, kind: 'SCAN', cursor: null })
    expect(calls[0]!.url).toBe('/api/people/earnings/ledger?siteId=s1&periodId=p1&kind=SCAN&limit=100')
  })
})

interface Sent {
  url: string
  method: string
  body: unknown
  key: string | null
}

function mockApi(answers: readonly { status: number; body?: unknown; bytes?: Uint8Array }[]) {
  const calls: Sent[] = []
  let at = 0
  const fetcher = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    calls.push({ url: String(url), method: String(init.method ?? 'GET'), body: typeof init.body === 'string' ? JSON.parse(init.body) : null, key: headers.get('idempotency-key') })
    const answer = answers[at++] ?? { status: 500 }
    if (answer.bytes) return new Response(answer.bytes as BodyInit, { status: answer.status, headers: { 'content-type': 'application/pdf' } })
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, api: createApiClient({ baseUrl: '/api', fetch: fetcher, company: 'DEMO', csrfToken: () => 'csrf-demo' }) }
}

describe('piece rates: the calls as the API takes them', () => {
  it('Start sends its version, day, reason and the key the step-up repeats', async () => {
    const { api, calls } = mockApi([{ status: 200, body: GATE_ON }])
    await startPiecePay(api, 's1', { version: 4, onFrom: '2026-11-02', reason: 'Accordo' }, 'key-1')
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/people/piece-rates/sites/s1/switch/start', key: 'key-1', body: { version: 4, onFrom: '2026-11-02', reason: 'Accordo' } })
  })
  it('a new version is one call with its rates, each write its own key', async () => {
    const { api, calls } = mockApi([{ status: 201, body: VERSION }])
    await createVersion(api, 't1', { changeReason: 'NEW', effectiveFrom: '2026-12-01', copy: 'NONE', rates: [] })
    expect(calls[0]).toMatchObject({ url: '/api/people/piece-rates/tables/t1/versions', method: 'POST' })
    expect(calls[0]!.key).toBeTruthy()
  })
  it('a correction with no amount only takes the entry back', async () => {
    const { api, calls } = mockApi([{ status: 200, body: { ...ENTRIES[0], person: { employeeId: 'e', name: 'A', code: null }, reversedById: null, canCorrect: false } }])
    await correctEntry(api, 'x', 'Sbagliata', null)
    expect(calls[0]!.body).toEqual({ reason: 'Sbagliata' })
  })
  it('a lead’s opening says why; HR’s needs nothing', async () => {
    const { api, calls } = mockApi([{ status: 500 }, { status: 500 }])
    await openStatement(api, 'st1', 'PAY_QUERY').catch(() => undefined)
    await openStatement(api, 'st1').catch(() => undefined)
    expect(calls[0]!.body).toEqual({ reason: 'PAY_QUERY' })
    expect(calls[1]!.body).toEqual({})
  })
  it('the statement’s PDF is a POST: each opening is recorded', async () => {
    const { api, calls } = mockApi([{ status: 200, bytes: new TextEncoder().encode('%PDF-') }])
    const pdf = await statementPdf(api, 'st1')
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/people/statements/st1/pdf' })
    expect(new TextDecoder().decode(pdf)).toBe('%PDF-')
  })
})

describe('piece rates: every design case in both languages', () => {
  const LEFT_KEY = /(?:^|[>\s"])(?:band|gate|tiles|rates|record|version|publish|scheme|periods|period|statement|ledger|held|resolve|pay|sheet|pdf|correct|lock|common|problem|refusal|check|start|stop|pre|paper|publication|ack|keys|sites|privacy|later|state|why|kind|basis|basisG|split|own|paid|effect|hold|holdStatus|statementStatus|dispute|confirm|stepUp|noAccess)\.[a-zA-Z_]+/
  for (const screen of [designScreen, sheetScreen, statementScreen, payScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: renders each case, no key on screen`, () => {
      for (const locale of LOCALES) {
        const messages = messagesFor(locale, [NAMESPACE, 'people', 'lists', 'shell', 'ds-words'])
        for (const entry of screen.cases) {
          const html = renderToString(createElement(I18nProvider, { locale, messages }, createElement(screen.view as ComponentType<{ model: unknown }>, { model: entry.model })))
          expect(html.length, entry.id).toBeGreaterThan(0)
          expect(html, `${screen.screen}/${entry.id}/${locale}`).not.toMatch(LEFT_KEY)
        }
      }
    }, 120_000)
  }
  it('every word a view asks for is in the catalogue', () => {
    const t = catalogue('en')
    const walkDir = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walkDir(join(dir, name)) : /\.tsx?$/.test(name) && !name.includes('vitest') ? [join(dir, name)] : []))
    const missing: string[] = []
    for (const file of walkDir(__dirname)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\bt\('([a-zA-Z]+(?:\.[a-zA-Z_]+)+)'/g)) if (t(match[1]!, { count: 2 }) === match[1]) missing.push(`${file}: ${match[1]}`)
      for (const match of readFileSync(file, 'utf8').matchAll(/key: '([a-z][a-zA-Z]+(?:\.[a-zA-Z_]+)+)'/g)) if (t(match[1]!, { count: 2 }) === match[1]) missing.push(`${file}: ${match[1]}`)
    }
    expect(missing).toEqual([])
  })
})
