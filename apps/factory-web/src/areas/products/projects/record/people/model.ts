import { FOLLOW_REASONS, type FollowReason } from '@nexus/factory-domain/threads/followers'
import type { PeopleChoices, ProjectPeople, ProjectView } from '../../api'
import { NO_MANAGE, NO_POST, OFFLINE, PROJECT_LIMITS, type Notice, type Phrase } from '../../model'

/**
 * B-TH-250 — a project's people (threads plan TH-5; design PROJ.members-F01 … F11; the API's B-TH-068), pure: the People block's
 * rows (our team, the outside company's people, the people invited by link), why each one is there, who may add or take out whom
 * and why not, what the add dialog offers. Every word is a key of `products-projects-people` (a phrase of the shared catalogue —
 * `refusal.*`, `held.*` — is said from it by `useWords().say`).
 *
 * THE WALL (W38, W06): the outside picker lists EXACTLY the API's `choices.outside` (the API scopes it to the project's own outside
 * company: nothing is ever merged into it, so a person of another company can never be picked); an office-only project has no
 * outside people and offers no outside add. Art. 4: no "seen by", no "last active", no count of messages per person — only who
 * is in, why and since when. The floor never: the choices are office people and the project's company's portal people only.
 */

export const PEOPLE_NS = 'products-projects-people'
/** The most people a group shows; its count stays the API's exact count. */
export const PEOPLE_SHOWN = PROJECT_LIMITS.people

export type PersonOrg = 'team' | 'outside' | 'invited'

export interface PersonRow {
  /** Unique in the block (`team:<user>`, `outside:<user>`, `invited:<share>`). */
  readonly key: string
  /** The person (null for someone invited by link: they have no account). */
  readonly userId: string | null
  /** Their name, or the e-mail of a link invitation without a contact name. */
  readonly name: string
  readonly me: boolean
  readonly lead: boolean
  readonly org: PersonOrg
  /** Why they are in ("added by Marco", "made it"); null for an invitation. */
  readonly why: Phrase | null
  /** Since when (an instant); null for an invitation. */
  readonly since: string | null
  /** An invitation's end (an instant), and whether it has passed. */
  readonly until: string | null
  readonly ended: boolean
  readonly muted: boolean
  /** Take out (another person) or Leave (me): absent when not offered here, else held with why or null (it may). */
  readonly out: { readonly kind: 'remove' | 'leave'; readonly held: Phrase | null } | null
}

export interface PeopleGroup {
  /** The API's exact count (never the length of the rows shown). */
  readonly count: number
  readonly rows: readonly PersonRow[]
  /** People not shown (count − rows shown): "Showing the first 200 of 312". */
  readonly hidden: number
}

export interface AddButton {
  /** Not offered at all (an office-only project has no outside add). */
  readonly offered: boolean
  readonly held: Phrase | null
}

export interface AddDialogModel {
  readonly kind: 'team' | 'outside'
  readonly q: string
  /** The people offered now (null while read); for `outside` exactly the API's `choices.outside`. */
  readonly choices: readonly { readonly userId: string; readonly name: string }[] | null
  /** A failed read (a shared `problem.*` key). */
  readonly problem: string | null
  /** The API says this person may add the outside company's people now (projects.manage, an open project with one). */
  readonly mayAddOutside: boolean
  /** The person being added. */
  readonly busy: string | null
  /** A refused add, in words. */
  readonly notice: Notice | null
  readonly offline: boolean
}

export interface ConfirmModel {
  readonly kind: 'remove' | 'leave'
  readonly row: PersonRow
  readonly busy: boolean
  readonly notice: Notice | null
}

export interface PeopleBlockModel {
  /** The project's number ("PRJ-26-012"), named in the dialogs. */
  readonly project: string
  /** The outside company's name; null: an office-only project (no outside group, no outside add). */
  readonly company: string | null
  readonly team: PeopleGroup
  readonly outside: PeopleGroup | null
  readonly invited: PeopleGroup
  /** Nobody but me in our team: "Only you. Add a colleague." */
  readonly onlyMe: boolean
  readonly addTeam: AddButton
  readonly addOutside: AddButton
  /** May add the outside company's people at all (projects.manage): the hint about invitations by link is for them. */
  readonly manages: boolean
  readonly notice: Notice | null
  readonly dialog: AddDialogModel | null
  readonly confirm: ConfirmModel | null
}

export interface PeopleBlockActions {
  onAdd?: (kind: 'team' | 'outside') => void
  onOut?: (row: PersonRow) => void
  onDismissNotice?: () => void
  dialog?: {
    onQuery?: (q: string) => void
    onPick?: (userId: string) => void
    onRetry?: () => void
    onClose?: () => void
  }
  confirm?: {
    onConfirm?: () => void
    onCancel?: () => void
  }
}

// ---- why each one is there ------------------------------------------------------------------------------------------------------

/** The words of a reason (`why.CREATOR` "made it" …). */
export const reasonKey = (reason: FollowReason): string => `why.${(FOLLOW_REASONS as readonly string[]).includes(reason) ? reason : 'ADDED'}`

/**
 * Why a person is in (PROJ.members-F01, F03): added by someone else → "added by Marco" (never "chose to follow · added by …", the
 * old contradiction); added without a known adder → "was added"; else the reason's own words (made it, was mentioned, chose to
 * follow, was given something on it).
 */
export function whyOf(reason: FollowReason, addedBy: { readonly name: string } | null): Phrase {
  if (addedBy && addedBy.name.trim() !== '' && (reason === 'ADDED' || reason === 'CHOSE')) return { key: 'why.addedBy', params: { name: addedBy.name } }
  return { key: reasonKey(reason) }
}

// ---- who may do what ---------------------------------------------------------------------------------------------------------

export interface PeopleFacts {
  readonly project: Pick<ProjectView, 'number' | 'party' | 'lead' | 'status' | 'may'>
  readonly meId: string
  readonly offline: boolean
  /** A write is under way. */
  readonly busy: boolean
}

const closedHeld: Phrase = { key: 'held.closed' }
const busyHeld: Phrase = { key: 'held.busy' }

/** Why nobody can be added now, or null (a closed project, offline, busy). */
function writeHeld(facts: PeopleFacts): Phrase | null {
  if (facts.project.status === 'CLOSED') return closedHeld
  if (facts.offline) return OFFLINE
  if (facts.busy) return busyHeld
  return null
}

/** Add a colleague (PROJ.members-F02): threads.post over the project. */
export function addTeamButton(facts: PeopleFacts): AddButton {
  if (!facts.project.may.post) return { offered: true, held: NO_POST }
  return { offered: true, held: writeHeld(facts) }
}

/** Add the outside company's people (PROJ.members-F07): projects.manage, only on a project shared with an outside company. */
export function addOutsideButton(facts: PeopleFacts): AddButton {
  if (facts.project.party === null) return { offered: false, held: null }
  if (!facts.project.may.manage) return { offered: true, held: NO_MANAGE }
  if (!facts.project.may.post) return { offered: true, held: NO_POST }
  return { offered: true, held: writeHeld(facts) }
}

/**
 * Take a person out (PROJ.members-F06; the lead or projects.manage, the route itself needs threads.post) or leave (me, F05). The
 * lead is never taken out and never leaves (MEMBER_LEAD: pick a new lead first). Someone invited by link is ended from the thread's
 * Share door, not here.
 */
export function outOf(row: Pick<PersonRow, 'org' | 'me' | 'lead'>, facts: PeopleFacts): PersonRow['out'] {
  if (row.org === 'invited') return null
  const kind = row.me ? 'leave' : 'remove'
  if (row.lead) return { kind, held: { key: 'refusal.MEMBER_LEAD' } }
  if (kind === 'remove') {
    const leads = facts.project.lead.id === facts.meId
    if (!leads && !facts.project.may.manage) return { kind, held: { key: 'refusal.MEMBER_REMOVE' } }
    if (!facts.project.may.post) return { kind, held: NO_POST }
  }
  return { kind, held: writeHeld(facts) }
}

// ---- the block ---------------------------------------------------------------------------------------------------------------

/** Whether an invitation's end has passed (an instant against now). */
export const hasEnded = (until: string, now: number): boolean => Date.parse(until) <= now

/** The People block from the API's people (`GET /projects/:id/people`), the project and the reader. Pure. */
export function peopleBlockOf(input: {
  readonly people: ProjectPeople
  readonly facts: PeopleFacts
  readonly now: number
  readonly notice?: Notice | null
  readonly dialog?: AddDialogModel | null
  readonly confirm?: ConfirmModel | null
}): PeopleBlockModel {
  const { people, facts, now } = input
  const party = facts.project.party
  const teamRows: PersonRow[] = people.office.people.slice(0, PEOPLE_SHOWN).map((person) => {
    const base = { org: 'team' as const, me: person.me || person.userId === facts.meId, lead: person.lead || person.userId === facts.project.lead.id }
    return {
      key: `team:${person.userId}`,
      userId: person.userId,
      name: person.name,
      ...base,
      why: whyOf(person.reason, person.addedBy),
      since: person.since,
      until: null,
      ended: false,
      muted: person.muted,
      out: outOf(base, facts),
    }
  })
  const outsideRows: PersonRow[] = people.outside.people.slice(0, PEOPLE_SHOWN).map((person) => {
    const base = { org: 'outside' as const, me: false, lead: false }
    return { key: `outside:${person.userId}`, userId: person.userId, name: person.name, ...base, why: whyOf(person.reason, person.addedBy), since: person.since, until: null, ended: false, muted: false, out: outOf(base, facts) }
  })
  const invitedRows: PersonRow[] = people.invited.people.slice(0, PEOPLE_SHOWN).map((invite) => ({
    key: `invited:${invite.shareId}`,
    userId: null,
    name: invite.name?.trim() ? invite.name : invite.email,
    me: false,
    lead: false,
    org: 'invited' as const,
    why: null,
    since: null,
    until: invite.until,
    ended: hasEnded(invite.until, now),
    muted: false,
    out: null,
  }))
  const group = (count: number, rows: PersonRow[]): PeopleGroup => ({ count, rows, hidden: Math.max(0, count - rows.length) })
  return {
    project: facts.project.number,
    company: party ? party.name : null,
    team: group(people.office.count, teamRows),
    // An office-only project has no outside group at all (MEMBER_OFFICE_ONLY), whatever a read says.
    outside: party ? group(people.outside.count, outsideRows) : null,
    invited: group(people.invited.count, invitedRows),
    onlyMe: people.office.count === 1 && teamRows.length === 1 && teamRows[0]!.me,
    addTeam: addTeamButton(facts),
    addOutside: addOutsideButton(facts),
    manages: facts.project.may.manage,
    notice: input.notice ?? null,
    dialog: input.dialog ?? null,
    confirm: input.confirm ?? null,
  }
}

/** The total the section's heading says: the three exact counts. */
export const peopleTotal = (block: Pick<PeopleBlockModel, 'team' | 'outside' | 'invited'>): number => block.team.count + (block.outside?.count ?? 0) + block.invited.count

// ---- the add dialog ------------------------------------------------------------------------------------------------------------

/**
 * What the add dialog offers: our colleagues who may read the project (`office`), or EXACTLY the outside company's portal people the
 * API offers (`outside`, empty unless `mayAddOutside`). Nothing else is ever merged in (W38).
 */
export function choicesFor(kind: 'team' | 'outside', answer: PeopleChoices): readonly { userId: string; name: string }[] {
  if (kind === 'team') return answer.office
  return answer.mayAddOutside ? answer.outside : []
}

/** The dialog's empty line: nobody matches what was typed, or nobody is left to add (each kind its own words). */
export function emptyChoicesKey(kind: 'team' | 'outside', q: string): string {
  if (q.trim() !== '') return 'add.noMatch'
  return kind === 'team' ? 'add.nobodyTeam' : 'add.nobodyOutside'
}

/** The success notice of an add (a colleague is told; the outside company's person sees it in their portal). */
export const addedNotice = (kind: 'team' | 'outside', name: string): Notice => ({ key: kind === 'team' ? 'notice.addedTeam' : 'notice.addedOutside', params: { name }, tone: 'success' })
