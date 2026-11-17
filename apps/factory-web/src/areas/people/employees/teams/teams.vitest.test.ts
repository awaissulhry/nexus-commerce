import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { render, textOf } from '../../../../lib/record-thread/parts/testing'
import { TEAMS } from '../../_shared/fixtures'
import { designScreen } from '../fixtures'
import { readsTeamNotes, TEAM_WINDOW_PARAM, teamTitle, teamWalk, teamWindowHref, teamWindowOf } from './model'

// The DS DetailModal opens only in a browser (after hydration, in a portal): here it draws in place — its title and its content — so
// the team's window itself is checked (as quality/holds/review-window.vitest does).
vi.mock('@nexus/ui/patterns', async (original) => {
  const actual = await original<typeof import('@nexus/ui/patterns')>()
  const DetailModal = ({ open, title, children }: { open: boolean; title?: unknown; children?: unknown }) => (open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), children as never) : null)
  return { ...actual, DetailModal }
})

/**
 * B-TH-271 (threads plan TH-6, PL6; O-PPL-TEAM.list-F02 / .thread-F01; picture 40): a team's window in Employees › Teams — its facts
 * and the team's office notes docked beside them (notes only: a team has no party), read only with threads.read AND people.view (the
 * API's gate on notes about people); an empty thread folds to "Add a note"; the window's address keeps every other term.
 */

const View = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: (typeof LOCALES)[number] = 'en') => {
  const found = designScreen.cases.find((entry) => entry.id === id)
  if (!found) throw new Error(`no case ${id}`)
  return render(createElement(View, { model: found.model }), locale)
}
const threadOf = (html: string) => {
  const at = html.indexOf('class="fw-rw-thread"')
  return at < 0 ? '' : html.slice(at)
}

describe('the team window’s address and rights', () => {
  it('?view=teams&open=<team> opens a team’s window; another view opens none; open / close keep every other term', () => {
    expect(TEAM_WINDOW_PARAM).toBe('open')
    expect(teamWindowOf(new URLSearchParams('view=teams&open=t1'))).toBe('t1')
    expect(teamWindowOf(new URLSearchParams('open=t1'))).toBeNull()
    expect(teamWindowOf(new URLSearchParams('view=teams&open='))).toBeNull()
    expect(teamWindowHref('/w/DEMO/people/employees', 'view=teams&line=l1', 't1')).toBe('/w/DEMO/people/employees?view=teams&line=l1&open=t1')
    expect(teamWindowHref('/w/DEMO/people/employees', '?view=teams&line=l1&open=t1', null)).toBe('/w/DEMO/people/employees?view=teams&line=l1')
    expect(teamWindowHref('/w/DEMO/people/employees', '', 't2')).toBe('/w/DEMO/people/employees?view=teams&open=t2')
  })

  it('the notes need threads.read AND people.view (notes about people, GDPR art. 4)', () => {
    expect(readsTeamNotes(['threads.read', 'people.view'])).toBe(true)
    expect(readsTeamNotes(['threads.read'])).toBe(false)
    expect(readsTeamNotes(['people.view'])).toBe(false)
  })

  it('J / K walk the teams shown, in their order; a team not shown walks nowhere', () => {
    expect(teamWalk(TEAMS, TEAMS[0]!.id)).toEqual(TEAMS.map((team) => team.id))
    expect(teamWalk(TEAMS, 'gone')).toBeNull()
    expect(teamTitle(TEAMS[0]!)).toBe(`${TEAMS[0]!.code} · ${TEAMS[0]!.name}`)
  })
})

describe('B-TH-271: a team’s window with its office notes docked (PL6)', () => {
  it('the window shows the team’s lead and members, and ONE thread in its right column, after the facts, R-ACT in its "⋯"', () => {
    const html = draw('team-window')
    const team = TEAMS[0]!
    expect(textOf(html)).toContain(teamTitle(team))
    for (const member of team.members) expect(textOf(html), member.name).toContain(member.name)
    expect(html.match(/class="fw-rw-thread"/g)?.length).toBe(1)
    expect(html.match(/class="fw-rt-column[ "]/g)?.length).toBe(1)
    expect(threadOf(html)).toContain('aria-label="Thread tools"')
    expect(html.indexOf('class="fw-rw-body"')).toBeLessThan(html.indexOf('class="fw-rw-thread"'))
    expect(html).toContain(`aria-label="Office notes of team ${teamTitle(team)}"`)
  })

  it('a team has no party: office notes only — no "Reply to", no e-mail, no customer (W08, W20, W25)', () => {
    for (const locale of LOCALES) {
      const thread = textOf(threadOf(draw('team-window', locale)))
      expect(thread.length, locale).toBeGreaterThan(20)
      expect(thread, locale).not.toMatch(/Reply to (?!the customer)|Rispondi a /)
      expect(thread, locale).not.toMatch(/@[a-z0-9-]+\.example/)
      expect(thread, locale).not.toMatch(/Brand Alpha|Brand Beta/)
    }
  })

  it('no notes yet: the thread folds to a slim "Add a note" column; without the rights the window is the team alone', () => {
    const empty = draw('team-window-empty')
    expect(empty).toContain('class="fw-rw has-thread is-folded"')
    expect(textOf(threadOf(empty))).toContain('Add a note')
    const none = draw('team-window-no-notes')
    expect(none).toContain('class="fw-rw"')
    expect(none).not.toContain('fw-rw-thread')
  })

  it('every team card opens its window ("Open the team", also in its ⋯), in it and en', () => {
    const html = draw('teams')
    expect(textOf(html)).toContain('Open the team')
    expect(textOf(draw('teams', 'it'))).toContain('Apri la squadra')
    const panel = readFileSync(new URL('../view/TeamsPanel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain("actions?.onOpenTeam?.(team.id)")
  })

  it('the page mounts the team’s thread docked, notes only, with threads.read and people.view; the window’s term goes with the view', () => {
    const page = readFileSync(new URL('../EmployeesPage.tsx', import.meta.url), 'utf8')
    expect(page).toMatch(/<OfficeRecordThread\s+key=\{openTeam\.id\}\s+docked/)
    expect(page).toContain("type: 'Team'")
    expect(page).toContain('party={null}')
    expect(page).toContain('readsTeamNotes(session.permissions)')
    expect(page).toContain("if (merged.view !== 'teams') keep.delete('open')")
  })
})
