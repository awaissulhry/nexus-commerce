import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { createScopedTranslator, messagesFor } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { I18nProvider } from '../../../lib/i18n/provider'
import { qualityCan } from '../../quality/_shared/model'
import type { Entry, EntryDetail } from './api'
import { designScreen as listScreen, detailOf, ENTRIES, RELEASES, REVERSAL_ID, DEMO_LOT_ID, TRACE, TRACE_NOTHING_LEFT } from './fixtures'
import { designScreen as entryScreen } from './record/fixtures'
import {
  actionHeld,
  addressState,
  blankDraft,
  canTrace,
  concernSummary,
  dayInstant,
  draftProblems,
  evidenceSubject,
  nextAction,
  registerCsv,
  sourceLink,
  splitCodes,
  tileCounts,
  viewQuery,
  viewRows,
} from './model'

const params = (query: string) => new URLSearchParams(query)
const row = (n: number) => ENTRIES.find((entry) => entry.reference.endsWith(String(n).padStart(4, '0')))!
const en = createScopedTranslator('en', messagesFor('en', ['register', 'quality']), 'register')
const MANAGE = qualityCan(['compliance.register.view', 'compliance.register.manage'])
const VIEW_ONLY = qualityCan(['compliance.register.view'])

describe('views, filters and the address', () => {
  it('reads ?view= first, then the API’s own filters (Today links ?status=OPEN), else every entry', () => {
    expect(addressState(params('view=closed'))).toEqual({ view: 'closed', filters: { kind: null, risk: null } })
    expect(addressState(params('status=OPEN'))).toEqual({ view: 'open', filters: { kind: null, risk: null } })
    expect(addressState(params('status=OPEN&risk=YES')).view).toBe('risk')
    expect(addressState(params('status=OPEN&risk=ASSESSING&kind=RECALL'))).toEqual({ view: 'assessing', filters: { kind: 'RECALL' } })
    expect(addressState(params('status=CLOSED&risk=NO'))).toEqual({ view: 'closed', filters: { kind: null, risk: 'NO' } })
    expect(addressState(params('kind=WRONG&view=nonsense'))).toEqual({ view: 'all', filters: { kind: null, risk: null } })
    expect(addressState(null).view).toBe('all')
  })

  it('sends each view as the API’s query; the view’s own risk wins over a risk filter', () => {
    expect(viewQuery('all', { kind: 'COMPLAINT' }, ' sleeve ', 50)).toEqual({ kind: 'COMPLAINT', risk: null, q: 'sleeve', limit: 50 })
    expect(viewQuery('risk', { risk: 'NO' }, '', 100)).toMatchObject({ status: 'OPEN', risk: 'YES', limit: 100 })
    expect(viewQuery('assessing', {}, '', 50)).toMatchObject({ status: 'OPEN', risk: 'ASSESSING' })
    expect(viewQuery('uninformed', {}, '', 50)).toMatchObject({ status: 'OPEN', risk: null })
    expect(viewQuery('closed', {}, '', 50)).toMatchObject({ status: 'CLOSED' })
  })

  it('"distributors not yet informed" keeps the open entries not marked as informed (what the row fields prove)', () => {
    const shown = viewRows('uninformed', ENTRIES).map((entry) => entry.reference)
    expect(shown).toEqual(['REG-DEMO-2026-0008', 'REG-DEMO-2026-0005', 'REG-DEMO-2026-0002'])
    expect(viewRows('all', ENTRIES)).toHaveLength(ENTRIES.length)
  })

  it('counts the tiles with the list’s own rules; a read stopped at the limit says "at least"', () => {
    const open = ENTRIES.filter((entry) => entry.status === 'OPEN')
    const closed = ENTRIES.filter((entry) => entry.status === 'CLOSED')
    const tiles = tileCounts(open, closed)
    expect(tiles.open).toEqual({ count: 5, complete: true })
    expect(tiles.risk?.count).toBe(2)
    expect(tiles.assessing?.count).toBe(2)
    expect(tiles.uninformed?.count).toBe(viewRows('uninformed', open).length)
    expect(tiles.closed).toEqual({ count: 3, complete: true })
    expect(tileCounts(open, null).closed).toBeNull()
    expect(tileCounts(open, closed, 5).open?.complete).toBe(false)
  })
})

describe('words of a row and the CSV', () => {
  it('names the first batches or serials and how many more', () => {
    expect(concernSummary(row(5))).toEqual({ kind: 'batch', shown: ['B-DEMO-0120', 'B-DEMO-0121'], more: 1 })
    expect(concernSummary(row(6))).toMatchObject({ kind: 'serial', more: 3 })
    expect(concernSummary(row(2))).toEqual({ kind: 'none', shown: [], more: 0 })
  })

  it('exports the view in the person’s language, one line per entry, quoting what holds a separator', () => {
    const csv = registerCsv([row(7), row(4)], en)
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('Reference,Reported on,Kind')
    expect(lines[1]).toContain('REG-DEMO-2026-0007')
    expect(lines[1]).toContain('Non-conformity')
    expect(lines[1]).toContain('A release taken back')
    expect(lines[2]).toContain('Closed')
    const it = createScopedTranslator('it', messagesFor('it', ['register', 'quality']), 'register')
    expect(registerCsv([row(4)], it).split('\r\n')[0]).toContain('Riferimento')
    expect(registerCsv([{ ...row(4), style: { ...row(4).style, name: 'Demo, "quoted"' } }], en)).toContain('"Demo, ""quoted"""')
  })
})

describe('the next duty and why an action is held', () => {
  const detail = (over: Partial<Entry>, shippedGoods = true): EntryDetail => detailOf({ ...row(8), ...over }, shippedGoods ? TRACE : TRACE_NOTHING_LEFT)

  it('walks the law’s order: assess → corrective action → distributors → authority → close', () => {
    expect(nextAction(detail({ risk: 'ASSESSING' }))).toBe('risk')
    expect(nextAction(detail({ risk: 'NO' }))).toBe('action')
    expect(nextAction(detail({ risk: 'NO', actionTaken: 'Done', actionCompletedAt: null }))).toBe('action')
    expect(nextAction(detail({ risk: 'NO', actionTaken: 'Done', actionCompletedAt: '2026-10-28T10:00:00.000Z' }))).toBe('distributors')
    expect(nextAction(detail({ risk: 'NO', actionTaken: 'Done', actionCompletedAt: '2026-10-28T10:00:00.000Z' }, false))).toBe('close')
    expect(nextAction(detail({ risk: 'YES', actionTaken: 'Done', actionCompletedAt: '2026-10-28T10:00:00.000Z', distributorsInformedAt: '2026-10-28T11:00:00.000Z' }))).toBe('authority')
    expect(nextAction(detail({ status: 'CLOSED' }))).toBeNull()
  })

  it('holds with the right first, then a closed entry, then the action’s own state', () => {
    const open = detail({})
    expect(actionHeld('risk', open, VIEW_ONLY)).toBe('held.manage')
    expect(actionHeld('risk', open, MANAGE)).toBeNull()
    expect(actionHeld('edit', detail({ status: 'CLOSED' }), MANAGE)).toBe('held.closed')
    expect(actionHeld('action', detail({ actionCompletedAt: '2026-10-28T10:00:00.000Z' }), MANAGE)).toBe('held.actionDone')
    expect(actionHeld('distributors', detail({ distributorsInformedAt: '2026-10-28T10:00:00.000Z' }), MANAGE)).toBe('held.informed')
    expect(actionHeld('authority', detail({ authorityNotifiedAt: '2026-10-28T10:00:00.000Z' }), MANAGE)).toBe('held.notified')
  })
})

describe('where the source and the evidence open', () => {
  it('links a reversal to its release found in the reversed releases, a lab result to its lot, else nothing', () => {
    expect(sourceLink(row(7), RELEASES)).toEqual({ kind: 'release', releaseId: RELEASES[0]!.id, label: 'REL-DEMO-2026-0031' })
    expect(sourceLink({ source: { type: 'QualityReleaseReversal', id: REVERSAL_ID }, lotIds: [] }, null)).toEqual({ kind: 'none' })
    expect(sourceLink({ source: { type: 'QualityReleaseReversal', id: 'another' }, lotIds: [] }, RELEASES)).toEqual({ kind: 'none' })
    expect(sourceLink({ source: { type: 'QualityReleaseReversal', id: REVERSAL_ID }, lotIds: [] }, [{ ...RELEASES[0]!, releaseNumber: null }])).toMatchObject({ label: 'WO-DEMO-0139' })
    expect(sourceLink(row(5), null)).toEqual({ kind: 'lot', lotId: DEMO_LOT_ID })
    expect(sourceLink(row(8), RELEASES)).toEqual({ kind: 'none' })
  })

  it('traces the first batch, else the first serial, else nothing', () => {
    expect(evidenceSubject(row(5))).toEqual({ batch: 'B-DEMO-0120' })
    expect(evidenceSubject(row(6))).toEqual({ serial: 'DEMO-S-000101' })
    expect(evidenceSubject(row(2))).toBeNull()
  })

  it('a picked day becomes now when it is today, else 10:00 UTC of that day', () => {
    const now = new Date('2026-10-29T08:00:00.000Z')
    expect(dayInstant('2026-10-29', '2026-10-29', now)).toBe(now.toISOString())
    expect(dayInstant('2026-10-27', '2026-10-29', now)).toBe('2026-10-27T10:00:00.000Z')
    expect(dayInstant('', '2026-10-29', now)).toBeUndefined()
  })
})

describe('New entry', () => {
  it('lists every problem at once; a recall names what it calls back', () => {
    expect(draftProblems(blankDraft(''))).toEqual(['new.problem.company', 'new.problem.style', 'new.problem.description'])
    expect(draftProblems({ ...blankDraft('c'), kind: 'RECALL', styleId: 's', description: 'x' })).toEqual(['new.problem.recallNeedsGarments'])
    expect(draftProblems({ ...blankDraft('c'), styleId: 's', description: 'x', batchNumbers: ['B-1'] })).toEqual([])
  })

  it('asks where the garments are only with a style and a batch or a serial; codes split on commas and spaces', () => {
    expect(canTrace({ ...blankDraft('c'), styleId: 's' })).toBe(false)
    expect(canTrace({ ...blankDraft('c'), styleId: 's', serials: ['S-1'] })).toBe(true)
    expect(splitCodes(' B-1, B-2\nB-1 ;B-3 ')).toEqual(['B-1', 'B-2', 'B-3'])
  })
})

describe('every design case draws in both languages with no key left on screen', () => {
  const KEY = /\b(?:list|tile|view|new|held|row|keys|csv|done|trace|record|tab|action|affected|event|assess|corrective|duties|duty|toClose|distributors|authority|dialog|kind|kindHint|risk|riskHint|status|source|keeper|noAccess|common|live|problem|check|stepUp)\.[A-Za-z_]+(?:\.[A-Za-z_]+)*/
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  for (const screen of [listScreen, entryScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(200)
          const text = html.replace(/<[^>]+>/g, ' ')
          expect(text.match(KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the roles: read-only and production see every action held, sales sees which permission it lacks', () => {
    const html = (screen: DesignScreen<unknown>, id: string) => render(screen, screen.cases.find((item) => item.id === id)!.model, 'en')
    expect(html(listScreen as DesignScreen<unknown>, 'sales')).toContain('compliance.register.view')
    expect(html(listScreen as DesignScreen<unknown>, 'production')).toContain('compliance.register.manage')
    expect(html(entryScreen as DesignScreen<unknown>, 'production')).toContain('compliance.register.manage')
    expect(html(listScreen as DesignScreen<unknown>, 'read-only')).toContain('compliance.register.manage')
    expect(html(entryScreen as DesignScreen<unknown>, 'read-only')).toContain('compliance.register.manage')
    expect(html(entryScreen as DesignScreen<unknown>, 'from-reversal')).toContain('REL-DEMO-2026-0031')
    expect(html(entryScreen as DesignScreen<unknown>, 'from-reversal-no-link')).not.toContain('REL-DEMO-2026-0031')
    expect(html(entryScreen as DesignScreen<unknown>, 'from-lab')).toContain('/compliance/tests/')
  })

  it('no money on the register: no amount on any case', () => {
    for (const screen of [listScreen, entryScreen] as DesignScreen<unknown>[]) {
      for (const item of screen.cases) expect(render(screen, item.model, 'en'), `${screen.screen}/${item.id}`).not.toMatch(/€|EUR\b/)
    }
  })
})
