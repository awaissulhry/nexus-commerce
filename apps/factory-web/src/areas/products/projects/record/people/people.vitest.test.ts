import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FOLLOW_REASONS } from '@nexus/factory-domain/threads/followers'
import { ApiError } from '../../../../../lib/api/errors'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { scanText } from '../../../../../lib/testing/brand-scan'
import { BRAND_BETA } from '../../../../../lib/testing/two-brands'
import type { PeopleChoices, ProjectPeople } from '../../api'
import { writeProblem } from '../../model'
import { designScreen, PEOPLE_DEMO } from './fixtures'
import { addOutsideButton, addTeamButton, choicesFor, emptyChoicesKey, outOf, peopleBlockOf, peopleTotal, PEOPLE_NS, PEOPLE_SHOWN, reasonKey, whyOf, type PeopleBlockModel, type PeopleFacts } from './model'
import { PeopleBlock } from './view/PeopleBlock'

/**
 * B-TH-250 — a project's people (design PROJ.members-F01 … F11; walls W01, W06, W24, W38). Written by the build, run at the end check
 * (Owner rule 2026-11-17: no checks during the build).
 */

const NOW = Date.parse('2026-11-17T10:00:00.000Z')
const ME = 'me-1'
const LEAD = 'lead-1'

const party = { id: 'party-a', code: 'BRAND-ALPHA', name: 'Brand Alpha', roles: ['CUSTOMER'] }
const facts = (over: Partial<PeopleFacts> = {}, project: Partial<PeopleFacts['project']> = {}): PeopleFacts => ({
  project: { number: 'PRJ-26-012', party, lead: { id: LEAD, name: 'Marco Neri' }, status: 'ACTIVE', may: { manage: true, post: true, moves: [] }, ...project },
  meId: ME,
  offline: false,
  busy: false,
  ...over,
})

const people = (over: Partial<ProjectPeople> = {}): ProjectPeople => ({
  office: {
    count: 2,
    people: [
      { userId: LEAD, name: 'Marco Neri', lead: true, me: false, reason: 'CREATOR', addedBy: null, muted: false, since: '2026-10-01T08:00:00.000Z' },
      { userId: ME, name: 'Giulia Ferri', lead: false, me: true, reason: 'ADDED', addedBy: { id: LEAD, name: 'Marco Neri' }, muted: true, since: '2026-10-02T08:00:00.000Z' },
    ],
  },
  outside: { count: 1, people: [{ userId: 'out-1', name: 'Anna Alfieri', reason: 'ADDED', addedBy: { id: LEAD, name: 'Marco Neri' }, since: '2026-10-03T08:00:00.000Z' }] },
  invited: { count: 0, people: [] },
  ...over,
})

const render = (model: PeopleBlockModel, locale: (typeof LOCALES)[number]) => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(PeopleBlock, { model })))

describe('who can be added: only the project’s own outside company, never anyone else (W38, W06)', () => {
  const answer: PeopleChoices = {
    office: [{ userId: 'colleague-1', name: 'Elisa Moro' }],
    outside: [{ userId: 'out-2', name: 'Alessia Amato' }],
    mayAddOutside: true,
  }

  it('the outside picker lists exactly the API’s outside choices; the colleague picker exactly its office ones', () => {
    expect(choicesFor('outside', answer)).toEqual(answer.outside)
    expect(choicesFor('team', answer)).toEqual(answer.office)
    // Nothing is merged: the colleague is never offered as the outside company's person, nor the reverse.
    expect(choicesFor('outside', answer).map((person) => person.userId)).not.toContain('colleague-1')
    expect(choicesFor('team', answer).map((person) => person.userId)).not.toContain('out-2')
  })

  it('without the right to add them (mayAddOutside false) the outside picker offers nobody', () => {
    expect(choicesFor('outside', { ...answer, mayAddOutside: false })).toEqual([])
  })

  it('an office-only project has no outside group and offers no outside add, whatever a read says', () => {
    const block = peopleBlockOf({ people: people(), facts: facts({}, { party: null }), now: NOW })
    expect(block.outside).toBeNull()
    expect(block.company).toBeNull()
    expect(addOutsideButton(facts({}, { party: null }))).toEqual({ offered: false, held: null })
    expect(block.addOutside.offered).toBe(false)
  })

  it('a project shared with an outside company offers its people to projects.manage only, the right in words otherwise', () => {
    expect(addOutsideButton(facts())).toEqual({ offered: true, held: null })
    expect(addOutsideButton(facts({}, { may: { manage: false, post: true, moves: [] } })).held?.key).toBe('held.noManage')
    expect(addTeamButton(facts({}, { may: { manage: false, post: false, moves: [] } })).held?.key).toBe('held.noPost')
    expect(addTeamButton(facts({}, { status: 'CLOSED' })).held?.key).toBe('held.closed')
    expect(addTeamButton(facts({ offline: true })).held?.key).toBe('held.offline')
  })

  it('the empty line says what is true: nobody left, or nobody matches', () => {
    expect(emptyChoicesKey('team', '')).toBe('add.nobodyTeam')
    expect(emptyChoicesKey('outside', '')).toBe('add.nobodyOutside')
    expect(emptyChoicesKey('team', 'zz')).toBe('add.noMatch')
  })

  it('a refused add is said from its code, naming no other company', () => {
    const refused = writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/MEMBER_OTHER_PARTY', message: 'x' }]))
    expect(refused.key).toBe('refusal.MEMBER_OTHER_PARTY')
    for (const locale of LOCALES) expect(CATALOGUE[locale]['products-projects']?.['refusal.MEMBER_OTHER_PARTY']).not.toMatch(/Brand Beta|Brand Alpha/)
  })
})

describe('the floor never (PROJ.members-F11)', () => {
  it('every row of every case is our team, the outside company or an invitation: there is no floor kind', () => {
    for (const entry of designScreen.cases) {
      const rows = [...entry.model.team.rows, ...(entry.model.outside?.rows ?? []), ...entry.model.invited.rows]
      for (const row of rows) expect(['team', 'outside', 'invited']).toContain(row.org)
    }
  })
})

describe('taking out and leaving (PROJ.members-F05, F06)', () => {
  it('the lead is never taken out and never leaves: pick a new lead first', () => {
    expect(outOf({ org: 'team', me: false, lead: true }, facts())).toEqual({ kind: 'remove', held: { key: 'refusal.MEMBER_LEAD' } })
    expect(outOf({ org: 'team', me: true, lead: true }, facts({}, { lead: { id: ME, name: 'Giulia Ferri' } }))).toEqual({ kind: 'leave', held: { key: 'refusal.MEMBER_LEAD' } })
  })

  it('only the lead or projects.manage takes someone out; anyone else may leave', () => {
    const plain = facts({}, { may: { manage: false, post: true, moves: [] } })
    expect(outOf({ org: 'team', me: false, lead: false }, plain)?.held?.key).toBe('refusal.MEMBER_REMOVE')
    expect(outOf({ org: 'outside', me: false, lead: false }, plain)?.held?.key).toBe('refusal.MEMBER_REMOVE')
    expect(outOf({ org: 'team', me: true, lead: false }, plain)).toEqual({ kind: 'leave', held: null })
    // The lead takes out without projects.manage.
    expect(outOf({ org: 'team', me: false, lead: false }, facts({ meId: LEAD }, { may: { manage: false, post: true, moves: [] } }))).toEqual({ kind: 'remove', held: null })
  })

  it('a closed project, offline or a write under way hold it with why; an invitation is ended from the Share door, not here', () => {
    expect(outOf({ org: 'team', me: false, lead: false }, facts({}, { status: 'CLOSED' }))?.held?.key).toBe('held.closed')
    expect(outOf({ org: 'team', me: false, lead: false }, facts({ offline: true }))?.held?.key).toBe('held.offline')
    expect(outOf({ org: 'team', me: false, lead: false }, facts({ busy: true }))?.held?.key).toBe('held.busy')
    expect(outOf({ org: 'invited', me: false, lead: false }, facts())).toBeNull()
  })
})

describe('counts and words', () => {
  it('a group counts what the API counts, not the rows shown: the first 200 and the exact count', () => {
    const many = designScreen.cases.find((entry) => entry.id === 'many')!.model
    expect(many.team.count).toBe(312)
    expect(many.team.rows).toHaveLength(PEOPLE_SHOWN)
    expect(many.team.hidden).toBe(312 - PEOPLE_SHOWN)
    const block = peopleBlockOf({ people: people({ office: { count: 9, people: people().office.people } }), facts: facts(), now: NOW })
    expect(block.team.count).toBe(9)
    expect(peopleTotal(block)).toBe(9 + 1 + 0)
  })

  it('“Only you” only when I am the one person of our team', () => {
    const me = people().office.people[1]!
    expect(peopleBlockOf({ people: people({ office: { count: 1, people: [me] } }), facts: facts(), now: NOW }).onlyMe).toBe(true)
    expect(peopleBlockOf({ people: people(), facts: facts(), now: NOW }).onlyMe).toBe(false)
  })

  it('why each one is there: every reason has its words; someone added by another reads “added by …”, never “chose to follow”', () => {
    for (const reason of FOLLOW_REASONS) {
      for (const locale of LOCALES) expect(CATALOGUE[locale][PEOPLE_NS]?.[reasonKey(reason)], `${reason} ${locale}`).toBeTruthy()
    }
    expect(whyOf('ADDED', { name: 'Marco Neri' })).toEqual({ key: 'why.addedBy', params: { name: 'Marco Neri' } })
    expect(whyOf('ADDED', null)).toEqual({ key: 'why.ADDED' })
    expect(whyOf('CREATOR', null)).toEqual({ key: 'why.CREATOR' })
  })

  it('an invitation whose end has passed reads Ended', () => {
    const block = peopleBlockOf({
      people: people({ invited: { count: 2, people: [{ shareId: 's1', name: null, email: 'studio@designer.example', until: '2026-11-15T23:00:00.000Z', permissions: [] }, { shareId: 's2', name: 'Alma', email: 'alma@designer.example', until: '2027-01-01T00:00:00.000Z', permissions: [] }] } }),
      facts: facts(),
      now: NOW,
    })
    expect(block.invited.rows.map((row) => [row.name, row.ended])).toEqual([
      ['studio@designer.example', true],
      ['Alma', false],
    ])
  })

  it('both languages hold the same keys with the same placeholders', () => {
    const italian = CATALOGUE.it[PEOPLE_NS] ?? {}
    const english = CATALOGUE.en[PEOPLE_NS] ?? {}
    expect(Object.keys(italian).length).toBeGreaterThan(0)
    expect(Object.keys(italian).sort()).toEqual(Object.keys(english).sort())
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const key of Object.keys(english)) expect(holes(String(italian[key])), key).toEqual(holes(String(english[key])))
  })
})

const RAW = /\b(?:people|why|add|out|notice|refusal|problem|held|common|status|field)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/
const RECEIPTS = /seen by|last active|read by|visto da|letto da|ultimo accesso|ultima attivit/i

describe('SCR-701-people design cases', () => {
  it('every case draws in Italian and English with no raw key, no read receipt and no other customer', () => {
    expect(designScreen.cases.length).toBeGreaterThanOrEqual(9)
    for (const locale of LOCALES) {
      for (const entry of designScreen.cases) {
        const html = render(entry.model, locale)
        expect(html, `${entry.id} (${locale})`).not.toMatch(RAW)
        expect(html, `${entry.id} (${locale})`).not.toMatch(RECEIPTS)
        expect(scanText(html, BRAND_BETA), `${entry.id} (${locale})`).toEqual([])
        expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
      }
    }
  })

  it('the outside company is named on its people’s rows, and an office-only project names none', () => {
    const customer = render(PEOPLE_DEMO.customer, 'en')
    expect(customer).toContain('Brand Alpha (2)')
    expect(customer).toContain('Anna Alfieri')
    expect(customer).toContain('Our team (4)')
    const officeOnly = render(PEOPLE_DEMO.officeOnly, 'en')
    expect(officeOnly).not.toContain('Brand Alpha')
    expect(officeOnly).not.toContain('Add Brand Alpha people')
  })
})
