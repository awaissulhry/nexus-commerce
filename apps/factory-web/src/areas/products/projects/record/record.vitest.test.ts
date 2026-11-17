import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { everyCase, leftKeys, renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { BRAND_BETA } from '../../../../lib/testing/two-brands'
import { scanText } from '../../../../lib/testing/brand-scan'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import type { LinkedNewsEntry, ProjectView } from '../api'
import { designScreen } from './fixtures'
import {
  bandRows,
  closeBody,
  closeProblem,
  detailsOpenOf,
  editBody,
  editDraftOf,
  editProblems,
  emptyCloseDraft,
  leadChoices,
  newsLineOf,
  offersTell,
  partyRoleOf,
  primaryOf,
  RECORD_NS,
  threadAudience,
} from './model'
import { PROJECT_KEYS } from './ProjectFrame'
import { latestFiles } from './view/ProjectRecordView'

/**
 * B-TH-249 — the project page (SCR-701; PROJ.record, PROJ.thread, PROJ.linked-F08; walls W01, W08, W20, W24, W34, W38): close rules,
 * an office-only project has no outside audience, the band's moves by status and right, what Edit details sends, the news lines,
 * and every design case in Italian and English with no raw key and nothing of another customer.
 */

const MARCO = { id: 'u1', name: 'Marco Demo' }
const project = (over: Partial<ProjectView> = {}): ProjectView => ({
  id: 'p1',
  number: 'PRJ-26-012',
  name: 'FW27 airbag line',
  goal: 'Six jackets.',
  companyId: 'c1',
  company: { id: 'c1', code: 'DEMO' },
  party: { id: 'a1', code: 'BRAND-ALPHA', name: 'Brand Alpha', roles: ['CUSTOMER'] },
  lead: MARCO,
  seasonCode: 'FW27',
  targetDate: '2027-03-15',
  target: { state: 'LATER', days: 100 },
  status: 'ACTIVE',
  outcome: null,
  outcomeNote: null,
  closedAt: null,
  closedBy: null,
  createdAt: '2026-10-02T08:30:00.000Z',
  createdBy: MARCO,
  lastMessageAt: null,
  threadStatus: 'OPEN',
  version: 3,
  officeOnly: false,
  may: { manage: true, post: true, moves: ['HOLD', 'CLOSE'] },
  ...over,
})
const officeOnly = (over: Partial<ProjectView> = {}) => project({ party: null, officeOnly: true, ...over })
const idle = { offline: false, busy: false }

describe('close with outcome (PROJ.record-F03)', () => {
  it('needs Done or Stopped AND one outcome line of 1 … 500 characters', () => {
    expect(closeProblem(emptyCloseDraft())?.key).toBe('close.held.outcome')
    expect(closeProblem({ outcome: 'DONE', note: '   ', tell: false })?.key).toBe('close.held.note')
    expect(closeProblem({ outcome: 'STOPPED', note: 'x'.repeat(501), tell: false })?.key).toBe('close.held.long')
    expect(closeProblem({ outcome: 'DONE', note: 'line one\nline two', tell: false })?.key).toBe('close.held.line')
    expect(closeProblem({ outcome: 'DONE', note: 'Approved: six styles to production in March.', tell: false })).toBeNull()
  })

  it('sends the version read, the outcome and its trimmed line; nothing while held', () => {
    expect(closeBody(project(), emptyCloseDraft())).toBeNull()
    expect(closeBody(project(), { outcome: 'DONE', note: '  Approved.  ', tell: false })).toEqual({ version: 3, outcome: 'DONE', outcomeNote: 'Approved.' })
  })

  it('"Also post the outcome to <outside company>" only on a project that has one', () => {
    expect(offersTell(project())).toBe(true)
    expect(closeBody(project(), { outcome: 'DONE', note: 'Approved.', tell: true })).toEqual({ version: 3, outcome: 'DONE', outcomeNote: 'Approved.', tellCustomer: true })
    expect(offersTell(officeOnly())).toBe(false)
    // An office-only project never tells anyone outside, whatever the draft says.
    expect(closeBody(officeOnly(), { outcome: 'STOPPED', note: 'Stopped.', tell: true })).toEqual({ version: 3, outcome: 'STOPPED', outcomeNote: 'Stopped.' })
  })

  it('is never offered for a closed project: Reopen instead (the band’s primary)', () => {
    const closed = project({ status: 'CLOSED', may: { manage: true, post: true, moves: ['REOPEN'] } })
    const rows = bandRows(closed, idle)
    expect(rows.map((row) => row.id)).toEqual(['edit', 'reopen', 'copy'])
    expect(rows.find((row) => row.id === 'reopen')?.held).toBeNull()
    expect(rows.find((row) => row.id === 'edit')?.held?.key).toBe('held.closed')
    expect(primaryOf(closed)).toBe('reopen')
    expect(primaryOf(project())).toBeNull()
  })
})

describe('the thread’s audience (PROJ.thread-F02, F08; W01, W20, W38)', () => {
  it('an office-only project has nobody outside: no party, no role (office notes only, no "Reply to", no waiting pill)', () => {
    expect(threadAudience(officeOnly())).toEqual({ party: null, partyRole: undefined })
  })

  it('a project with an outside company talks to that ONE company only', () => {
    expect(threadAudience(project())).toEqual({ party: { id: 'a1', name: 'Brand Alpha' }, partyRole: 'customer' })
  })

  it('the role comes from the company’s roles: a customer first, then a supplier or subcontractor, else a partner', () => {
    expect(partyRoleOf(['CUSTOMER'])).toBe('customer')
    expect(partyRoleOf(['SUPPLIER', 'CUSTOMER'])).toBe('customer')
    expect(partyRoleOf(['SUPPLIER'])).toBe('supplier')
    expect(partyRoleOf(['SUBCONTRACTOR'])).toBe('supplier')
    expect(partyRoleOf([])).toBe('partner')
  })

  it('the office-only page never names an outside company and offers no reply', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = renderView(designScreen.view as ComponentType<{ model: unknown }>, designScreen.cases.find((item) => item.id === 'office-only')!.model, locale)
      expect(textOf(html)).not.toContain('Brand Alpha')
      expect(textOf(html)).not.toMatch(/Reply to|Rispondi a/)
    }
  })

  it('the keys list leaves "R" (reply) out where there is nobody to reply to; ⌘J is never listed (the thread is the page)', () => {
    expect(PROJECT_KEYS.some((entry) => entry.words === 'keys.thread')).toBe(false)
    expect(PROJECT_KEYS.some((entry) => entry.words === 'keys.reply')).toBe(true)
  })
})

describe('the band’s ⋯ by status and right (PROJ.record-F02, F05)', () => {
  it('active: Edit details, Put on hold, Close…, Copy link — all open to who keeps projects', () => {
    const rows = bandRows(project(), idle)
    expect(rows.map((row) => row.id)).toEqual(['edit', 'hold', 'close', 'copy'])
    expect(rows.every((row) => row.held === null)).toBe(true)
  })

  it('on hold: Resume instead of Put on hold', () => {
    expect(bandRows(project({ status: 'ON_HOLD', may: { manage: true, post: true, moves: ['RESUME', 'CLOSE'] } }), idle).map((row) => row.id)).toEqual(['edit', 'resume', 'close', 'copy'])
  })

  it('without projects.manage every change is held with the right in words; Copy link stays', () => {
    const rows = bandRows(project({ may: { manage: false, post: true, moves: [] } }), idle)
    for (const row of rows.filter((entry) => entry.id !== 'copy')) expect(row.held?.key, row.id).toBe('held.noManage')
    expect(rows.find((row) => row.id === 'copy')?.held).toBeNull()
  })

  it('offline or busy holds a change; a move the API does not allow says so', () => {
    expect(bandRows(project(), { offline: true, busy: false })[0]?.held?.key).toBe('held.offline')
    expect(bandRows(project(), { offline: false, busy: true })[0]?.held?.key).toBe('held.busy')
    expect(bandRows(project({ may: { manage: true, post: true, moves: ['CLOSE'] } }), idle).find((row) => row.id === 'hold')?.held?.key).toBe('refusal.MOVE')
  })
})

describe('Edit details (PROJ.record-F05)', () => {
  it('the PATCH holds only what changed, with the version read; nothing changed → nothing sent', () => {
    const p = project()
    const draft = editDraftOf(p)
    expect(editBody(p, draft)).toBeNull()
    expect(editBody(p, { ...draft, name: '  FW27 airbag jackets ' })).toEqual({ version: 3, name: 'FW27 airbag jackets' })
    expect(editBody(p, { ...draft, goal: '' })).toEqual({ version: 3, goal: null })
    expect(editBody(p, { ...draft, seasonCode: ' ' })).toEqual({ version: 3, seasonCode: null })
    expect(editBody(p, { ...draft, leadId: 'u2', targetDate: '2027-04-01' })).toEqual({ version: 3, leadId: 'u2', targetDate: '2027-04-01' })
  })

  it('a wrong field holds the save and says which', () => {
    const p = project()
    expect(editProblems({ ...editDraftOf(p), name: '' }).name?.key).toBe('edit.problem.nameEmpty')
    expect(editProblems({ ...editDraftOf(p), name: 'x'.repeat(201) }).name?.key).toBe('edit.problem.nameLong')
    expect(editProblems({ ...editDraftOf(p), targetDate: '' }).targetDate?.key).toBe('edit.problem.target')
    expect(editProblems({ ...editDraftOf(p), leadId: '' }).leadId?.key).toBe('edit.problem.lead')
    expect(editBody(p, { ...editDraftOf(p), name: '' })).toBeNull()
  })

  it('the lead choices: the current lead first, then its office people and the colleagues who may read it, no one twice', () => {
    expect(leadChoices(MARCO, [{ userId: 'u1', name: 'Marco Demo' }, { userId: 'u2', name: 'Giulia Prova' }], [{ userId: 'u2', name: 'Giulia Prova' }, { userId: 'u3', name: 'Luca Test' }])).toEqual([
      { id: 'u1', name: 'Marco Demo' },
      { id: 'u2', name: 'Giulia Prova' },
      { id: 'u3', name: 'Luca Test' },
    ])
  })
})

describe('the details view and the side column', () => {
  it('`?details=open` keeps the side column open below 1280 px', () => {
    expect(detailsOpenOf({ get: (name: string) => (name === 'details' ? 'open' : null) })).toBe(true)
    expect(detailsOpenOf({ get: () => null })).toBe(false)
    expect(detailsOpenOf(null)).toBe(false)
  })

  it('the Files section shows the latest available files, newest first, five at most', () => {
    const file = (id: string, createdAt: string, status: 'AVAILABLE' | 'QUARANTINED' = 'AVAILABLE') => ({ id, createdAt, status }) as unknown as Parameters<typeof latestFiles>[0][number]
    const files = [file('a', '2026-11-01'), file('b', '2026-11-05'), file('q', '2026-11-09', 'QUARANTINED'), file('c', '2026-11-03'), file('d', '2026-11-02'), file('e', '2026-11-04'), file('f', '2026-10-30')]
    expect(latestFiles(files).map((entry) => entry.id)).toEqual(['b', 'e', 'c', 'd', 'a'])
  })

  it('the page has ONE thread and the Linked section answers the list’s `#linked`', () => {
    const html = renderView(designScreen.view as ComponentType<{ model: unknown }>, designScreen.cases.find((item) => item.id === 'customer')!.model)
    expect(html.match(/class="fw-prjr-thread"/g)?.length).toBe(1)
    expect(html).toContain('id="linked"')
    expect(html).not.toContain('fw-rp-tabs')
  })
})

describe('news of linked records (PROJ.linked-F08)', () => {
  const entry = (over: Partial<LinkedNewsEntry> = {}): LinkedNewsEntry => ({ kind: 'linked', id: 'e1', at: '2026-11-16T14:00:00.000Z', recordType: 'SampleRound', recordId: 'r1', label: 'SR-2026-0042', action: 'sales.samples.ship', status: { from: 'SENT', to: 'RECEIVED' }, actorName: 'Giulia Prova', folded: 3, ...over })

  it('a line: the move as codes (never a value), who moved it, how many more moves that day', () => {
    expect(newsLineOf(entry())).toEqual({ id: 'e1', at: '2026-11-16T14:00:00.000Z', recordType: 'SampleRound', recordId: 'r1', label: 'SR-2026-0042', from: 'SENT', to: 'RECEIVED', actor: 'Giulia Prova', more: 2 })
    expect(newsLineOf(entry({ status: null, actorName: null, folded: 1 }))).toMatchObject({ from: null, to: null, actor: null, more: 0 })
  })

  it('is asked only: the page shows the button until then (never part of the default feed)', () => {
    const text = textOf(renderView(designScreen.view as ComponentType<{ model: unknown }>, designScreen.cases.find((item) => item.id === 'customer')!.model))
    expect(text).toContain('Show news of linked records')
    const asked = textOf(renderView(designScreen.view as ComponentType<{ model: unknown }>, designScreen.cases.find((item) => item.id === 'news')!.model))
    expect(asked).toContain('SR-2026-0042')
    expect(asked).toContain('+2 more that day')
  })
})

describe('SCR-701 design cases', () => {
  const PREFIXES = ['band', 'page', 'frame', 'closed', 'details', 'tasks', 'files', 'news', 'notice', 'close', 'edit', 'status', 'outcome', 'target', 'refusal', 'problem', 'held', 'field', 'common', 'keys']

  it('every case draws in Italian and English with no raw key', () => {
    for (const [locale, id, html] of everyCase(designScreen)) expect(leftKeys(html, PREFIXES), `${id} (${locale})`).toEqual([])
  })

  it('every word of the page is in both languages', () => {
    const flat = (value: unknown, path = ''): string[] => (value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => flat(inner, path ? `${path}.${key}` : key)) : [path])
    const it_ = flat(CATALOGUE.it[RECORD_NS] ?? {}).sort()
    const en = flat(CATALOGUE.en[RECORD_NS] ?? {}).sort()
    expect(en.length).toBeGreaterThan(50)
    expect(it_).toEqual(en)
  })

  it('a project of Brand Alpha shows nothing of Brand Beta (one outside company per project, W38)', () => {
    for (const [locale, id, html] of everyCase(designScreen)) expect(scanText(html, BRAND_BETA), `${id} (${locale})`).toEqual([])
  })

  it('a project not mine to read is "not found", never "you may not" (W38)', () => {
    const html = renderView(designScreen.view as ComponentType<{ model: unknown }>, designScreen.cases.find((item) => item.id === 'not-found')!.model)
    expect(textOf(html)).toContain('Project not found')
    expect(textOf(html)).not.toMatch(/may not|not allowed|permission/i)
    // No thread on a page that is not found.
    expect(html).not.toContain('fw-rt-column')
  })

  it('the closed project says who closed it, how and why above the thread', () => {
    const text = textOf(renderView(designScreen.view as ComponentType<{ model: unknown }>, designScreen.cases.find((item) => item.id === 'closed')!.model))
    expect(text).toContain('Closed on')
    expect(text).toContain('Marco Demo')
    expect(text).toContain('FW27 airbag line approved')
  })
})
