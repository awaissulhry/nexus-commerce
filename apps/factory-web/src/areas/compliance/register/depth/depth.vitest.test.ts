import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { messagesFor } from '../../../../lib/i18n/messages'
import { LOCALES } from '../../../../lib/i18n/locales'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as noticeScreen } from '../../../../links/public-doc/notice/fixtures'
import { noticeWords, reachWords } from '../../../../links/public-doc/notice/model'
import { addressState, draftProblems, blankDraft, noticeDue, tileCounts, TILES, viewQuery, viewRows } from '../model'
import { designScreen as listScreen, ENTRIES } from '../fixtures'
import { designScreen as entryScreen } from '../record/fixtures'
import { designScreen as recallScreen, NOTICE_DRAFT, NOTICE_SENT, RECALL_ACTIVE, RECALL_DRAFT, RECIPIENTS, RECIPIENTS_NONE, SURVEILLANCE } from './fixtures'
import { designScreen as pdfScreen } from './notice-pdf/fixtures'
import {
  authorityCount,
  depthCan,
  distributorHeld,
  distributorLog,
  draftsToSend,
  noticeDraftProblems,
  noticeEdit,
  noticeHeld,
  noticePdfAddress,
  percentBack,
  pickLanguage,
  progressCounts,
  publicNoticeProblems,
  recallHeld,
  recallPrimary,
  recallVerb,
  recipientsToDraft,
  requestHeld,
  requestProblems,
  requestsInOrder,
  scopeBody,
  scopeProblems,
  sentProblems,
  wordsProblem,
} from './model'

const ALL = depthCan(['compliance.register.view', 'compliance.register.manage', 'compliance.recall.manage', 'compliance.recall.send', 'quality.holds.place', 'compliance.techfiles.manage', 'files.upload'])
const VIEW = depthCan(['compliance.register.view'])
const MANAGE_ONLY = depthCan(['compliance.register.view', 'compliance.recall.manage'])
const OPEN_YES = { status: 'OPEN' as const, risk: 'YES' as const }

describe('the register list in depth (tiles, views, kinds)', () => {
  it('reads every kind from the address, and the two W2b views', () => {
    expect(addressState(new URLSearchParams('kind=WITHDRAWAL')).filters.kind).toBe('WITHDRAWAL')
    expect(addressState(new URLSearchParams('kind=AUTHORITY_REQUEST&view=notices'))).toEqual({ view: 'notices', filters: { kind: 'AUTHORITY_REQUEST', risk: null } })
    expect(addressState(new URLSearchParams('view=recalls')).view).toBe('recalls')
    expect(TILES).toEqual(['open', 'risk', 'notices', 'recalls', 'assessing', 'uninformed', 'closed'])
  })

  it('"authority notice due" = open, risk yes, no notice sent; "recall in progress" = the entries an active recall names', () => {
    expect(viewQuery('notices', {}, '', 50)).toMatchObject({ status: 'OPEN', risk: 'YES' })
    const due = viewRows('notices', ENTRIES).map((row) => row.reference)
    expect(due).toEqual(['REG-DEMO-2026-0007'])
    expect(noticeDue({ status: 'OPEN', risk: 'YES', authorityNotifiedAt: '2026-10-01T00:00:00Z' })).toBe(false)
    const seven = ENTRIES.find((row) => row.reference.endsWith('0007'))!
    expect(viewRows('recalls', ENTRIES, new Set([seven.id])).map((row) => row.reference)).toEqual(['REG-DEMO-2026-0007'])
    expect(viewRows('recalls', ENTRIES, null)).toEqual([])
    const open = ENTRIES.filter((row) => row.status === 'OPEN')
    const tiles = tileCounts(open, [], 500, 2)
    expect(tiles.notices).toEqual({ count: 1, complete: true })
    expect(tiles.recalls).toEqual({ count: 2, complete: true })
    expect(tileCounts(open, [], 500).recalls).toBeNull()
  })

  it('a withdrawal names its garments like a recall', () => {
    expect(draftProblems({ ...blankDraft('c'), kind: 'WITHDRAWAL', styleId: 's', description: 'x' })).toEqual(['compliance-register-depth:new.withdrawalNeedsGarments'])
    expect(draftProblems({ ...blankDraft('c'), kind: 'AUTHORITY_REQUEST', styleId: 's', description: 'x' })).toEqual([])
  })
})

describe('authority notices', () => {
  it('holds each action with the first reason: the right, the entry, the state, the law', () => {
    expect(noticeHeld('draft', null, OPEN_YES, VIEW)).toBe('held.manage')
    expect(noticeHeld('draft', null, { status: 'CLOSED', risk: 'YES' }, ALL)).toBe('held.entryClosed')
    expect(noticeHeld('send', NOTICE_DRAFT, OPEN_YES, MANAGE_ONLY)).toBe('held.send')
    expect(noticeHeld('send', NOTICE_DRAFT, OPEN_YES, ALL)).toBeNull()
    expect(noticeHeld('send', NOTICE_DRAFT, { status: 'OPEN', risk: 'ASSESSING' }, ALL)).toBe('held.riskNotDecided')
    expect(noticeHeld('edit', NOTICE_SENT, OPEN_YES, ALL)).toBe('held.alreadySent')
    expect(noticeHeld('reference', NOTICE_SENT, OPEN_YES, ALL)).toBe('held.referenceDone')
    expect(noticeHeld('reference', { ...NOTICE_SENT, file: null }, OPEN_YES, ALL)).toBeNull()
    expect(noticeHeld('reference', NOTICE_DRAFT, OPEN_YES, ALL)).toBe('held.notSent')
  })

  it('checks a new notice and sends only what changed', () => {
    expect(noticeDraftProblems({ marketCode: 'it', authorityName: '', channel: 'PEC', decision: 'RISK' }, { risk: 'NO' })).toEqual(['notice.problem.market', 'notice.problem.authority', 'notice.problem.riskNotDecided'])
    expect(noticeDraftProblems({ marketCode: 'DE', authorityName: 'X', channel: 'PEC', decision: 'NOT_CONFORMING' }, { risk: 'NO' })).toEqual([])
    expect(noticeEdit(NOTICE_DRAFT, { authorityName: NOTICE_DRAFT.authorityName, channel: NOTICE_DRAFT.channel, decision: NOTICE_DRAFT.decision, words: NOTICE_DRAFT.words })).toEqual({})
    expect(noticeEdit(NOTICE_DRAFT, { authorityName: ' New ', channel: 'PEC', decision: NOTICE_DRAFT.decision, words: { ...NOTICE_DRAFT.words, fr: 'x' } })).toEqual({ authorityName: 'New', channel: 'PEC', words: { ...NOTICE_DRAFT.words, fr: 'x' } })
    expect(wordsProblem({})).toBe('notice.problem.noWords')
    expect(wordsProblem({ it: ' ' })).toBe('notice.problem.emptyWords')
    expect(sentProblems({ day: '2026-11-01', reference: '', copyName: null }, '2026-10-29', '2026-10-20')).toEqual(['notice.problem.sentFuture'])
    expect(sentProblems({ day: '2026-10-10', reference: '', copyName: null }, '2026-10-29', '2026-10-20')).toEqual(['notice.problem.sentBeforeReport'])
    expect(pickLanguage(['de', 'en'], ['it', 'en'])).toBe('en')
    expect(pickLanguage(['de'], ['it', 'en'])).toBe('de')
    expect(noticePdfAddress('/w/DEMO', 'n1', 'de')).toBe('/w/DEMO/compliance/register/notice?notice=n1&language=de')
  })
})

describe('authority requests', () => {
  it('checks the log form and orders open requests by due day first', () => {
    const form = { authorityName: 'A', marketCode: 'IT', authorityReference: '', channel: 'PEC' as const, receivedOn: '', dueOn: '2026-10-20', request: 'x', batchNumbers: [] }
    expect(requestProblems(form, '2026-10-29')).toEqual(['request.problem.dueBeforeReceived'])
    expect(requestProblems({ ...form, dueOn: '2026-11-10' }, '2026-10-29')).toEqual([])
    expect(requestProblems({ ...form, receivedOn: '2026-11-01', dueOn: '2026-11-10' }, '2026-10-29')).toEqual(['request.problem.receivedFuture'])
    expect(requestsInOrder(SURVEILLANCE.requests).map((request) => request.due.state)).toEqual(['OVERDUE', 'DUE_SOON', 'ANSWERED'])
    const [soon] = SURVEILLANCE.requests
    expect(requestHeld('evidence', soon!, ALL)).toBeNull()
    expect(requestHeld('evidence', soon!, MANAGE_ONLY)).toBe('held.techfiles')
    expect(requestHeld('answer', SURVEILLANCE.requests[1]!, ALL)).toBe('held.answered')
    expect(authorityCount(SURVEILLANCE)).toBe(4)
  })
})

describe('recalls and withdrawals', () => {
  it('the primary: Start recall of 126 garments while a draft, Close while in progress', () => {
    expect(recallPrimary(RECALL_DRAFT)).toEqual({ action: 'start', key: 'builder.startRecall', count: 126 })
    expect(recallPrimary({ ...RECALL_DRAFT, kind: 'WITHDRAWAL' })?.key).toBe('builder.startWithdrawal')
    expect(recallPrimary(RECALL_ACTIVE)?.action).toBe('close')
    expect(recallPrimary({ ...RECALL_ACTIVE, status: 'CLOSED' })).toBeNull()
  })

  it('holds each step with its reason', () => {
    expect(recallHeld('start', RECALL_DRAFT, ALL)).toBeNull()
    expect(recallHeld('start', RECALL_DRAFT, VIEW)).toBe('held.manage')
    expect(recallHeld('publish', RECALL_DRAFT, ALL)).toBe('held.startFirst')
    expect(recallHeld('publish', RECALL_ACTIVE, ALL)).toBe('held.published')
    expect(recallHeld('publish', { ...RECALL_ACTIVE, notice: { ...RECALL_ACTIVE.notice, publishedAt: null } }, MANAGE_ONLY)).toBe('held.send')
    expect(recallHeld('hold', RECALL_DRAFT, MANAGE_ONLY)).toBe('held.holds')
    expect(recallHeld('hold', RECALL_ACTIVE, ALL)).toBe('held.nothingToHold')
    expect(recallHeld('progress', RECALL_DRAFT, ALL)).toBe('held.startFirst')
    expect(recallHeld('cancel', RECALL_ACTIVE, ALL)).toBe('held.started')
    expect(recallHeld('scope', { ...RECALL_ACTIVE, status: 'CANCELLED' }, ALL)).toBe('held.recallCancelled')
  })

  it('a started scope only widens: what is sent is what was added', () => {
    const active = { ...RECALL_ACTIVE, scope: { ...RECALL_ACTIVE.scope, batchNumbers: ['B-1'] }, serials: ['S-1'] }
    expect(scopeProblems({ wholeStyle: false, batchNumbers: [], serials: ['S-1'] }, active)).toEqual(['scope.problem.narrowed'])
    expect(scopeBody({ wholeStyle: false, batchNumbers: ['B-1', 'B-2'], serials: ['S-1'] }, active)).toEqual({ batchNumbers: ['B-2'] })
    expect(scopeBody({ wholeStyle: true, batchNumbers: ['B-9'], serials: [] }, { ...RECALL_DRAFT, scope: { ...RECALL_DRAFT.scope } })).toEqual({ wholeStyle: true, batchNumbers: ['B-9'], serials: [] })
  })

  it('progress adds up, and the bar is what came back of what was sent', () => {
    expect(progressCounts({ returned: '2', repaired: '1', destroyed: '0' }, 5)).toEqual({ counts: { unitsReturned: 2, unitsRepaired: 1, unitsDestroyed: 0 }, stillOut: 2 })
    expect(progressCounts({ returned: '4', repaired: '2', destroyed: '0' }, 5)).toEqual({ problem: 'progress.problem.tooMany' })
    expect(progressCounts({ returned: '1.5', repaired: '0', destroyed: '0' }, 5)).toEqual({ problem: 'progress.problem.whole' })
    expect(percentBack({ unitsSent: 24, unitsStillOut: 9 })).toBe(62)
    expect(percentBack({ unitsSent: 0, unitsStillOut: 0 })).toBeNull()
  })

  it('the public notice needs every part in every language', () => {
    expect(publicNoticeProblems({})).toEqual(['public.problem.noLanguage'])
    expect(publicNoticeProblems({ it: { title: 'a\nb', problem: 'x', action: 'y', contact: '' } })).toEqual(['public.problem.missing', 'public.problem.titleLine'])
    expect(publicNoticeProblems(RECALL_ACTIVE.publicNotice!)).toEqual([])
  })

  it('the band opens the recall in progress, else starts one of the entry’s kind', () => {
    expect(recallVerb({ kind: 'NON_CONFORMITY' }, SURVEILLANCE.recalls)).toEqual({ kind: 'open', recallId: SURVEILLANCE.recalls[0]!.id, number: SURVEILLANCE.recalls[0]!.number })
    expect(recallVerb({ kind: 'WITHDRAWAL' }, [])).toEqual({ kind: 'start', recallKind: 'WITHDRAWAL' })
  })
})

describe('distributors told', () => {
  it('the log, the drafts one send sends, the recipients nobody drafted', () => {
    expect(distributorLog(RECIPIENTS).map((notice) => notice.status)).toEqual(['FAILED', 'ANSWERED', 'DRAFT'])
    expect(draftsToSend(RECIPIENTS)).toHaveLength(1)
    expect(recipientsToDraft(RECIPIENTS)).toBe(1)
    expect(recipientsToDraft(RECIPIENTS_NONE)).toBe(3)
    expect(distributorHeld('send', RECIPIENTS, null, MANAGE_ONLY, { status: 'OPEN' })).toBe('held.send')
    expect(distributorHeld('send', RECIPIENTS_NONE, null, ALL, { status: 'OPEN' })).toBe('held.noDrafts')
    expect(distributorHeld('answer', RECIPIENTS, RECIPIENTS.recipients[1]!.notices[0]!, ALL, { status: 'OPEN' })).toBe('held.notSentNotice')
    expect(distributorHeld('draft', RECIPIENTS, null, ALL, { status: 'CLOSED' })).toBe('held.entryClosed')
  })
})

describe('the public DoC page’s safety notice', () => {
  const notice = { kind: 'RECALL' as const, number: 'RCL-1', publishedOn: '2026-10-28', reach: 'BATCH' as const, batches: ['L-1', 'L-2'], bySerial: false, words: { it: { title: 't', problem: 'p', action: 'a', contact: 'c' }, 'pt-BR': { title: 'T', problem: 'P', action: 'A', contact: 'C' } } }
  it('reads the reader’s language first, else the first written', () => {
    expect(noticeWords(notice, ['pt', 'en', 'it'])?.language).toBe('pt-BR')
    expect(noticeWords(notice, ['de', 'en'])?.language).toBe('it')
    expect(noticeWords({ words: {} }, ['it'])).toBeNull()
  })
  it('says what it reaches: this batch, the batches to check, the serial on the label, the whole model', () => {
    expect(reachWords(notice, { batch: 'L-1' })).toEqual({ key: 'publicNotice.reach.BATCH', params: { batch: 'L-1' } })
    expect(reachWords(notice, { batch: null })).toEqual({ key: 'publicNotice.reach.BATCHES', params: { batches: 'L-1, L-2' } })
    expect(reachWords({ ...notice, reach: 'PART', bySerial: true }, { batch: 'L-1' }).key).toBe('publicNotice.reach.PART_SERIAL')
    expect(reachWords({ ...notice, reach: 'STYLE' }, { batch: 'L-1' }).key).toBe('publicNotice.reach.STYLE')
  })
})

describe('every W2b design case draws in both languages with no key left on screen and no money', () => {
  const KEY = /\b(?:tile|view|noticeStatus|recallStatus|distributorStatus|requestStatus|recallKind|recallKindHint|decision|decisionHint|channel|how|due|packStatus|law|told|col|authority|notice|request|recalls|log|holds|progress|public|scope|tree|review|builder|publicNotice|pdf|dialog|stepUp|held|done|refused|actions|language|tab)\.[A-Za-z_]+(?:\.[A-Za-z_]+)*/
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  const screens = [recallScreen, pdfScreen, noticeScreen, listScreen, entryScreen] as DesignScreen<unknown>[]
  for (const screen of screens) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}`, () => {
        const cases = screen.screen === 'SCR-113' || screen.screen === 'SCR-113-entry' ? screen.cases.filter((item) => item.id.startsWith('w2b-')) : screen.cases
        expect(cases.length).toBeGreaterThan(0)
        for (const item of cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(200)
          const text = html.replace(/<[^>]+>/g, ' ')
          expect(text.match(KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(text, `${screen.screen}/${item.id}`).not.toMatch(/€|EUR\b/)
        }
      })
    }
  }

  it('the safety notice comes first on the public page, and is not drawn without one', () => {
    const html = (id: string) => render(noticeScreen as DesignScreen<unknown>, noticeScreen.cases.find((item) => item.id === id)!.model, 'en')
    const page = html('batch')
    expect(page).toContain('RCL-DEMO-2026-0002')
    expect(page.indexOf('fw-pdn')).toBeLessThan(page.indexOf('fw-pd-product'))
    expect(html('none')).not.toContain('fw-pdn')
  })

  it('the builder says what starting does, and every step is held for a read-only person', () => {
    const html = (id: string, locale: (typeof LOCALES)[number] = 'en') => render(recallScreen as DesignScreen<unknown>, recallScreen.cases.find((item) => item.id === id)!.model, locale)
    expect(html('draft')).toContain('Start recall of 126 garments')
    expect(html('draft', 'it')).toContain('Avvia il richiamo di 126 capi')
    expect(html('read-only')).toContain('compliance.recall.manage')
    expect(html('active')).toContain('62%')
  })
})
