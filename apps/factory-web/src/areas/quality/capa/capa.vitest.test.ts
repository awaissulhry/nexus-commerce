import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CAPA_STATUSES, CAPA_VIEWS, MAX_REMINDERS, STAGES } from '@nexus/factory-domain/quality/capa/rules'
import { ApiError } from '../../../lib/api/errors'
import { scanText } from '../../../lib/testing/brand-scan' // B-TH-232
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands' // B-TH-232
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, RECORD_PAGES } from '../../../lib/records/record-links'
import { OFFICE_PAGES, WINDOW_PAGES } from '../../../shell/nav/office-nav'
import { ACTIONS, COMPANY_ID, ME, RECORD, ROWS, SOURCE_CHOICES, TODAY } from './demo/fixtures'
import { designScreen as listScreen } from './list/fixtures'
import {
  actionCellChange,
  actionDraftProblems,
  actionEditHeld,
  addressOf,
  addressText,
  boardLanesOf,
  boardMoveHeld,
  boardRowsOf,
  boardTypeOf,
  capaCan,
  closeLinesOfRow,
  doneHeld,
  dueSay,
  editHeld,
  emptyActionDraft,
  emptyNewDraft,
  FIELD_NAMES,
  HELD_CODES,
  HOME_ADDRESS,
  newBodyOf,
  newDraftProblems,
  primaryOf,
  problemChangesOf,
  problemDraftOf,
  problemDraftProblems,
  refusalOf,
  remindHeld,
  removeSourceHeld,
  reportHref,
  shareHeld,
  SOURCE_STATES,
  stepAction,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'
// B-TH-266: the CAPA on RecordFrame (tabs 4 → 3, the docked thread).
import { readFileSync } from 'node:fs'
import { MERGED_TABS, RECORD_TABS, tabOf } from './model'
import { textOf } from '../../../lib/record-thread/parts/testing'
import { designScreen as reportScreen } from './report/fixtures'

const en = CATALOGUE.en['quality-capa'] as Record<string, string>
const it_ = CATALOGUE.it['quality-capa'] as Record<string, string>
const MANAGE = capaCan(['quality.capa.view', 'quality.capa.manage'])
const VIEW = capaCan(['quality.capa.view'])
const has = (key: string) => key in en || `${key}_other` in en

describe('the address', () => {
  it('reads the API filters, the mode and New CAPA from records, and writes them back', () => {
    const params = new URLSearchParams('view=overdue&q=zip&type=EIGHT_D&priority=HIGH&mode=board&new=1&from=Nonconformance&ids=a,b')
    const address = addressOf(params)
    expect(address).toEqual({ view: 'overdue', q: 'zip', type: 'EIGHT_D', priority: 'HIGH', mode: 'board', isNew: true, from: { recordType: 'Nonconformance', ids: ['a', 'b'] } })
    expect(addressOf(new URLSearchParams(addressText(address).slice(1)))).toEqual(address)
    expect(addressText(HOME_ADDRESS)).toBe('')
    expect(addressOf(new URLSearchParams('view=nonsense&type=X&from=Lot&ids=a'))).toEqual(HOME_ADDRESS)
  })

  it('the 8D window is a window page; the list, the record and the window are built pages', () => {
    expect(reportHref('/w/DEMO', 'id-1', 'en')).toBe('/w/DEMO/quality/capa/report?capa=id-1&language=en')
    expect(WINDOW_PAGES.has('/quality/capa/report')).toBe(true)
    for (const page of ['/quality/capa', '/quality/capa/[id]', '/quality/capa/report']) expect(OFFICE_PAGES).toContain(page)
    expect(RECORD_PAGES.Capa).toBe('/quality/capa/[id]')
    expect(LIST_PAGES['/quality/capa']).toBe('/quality/capa')
  })
})

describe('the board', () => {
  it('shows one type at a time with its own stages and Closed', () => {
    expect(boardTypeOf({ type: null })).toBe('CAPA')
    expect(boardLanesOf('CAPA')).toEqual(['PLAN', 'ACT', 'CHECK', 'CLOSED'])
    expect(boardLanesOf('EIGHT_D')).toEqual([...STAGES.EIGHT_D, 'CLOSED'])
    expect(boardRowsOf(ROWS, 'EIGHT_D').every((row) => row.type === 'EIGHT_D')).toBe(true)
    expect(boardRowsOf(ROWS, 'CAPA').some((row) => row.status === 'CANCELLED')).toBe(false)
  })

  it('holds a move with its reason: ended, no right, offline', () => {
    expect(boardMoveHeld({ status: 'CLOSED' }, 'PLAN', MANAGE)?.key).toBe('held.FINAL')
    expect(boardMoveHeld({ status: 'PLAN' }, 'ACT', VIEW)?.key).toBe('held.noManage')
    expect(boardMoveHeld({ status: 'PLAN' }, 'ACT', MANAGE, true)?.key).toBe('held.offline')
    expect(boardMoveHeld({ status: 'PLAN' }, 'ACT', MANAGE)).toBeNull()
  })

  it('the close from a row: the domain checks in our words', () => {
    const lines = closeLinesOfRow(ROWS[0]!)
    expect(lines.map((line) => [line.key, line.ok])).toEqual([
      ['LAST_STAGE', false],
      ['ACTION_DONE', true],
      ['NO_OPEN_ACTION', false],
    ])
    expect(lines.map((line) => line.say.key)).toEqual(['close.check.LAST_STAGE.no', 'close.check.ACTION_DONE.ok', 'close.check.NO_OPEN_ACTION.no'])
    const ready = closeLinesOfRow(ROWS.find((row) => row.status === 'CHECK')!)
    expect(ready.every((line) => line.ok)).toBe(true)
  })
})

describe('the record', () => {
  it('one primary: the next stage, Close at the last one, nothing once ended', () => {
    expect(primaryOf({ type: 'EIGHT_D', status: 'D3' })).toEqual({ kind: 'move', to: 'D4' })
    expect(primaryOf({ type: 'CAPA', status: 'CHECK' })).toEqual({ kind: 'close' })
    expect(primaryOf({ type: 'CAPA', status: 'CANCELLED' })).toBeNull()
  })

  it('what may change, and why not', () => {
    expect(editHeld({ status: 'D3' }, VIEW)?.key).toBe('held.noManage')
    expect(editHeld({ status: 'CLOSED' }, MANAGE)?.key).toBe('held.FINAL')
    expect(actionEditHeld({ status: 'DONE' }, { status: 'D3' }, MANAGE)?.key).toBe('held.ACTION_ENDED')
    // The action's own owner records it done with view alone (B-W2b-108 decision 2).
    expect(doneHeld({ status: 'OPEN', ownerId: ME }, { status: 'D3' }, VIEW, ME)).toBeNull()
    expect(doneHeld({ status: 'OPEN', ownerId: 'someone' }, { status: 'D3' }, VIEW, ME)?.key).toBe('held.notYourAction')
    expect(remindHeld({ status: 'OPEN', remindersSent: MAX_REMINDERS }, { status: 'D3' }, MANAGE)?.key).toBe('held.TOO_MANY_REMINDERS')
    const decided = { ...RECORD.sources[0]!, record: { ...RECORD.sources[0]!.record!, state: 'DECIDED' } }
    expect(removeSourceHeld(decided, RECORD.capa, MANAGE)?.key).toBe('held.NCR_KEEPS_CAPA')
    expect(removeSourceHeld(RECORD.sources[1]!, RECORD.capa, MANAGE)).toBeNull()
  })

  it('Share with the customer needs an 8D, a kept version and the complaint rights', () => {
    const all = capaCan(['quality.capa.view', 'quality.capa.manage', 'quality.complaints.manage', 'files.manage'])
    const complaint = RECORD.sources.find((source) => source.recordType === 'Complaint')!
    expect(shareHeld(complaint, RECORD, all, false)).toBeNull()
    expect(shareHeld(complaint, { ...RECORD, documents: [] }, all, false)?.key).toBe('held.NO_REPORT')
    expect(shareHeld(complaint, RECORD, MANAGE, false)?.key).toBe('held.noShare')
    expect(shareHeld(complaint, { ...RECORD, capa: { ...RECORD.capa, type: 'CAPA' } }, all, false)?.key).toBe('held.shareOnly8D')
  })

  it('the Problem form sends only what changed, and says its problems at their fields', () => {
    const draft = problemDraftOf(RECORD.capa)
    expect(problemChangesOf(RECORD.capa, draft)).toEqual({})
    const changed = { ...draft, howMany: ' 7 of 120 ', where: '', team: [...draft.team, { userId: 'x', role: ' QA ' }] }
    expect(problemChangesOf(RECORD.capa, changed)).toEqual({ problemWhere: null, problemHowMany: '7 of 120', team: [...draft.team, { userId: 'x', role: 'QA' }] })
    expect(problemDraftProblems({ ...draft, team: [...draft.team, { userId: 'x', role: '' }] })['team/3/role']?.key).toBe('problem.field.teamRole')
    expect(problemDraftProblems({ ...draft, title: ' ' }).title?.key).toBe('problem.field.title')
  })

  it('an action cell saves only a real change, a due day today or later', () => {
    const action = ACTIONS[1]!
    expect(actionCellChange(action, 'description', action.description, TODAY)).toBeNull()
    expect(actionCellChange(action, 'description', ' New words ', TODAY)).toEqual({ description: 'New words' })
    expect(actionCellChange(action, 'dueOn', '2026-01-01', TODAY)).toBeNull()
    expect(actionCellChange(action, 'dueOn', '2026-12-01', TODAY)).toEqual({ dueOn: '2026-12-01' })
    expect(actionCellChange(action, 'escalateToId', '', TODAY)).toBeNull()
    expect(actionCellChange(action, 'escalateToId', 'p', TODAY)).toEqual({ escalateToId: 'p' })
    expect(stepAction(ACTIONS, ACTIONS[0]!.id, 1)).toBe(ACTIONS[1]!.id)
    expect(stepAction(ACTIONS, ACTIONS[0]!.id, -1)).toBeNull()
  })

  it('Add action: what to do, a due day today or later', () => {
    const draft = emptyActionDraft(TODAY, ME)
    expect(Object.keys(actionDraftProblems(draft, TODAY))).toEqual(['description'])
    expect(actionDraftProblems({ ...draft, description: 'x', dueOn: '2026-10-01' }, TODAY).dueOn?.key).toBe('problem.field.actionDuePast')
  })
})

describe('New CAPA', () => {
  it('held until it has a title; sources of one company that may go; the body the API takes', () => {
    const draft = emptyNewDraft(TODAY, ME)
    expect(draft.dueOn > TODAY).toBe(true)
    expect(Object.keys(newDraftProblems(draft, TODAY))).toEqual(['title'])
    const sources = SOURCE_CHOICES.map((choice) => ({ ...choice, held: null }))
    expect(newDraftProblems({ ...draft, title: 'x', sources: [sources[0]!, { ...sources[1]!, held: 'ESCALATED_ELSEWHERE' }] }, TODAY).sources?.key).toBe('problem.field.sourceHeld')
    expect(newDraftProblems({ ...draft, title: 'x', sources: [sources[0]!, { ...sources[1]!, companyId: 'other' }] }, TODAY).sources?.key).toBe('problem.field.sourcesCompanies')
    expect(newBodyOf({ ...draft, title: ' Zip ', sources }, COMPANY_ID, ME)).toEqual({
      type: 'CAPA',
      title: 'Zip',
      dueOn: draft.dueOn,
      priority: 'NORMAL',
      sources: sources.map((source) => ({ recordType: source.recordType, recordId: source.recordId })),
    })
    expect(newBodyOf({ ...draft, title: 'x', ownerId: 'other' }, COMPANY_ID, ME)).toMatchObject({ companyId: COMPANY_ID, ownerId: 'other' })
  })
})

describe('refusals in our words', () => {
  it('a held code, a field, a stale version, a kind', () => {
    const held = new ApiError('conflict', 409, 'invalid_state', 'x', null, [{ path: 'held/NOT_LAST_STAGE', message: 'x' }, { path: 'held/ACTIONS_OPEN', message: 'x' }])
    expect(refusalOf(held)).toMatchObject({ say: { key: 'problem.held' }, lines: [{ key: 'refused.NOT_LAST_STAGE' }, { key: 'refused.ACTIONS_OPEN' }], stale: false })
    expect(refusalOf(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/ownerId', message: 'x' }]))).toMatchObject({ say: { key: 'problem.fields' }, lines: [{ key: 'field.ownerId' }] })
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'version', message: 'x' }])).stale).toBe(true)
    expect(refusalOf(new ApiError('forbidden', 403, 'forbidden', 'x')).say.key).toBe('problem.forbidden')
    expect(refusalOf(new Error('x')).say.key).toBe('problem.unavailable')
  })

  it('every code, field, stage, view and state has its words in both languages', () => {
    for (const code of HELD_CODES) expect(has(`refused.${code}`), code).toBe(true)
    for (const field of FIELD_NAMES) expect(has(`field.${field}`), field).toBe(true)
    for (const stage of CAPA_STATUSES) expect(has(`stage.${stage}`), stage).toBe(true)
    for (const view of CAPA_VIEWS) expect(has(`view.${view}`), view).toBe(true)
    for (const state of [...SOURCE_STATES, 'other']) expect(has(`sourceState.${state}`), state).toBe(true)
    expect(Object.keys(it_).sort()).toEqual(Object.keys(en).sort())
  })

  it('a due day in words', () => {
    expect(dueSay('2026-10-27', TODAY)).toEqual({ key: 'due.late', params: { count: 2 } })
    expect(dueSay(TODAY, TODAY)).toEqual({ key: 'due.today' })
    expect(dueSay('2026-11-02', TODAY)).toEqual({ key: 'due.in', params: { count: 4 } })
    expect(dueSay(null, TODAY)).toBeNull()
  })
})

// ---- every design case, both languages, no key on screen -------------------------------------------------------------------

const PREFIXES = [...new Set(Object.keys(en).map((key) => key.split('.')[0]!))].filter((prefix) => prefix.length > 2)
const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z0-9_]+)*`)

describe('every design case draws in both languages with no key left on screen', () => {
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  for (const screen of [listScreen, recordScreen, reportScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale).replace(/(?:href|src|id|class|aria-[a-z]+|data-[a-z-]+|name|for|value|role|type|title)="[^"]*"/g, '')
          // The 8D window has no shell around it: its no-permission page is short.
          expect(html.length, item.id).toBeGreaterThan(screen.screen === 'SCR-146-report' ? 150 : 300)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html, `${screen.screen}/${item.id} (${locale})`).not.toMatch(/\{[a-z]+\}/i)
        }
      })
    }
  }
})

// ── B-TH-232 (threads plan TH-2: the office side of the wall in words; B-TH-031, WALL-G06, W15) ──
describe('B-TH-232 an 8D goes to a customer only with that customer’s complaints — held before the click, said in words', () => {
  const eightD = { ...RECORD, capa: { ...RECORD.capa, type: 'EIGHT_D' as const }, documents: [{ id: 'd1d1d1d1-0000-4000-8000-000000000001', version: 1, language: 'it', number: null, fileId: 'd1d1d1d1-0000-4000-8000-000000000002', createdAt: '2026-11-10T09:00:00.000Z', createdById: null }] }
  const complaint = (shareHeld: 'OTHER_CUSTOMER' | 'OTHER_CUSTOMERS_COMPLAINTS' | null) => ({
    id: 'e1e1e1e1-0000-4000-8000-000000000001',
    recordType: 'Complaint' as const,
    recordId: 'e1e1e1e1-0000-4000-8000-000000000002',
    note: null,
    createdAt: '2026-11-10T09:00:00.000Z',
    createdById: null,
    record: { number: 'RC-2026-0042', title: null, state: 'INVESTIGATING', severity: null, category: null, siteId: null, namesThisCapa: true, shareHeld },
  })
  const FILES = capaCan(['quality.capa.view', 'quality.capa.manage', 'quality.complaints.manage', 'files.manage'])

  it('the CAPA written for another customer, or answering another customer’s complaint: Share is held with the reason', () => {
    expect(shareHeld(complaint(null), eightD, FILES, false)).toBeNull()
    expect(shareHeld(complaint('OTHER_CUSTOMER'), eightD, FILES, false)).toEqual({ key: 'refused.OTHER_CUSTOMER' })
    expect(shareHeld(complaint('OTHER_CUSTOMERS_COMPLAINTS'), eightD, FILES, false)).toEqual({ key: 'refused.OTHER_CUSTOMERS_COMPLAINTS' })
    // An answer from before the field (no shareHeld): the API's own check still refuses at the click.
    expect(shareHeld({ ...complaint(null), record: { ...complaint(null).record, shareHeld: undefined } }, eightD, FILES, false)).toBeNull()
  })

  it('the share’s refusal at the click is said in our words, one line per code, never the API’s sentence', () => {
    const named = `CAPA-2026-0007 is written for ${BRAND_ALPHA.legalName}: an 8D goes only to its own customer.`
    for (const code of ['OTHER_CUSTOMER', 'OTHER_CUSTOMERS_COMPLAINTS', 'REPORT_OUTDATED']) {
      const refusal = refusalOf(new ApiError('conflict', 409, 'invalid_state', named, null, [{ path: `held/${code}`, message: named }]))
      expect(refusal.lines).toEqual([{ key: `refused.${code}` }])
    }
  })

  it('the words exist in it and en and name no customer (W15: scanText finds nothing of Brand Alpha or Brand Beta)', () => {
    for (const catalogue of [en, it_]) {
      for (const code of ['OTHER_CUSTOMER', 'OTHER_CUSTOMERS_COMPLAINTS', 'REPORT_OUTDATED']) {
        const words = catalogue[`refused.${code}`]
        expect(words, code).toBeTruthy()
        expect(scanText(words!, BRAND_ALPHA)).toEqual([])
        expect(scanText(words!, BRAND_BETA)).toEqual([])
      }
    }
  })
})
// ── end B-TH-232 ──

// ---- B-TH-266: the CAPA on RecordFrame (O-QA-CAPA; the rule of picture 38, the tabs of 08-tabs) ----
describe('B-TH-266: the CAPA on RecordFrame — Problem · Actions · Report, its own thread docked', () => {
  const screen = recordScreen as unknown as DesignScreen<{ record: { can: { threadsRead: boolean } } }>
  const html = (id: string, locale: (typeof LOCALES)[number] = 'en') => {
    const found = screen.cases.find((item) => item.id === id)
    if (!found) throw new Error(`no case ${id}`)
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: found.model })))
  }

  it('three tabs; every old ?tab= keeps working (R-8): Activity → Problem with the thread opened', () => {
    expect(RECORD_TABS).toEqual(['problem', 'actions', 'report'])
    expect(MERGED_TABS).toEqual({ activity: 'problem' })
    for (const tab of RECORD_TABS) expect(tabOf(tab)).toBe(tab)
    expect(tabOf('activity')).toBe('problem')
    expect(tabOf('constructor')).toBe('problem')
    expect(tabOf(null)).toBe('problem')
    expect(has('tab.activity')).toBe(false)
  })

  it('ONE thread docked beside every tab, its "⋯" (R-ACT) on each; no Activity tab, no record panels, no "?" overlay', () => {
    for (const id of ['problem', 'actions', 'report', 'thread-docked', 'closed', 'drawer']) {
      const page = html(id)
      expect(page.match(/class="fw-rcf-dock"/g)?.length, id).toBe(1)
      expect(page, id).toContain('aria-label="Thread tools"')
      expect(page, id).not.toContain('fw-rp-tabs')
      expect(page, id).not.toContain('?tab=activity')
    }
    // The action drawer lies over the thread's column where the thread is docked: the body keeps its width (no padding wrapper).
    expect(html('drawer')).not.toContain('fw-capa-docked')
    const container = readFileSync(new URL('./record/CapaRecord.tsx', import.meta.url), 'utf8')
    expect(container).toMatch(/<OfficeRecordThread\s+docked/)
    expect(container).toContain('party={customer ? { id: customer.id, name: customer.name } : null} partyRole="customer"')
    expect(container).toContain('can.threadsRead')
    expect(container).not.toContain("tab === 'activity'")
    const view = readFileSync(new URL('./record/view/CapaRecordView.tsx', import.meta.url), 'utf8')
    expect(view).not.toContain('RecordPanelsView')
    expect(view).not.toContain("event.key === '?'")
    expect(view).toContain('_shared/record-frame/RecordFrame')
  })

  it('the page states draw inside the frame with no thread (loading, failed, not found, no right)', () => {
    for (const id of ['loading', 'error', 'not-found', 'no-permission']) expect(html(id), id).not.toContain('class="fw-rcf-dock"')
  })

  it('the wall (W08, W15, W25, W34): the thread reaches the 8D\'s own customer only; an internal CAPA has notes only', () => {
    const page = html('thread-docked')
    const dock = textOf(page.slice(page.indexOf('class="fw-rcf-dock"')))
    expect(dock).toContain('Demo Moto Shop')
    expect(dock).not.toContain('Demo Riders Brand')
    expect(dock).not.toMatch(/Brand Alpha|Brand Beta/)
    const internal = html('thread-internal')
    const notes = textOf(internal.slice(internal.indexOf('class="fw-rcf-dock"')))
    expect(notes).not.toMatch(/Reply to/)
    expect(notes).not.toContain('Demo Moto Shop')
  })
})
