import type { Team } from '../../_shared/api'

/**
 * B-TH-271 (threads plan TH-6, PL6; O-PPL-TEAM.list / .thread; picture 40) — the team's window in Employees › Teams: its facts (line,
 * lead, members, today's loans) and the team's office notes docked beside them. The pure part: the address, who reads the notes,
 * the walk over the teams shown.
 */

/** `?view=teams&open=<team>`: the team's window (a real address: Back closes it, a link opens it). */
export const TEAM_WINDOW_PARAM = 'open'

/** The team the address opens (only in the Teams view). */
export function teamWindowOf(params: { get(name: string): string | null } | null | undefined): string | null {
  if (params?.get('view') !== 'teams') return null
  return params.get(TEAM_WINDOW_PARAM) || null
}

/** The address with the team's window open (a team id) or closed (null); every other term kept. */
export function teamWindowHref(pathname: string, search: string, teamId: string | null): string {
  const terms = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  if (teamId) {
    terms.set('view', 'teams')
    terms.set(TEAM_WINDOW_PARAM, teamId)
  } else terms.delete(TEAM_WINDOW_PARAM)
  const text = terms.toString()
  return `${pathname}${text ? `?${text}` : ''}`
}

/**
 * The team's notes are read with threads.read AND people.view (the API's THREAD_GATES: notes about people are read only by whoever
 * may view the people, GDPR art. 4): office notes only — a team has no party, nothing reaches the floor unless ticked, no read record.
 */
export function readsTeamNotes(permissions: readonly string[]): boolean {
  return permissions.includes('threads.read') && permissions.includes('people.view')
}

/** J / K walk the teams the view shows, in its order; null when the open team is not among them. */
export function teamWalk(teams: readonly Pick<Team, 'id'>[], current: string | null): readonly string[] | null {
  const ids = teams.map((team) => team.id)
  return current && ids.includes(current) ? ids : null
}

/** The team's name as its window and its thread say it ("T-CUC1 · Cucito 1"). */
export const teamTitle = (team: Pick<Team, 'code' | 'name'>): string => `${team.code} · ${team.name}`
