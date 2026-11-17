import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { partnerTemplateOf, templateOf } from '../auth/roles/templates'
import { PORTAL_PROJECTS_ADDS, PORTAL_PROJECTS_VIEW, PROJECTS_ADDS, PROJECTS_MANAGE } from './permissions'
import {
  closeProblems,
  foldPerRecordDay,
  isLinkedNews,
  isStale,
  LINK_GROUPS,
  linkKeyOf,
  moveTarget,
  movesFrom,
  namesAlike,
  PROJECT_LIMITS,
  PROJECT_LINK_TYPES,
  PROJECT_REFUSALS,
  PROJECT_STATUSES,
  projectProblems,
  targetStateOf,
  targetWords,
  type ProjectStatus,
} from './rules'

/**
 * Projects (threads plan TH-5, B-TH-066 … B-TH-072), the pure part: the state machine, the words a person meets before the
 * database's, the target date's state in words, the stale nudge, the duplicate warning, the link key, linked news folded one line
 * per record per day, and who holds the two new permissions. No database.
 */

const DAY = 86_400_000

describe('the state machine (B-TH-066): ACTIVE ⇄ ON_HOLD → CLOSED → reopened ACTIVE', () => {
  it('each move leads where the database lets it, or nowhere', () => {
    expect(moveTarget('ACTIVE', 'HOLD')).toBe('ON_HOLD')
    expect(moveTarget('ON_HOLD', 'RESUME')).toBe('ACTIVE')
    expect(moveTarget('ACTIVE', 'CLOSE')).toBe('CLOSED')
    expect(moveTarget('ON_HOLD', 'CLOSE')).toBe('CLOSED')
    expect(moveTarget('CLOSED', 'REOPEN')).toBe('ACTIVE')
    expect(moveTarget('ACTIVE', 'RESUME')).toBeNull()
    expect(moveTarget('ACTIVE', 'REOPEN')).toBeNull()
    expect(moveTarget('ON_HOLD', 'HOLD')).toBeNull()
    expect(moveTarget('CLOSED', 'HOLD')).toBeNull()
    expect(moveTarget('CLOSED', 'CLOSE')).toBeNull()
  })

  it('the page offers the moves allowed now, for every status', () => {
    const moves: Record<ProjectStatus, string[]> = { ACTIVE: ['HOLD', 'CLOSE'], ON_HOLD: ['RESUME', 'CLOSE'], CLOSED: ['REOPEN'] }
    for (const status of PROJECT_STATUSES) expect(movesFrom(status), status).toEqual(moves[status])
  })
})

describe('the words before the database’s (B-TH-066)', () => {
  it('a name is one line of 1 to 200 characters; a goal up to 4000, line breaks allowed', () => {
    expect(projectProblems({ name: 'FW27 airbag line', goal: 'Three jackets on one block.\nProto to salesman samples.' })).toEqual([])
    expect(projectProblems({ name: '   ' }).map((issue) => issue.path)).toEqual(['body/name'])
    expect(projectProblems({ name: 'Two\nlines' }).map((issue) => issue.path)).toEqual(['body/name'])
    expect(projectProblems({ name: 'x'.repeat(PROJECT_LIMITS.name) })).toEqual([])
    expect(projectProblems({ name: 'x'.repeat(PROJECT_LIMITS.name + 1) }).map((issue) => issue.path)).toEqual(['body/name'])
    expect(projectProblems({ goal: 'y'.repeat(PROJECT_LIMITS.goal) })).toEqual([])
    expect(projectProblems({ goal: 'y'.repeat(PROJECT_LIMITS.goal + 1) }).map((issue) => issue.path)).toEqual(['body/goal'])
    // No goal, or an empty one, is fine (it is optional); a name left out is not checked (a PATCH that does not change it).
    expect(projectProblems({ goal: null })).toEqual([])
    expect(projectProblems({ goal: '' })).toEqual([])
    expect(projectProblems({})).toEqual([])
  })

  it('a close says DONE or STOPPED and one line of 1 to 500 characters', () => {
    expect(closeProblems({ outcome: 'DONE', outcomeNote: 'FW27 airbag line approved, six styles to production in March.' })).toEqual([])
    expect(closeProblems({ outcome: 'STOPPED', outcomeNote: 'The brand moved the line to 2028.' })).toEqual([])
    expect(closeProblems({ outcome: 'MAYBE', outcomeNote: 'Made-up.' }).map((issue) => issue.path)).toEqual(['body/outcome'])
    expect(closeProblems({ outcome: 'DONE', outcomeNote: ' ' }).map((issue) => issue.path)).toEqual(['body/outcomeNote'])
    expect(closeProblems({ outcome: 'DONE', outcomeNote: 'Line one\nline two' }).map((issue) => issue.path)).toEqual(['body/outcomeNote'])
    expect(closeProblems({ outcome: 'DONE', outcomeNote: 'z'.repeat(PROJECT_LIMITS.outcomeNote + 1) }).map((issue) => issue.path)).toEqual(['body/outcomeNote'])
  })

  it('every refusal has its Italian and English words, and none names a customer (the wall: neutral words)', () => {
    for (const [code, words] of Object.entries(PROJECT_REFUSALS)) {
      expect(words.it.trim().length, `${code} it`).toBeGreaterThan(10)
      expect(words.en.trim().length, `${code} en`).toBeGreaterThan(10)
      for (const text of [words.it, words.en]) {
        expect(text, code).not.toMatch(/\{[a-z]+\}/i)
        expect(text, code).not.toMatch(/Brand (Alpha|Beta)|SEED-|another (customer|brand)'s name/i)
      }
    }
  })
})

describe('the target date in words (PROJ.list-F06): never colour alone', () => {
  const today = '2026-11-17'
  it('overdue with its days, due within 7 days, due today, later, and a closed project plain', () => {
    expect(targetStateOf('ACTIVE', '2026-11-14', today)).toEqual({ state: 'OVERDUE', days: -3 })
    expect(targetWords('OVERDUE', -3)).toEqual({ it: 'In ritardo di 3 g', en: 'Overdue 3 d' })
    expect(targetStateOf('ON_HOLD', '2026-11-24', today)).toEqual({ state: 'SOON', days: 7 })
    expect(targetWords('SOON', 7)).toEqual({ it: 'Scade tra 7 g', en: 'Due in 7 d' })
    expect(targetStateOf('ACTIVE', today, today)).toEqual({ state: 'SOON', days: 0 })
    expect(targetWords('SOON', 0)).toEqual({ it: 'Scade oggi', en: 'Due today' })
    expect(targetStateOf('ACTIVE', '2026-11-25', today)).toEqual({ state: 'LATER', days: 8 })
    expect(targetWords('LATER', 8)).toBeNull()
    expect(targetStateOf('CLOSED', '2026-11-01', today)).toEqual({ state: 'CLOSED', days: -16 })
    expect(targetWords('CLOSED', -16)).toBeNull()
  })
})

describe('the stale nudge (PROJ.home-F04): past its target date and quiet for 14 days', () => {
  const today = '2026-11-17'
  const now = new Date('2026-11-17T10:00:00.000Z')
  const quiet = (days: number) => new Date(now.getTime() - days * DAY)
  it('an open project past its target and quiet for 14 days or more is stale; 13 days is not', () => {
    expect(isStale({ status: 'ACTIVE', targetDate: '2026-11-01', lastMessageAt: quiet(14), createdAt: quiet(60) }, today, now)).toBe(true)
    expect(isStale({ status: 'ON_HOLD', targetDate: '2026-11-01', lastMessageAt: quiet(30), createdAt: quiet(60) }, today, now)).toBe(true)
    expect(isStale({ status: 'ACTIVE', targetDate: '2026-11-01', lastMessageAt: quiet(13), createdAt: quiet(60) }, today, now)).toBe(false)
  })
  it('a closed project never; one not past its target date never (today is not past)', () => {
    expect(isStale({ status: 'CLOSED', targetDate: '2026-11-01', lastMessageAt: quiet(40), createdAt: quiet(60) }, today, now)).toBe(false)
    expect(isStale({ status: 'ACTIVE', targetDate: today, lastMessageAt: quiet(40), createdAt: quiet(60) }, today, now)).toBe(false)
    expect(isStale({ status: 'ACTIVE', targetDate: '2026-12-01', lastMessageAt: quiet(40), createdAt: quiet(60) }, today, now)).toBe(false)
  })
  it('no message yet: quiet since it was made', () => {
    expect(isStale({ status: 'ACTIVE', targetDate: '2026-11-10', lastMessageAt: null, createdAt: quiet(20) }, today, now)).toBe(true)
    expect(isStale({ status: 'ACTIVE', targetDate: '2026-11-10', lastMessageAt: null, createdAt: quiet(5) }, today, now)).toBe(false)
  })
})

describe('the duplicate warning, the link key and linked news', () => {
  it('names alike: the same words case and spacing aside, or one inside the other (4 characters at least)', () => {
    expect(namesAlike('FW27 airbag line', 'fw27  Airbag-line')).toBe(true)
    expect(namesAlike('FW27 airbag line', 'Airbag line')).toBe(true)
    expect(namesAlike('FW27 airbag line', 'SS28 gloves')).toBe(false)
    expect(namesAlike('FW', 'FW27 airbag line')).toBe(false)
    expect(namesAlike('', 'anything')).toBe(false)
  })

  it('a record is linked once to a project: link:<projectId>:<recordType>:<recordId>', () => {
    expect(linkKeyOf('p1', 'Style', 's1')).toBe('link:p1:Style:s1')
  })

  it('every linkable kind has its group on the page', () => {
    for (const type of PROJECT_LINK_TYPES) expect(LINK_GROUPS[type], type).toMatch(/^[A-Z_]+$/)
    expect(Object.keys(LINK_GROUPS).sort()).toEqual([...PROJECT_LINK_TYPES].sort())
  })

  it('linked news: a status move or a decision is news; another change is not', () => {
    expect(isLinkedNews('sales.samples.move', { from: 'REQUESTED', to: 'IN_WORK' })).toBe(true)
    expect(isLinkedNews('sales.samples.decide', null)).toBe(true)
    expect(isLinkedNews('quotes.accept', null)).toBe(true)
    expect(isLinkedNews('product.styles.update', null)).toBe(false)
  })

  it('one line per record per day: the newest of each, with how many moves it folds', () => {
    const at = (iso: string) => new Date(iso)
    const entries = [
      { id: 'e4', recordType: 'SampleRound', recordId: 'r1', at: at('2026-11-17T15:00:00.000Z') },
      { id: 'e3', recordType: 'SampleRound', recordId: 'r1', at: at('2026-11-17T09:00:00.000Z') },
      { id: 'e2', recordType: 'Style', recordId: 's1', at: at('2026-11-17T08:00:00.000Z') },
      { id: 'e1', recordType: 'SampleRound', recordId: 'r1', at: at('2026-11-16T09:00:00.000Z') },
    ]
    const folded = foldPerRecordDay(entries, (value) => value.toISOString().slice(0, 10))
    expect(folded.map((entry) => [entry.id, entry.folded])).toEqual([
      ['e4', 2],
      ['e2', 1],
      ['e1', 1],
    ])
  })
})

describe('who holds the projects’ permissions (B-TH-066; PROJ-G08)', () => {
  it('projects.manage is the office’s: Administrator, Sales, Production manager and Buyer (the Owner by every())', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(PROJECTS_MANAGE)).toBe(true)
    expect(FACTORY_PERMISSIONS.get(PROJECTS_MANAGE)?.partner).not.toBe(true)
    expect(Object.keys(PROJECTS_ADDS).sort()).toEqual(['admin', 'buyer', 'production_manager', 'sales'])
    for (const key of Object.keys(PROJECTS_ADDS)) {
      expect(templateOf(key), key).toBeDefined()
      expect(templateOf(key)!.permissions, key).toContain(PROJECTS_MANAGE)
    }
    expect(templateOf('owner')!.permissions).toContain(PROJECTS_MANAGE)
    expect(templateOf('finance')?.permissions ?? []).not.toContain(PROJECTS_MANAGE)
  })

  it('portal.projects.view is a partner permission of every goods role of a customer, supplier or workshop; each Admin follows; never Finance or Invoices', () => {
    expect(FACTORY_PERMISSIONS.get(PORTAL_PROJECTS_VIEW)?.partner).toBe(true)
    for (const key of Object.keys(PORTAL_PROJECTS_ADDS)) {
      expect(partnerTemplateOf(key), key).toBeDefined()
      expect(partnerTemplateOf(key)!.permissions, key).toContain(PORTAL_PROJECTS_VIEW)
    }
    for (const key of ['customer-admin', 'supplier-admin', 'subcontractor-admin']) expect(partnerTemplateOf(key)?.permissions ?? [], key).toContain(PORTAL_PROJECTS_VIEW)
    for (const key of ['customer-finance', 'supplier-invoices', 'guest-accountant']) expect(partnerTemplateOf(key)?.permissions ?? [], key).not.toContain(PORTAL_PROJECTS_VIEW)
  })
})
