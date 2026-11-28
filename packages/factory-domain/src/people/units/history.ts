import { READY_MADE_KINDS, type ReadyMadeKind } from './rules'

/**
 * The History tab of a unit and of a person (owb-ss5 step 5.2; design order-workflow-2026-11-25 § 5zb "Control: every change is one
 * line in the History of the unit and of the person, with who and when. Nothing is erased"; prototype org.js olog / orgHistory).
 * Pure: the API reads the AuditLog rows of the record (newest first, only the actions of the ALLOW-lists below — never a
 * hide-list: a new kind of row stays out until it is put here, as the order log's faces in sales/order-log/faces.ts) and the
 * names, and this file says each row's words and ONE lucide icon. The office reads it only (people.view over the record).
 *
 * The words never name a customer (a unit's customers are counted, never named), never a figure about one person's work, and no
 * personal detail beyond what the profile shows (the name, the role, the language). Who: an office person by name, else
 * "Office"; a system row "System"; a floor row "Floor" (the floor never writes the structure).
 */

/** The audit actions of the units' commands (apps/factory-api modules/people/units): the command names, one per kind of change. */
export const UNIT_ACTIONS = {
  create: 'people.units.create',
  update: 'people.units.update',
  move: 'people.units.move',
  merge: 'people.units.merge',
  close: 'people.units.close',
  readyMade: 'people.units.readyMade',
} as const

/** A unit's history (Team rows): today's team commands and the units' commands. */
export const UNIT_HISTORY_ACTIONS: readonly string[] = Object.freeze([
  'people.createTeam',
  'people.updateTeam',
  'people.archiveTeam',
  'people.setTeamLead',
  'people.moveTeamMembers',
  'people.endMembership',
  ...Object.values(UNIT_ACTIONS),
])

/** A person's history (Employee rows): joining the register, role and language changes, loans, moves made by a merge or a ready-made structure. */
export const PERSON_HISTORY_ACTIONS: readonly string[] = Object.freeze([
  'people.createEmployee',
  'people.employeeFromWorker',
  'people.employeeFromUser',
  'people.updateEmployee',
  'people.lendToLine',
  'people.endLoan',
  'people.removeLoan',
  UNIT_ACTIONS.merge,
  UNIT_ACTIONS.readyMade,
])

/** The Team rows that name a person, shown on that person's history too (moves, the lead, a membership ended). */
export const PERSON_TEAM_ACTIONS: readonly string[] = Object.freeze(['people.moveTeamMembers', 'people.setTeamLead', 'people.endMembership'])

/** The ready-made structures as the owner reads them (org.js ORG_TPL). */
export const READY_MADE_NAMES: Readonly<Record<ReadyMadeKind, string>> = Object.freeze({
  OWNER_TEAMS: 'The owner and the teams',
  SUPERVISORS: 'With supervisors',
  GENERAL_MANAGER: 'With a general manager',
})

/** One audit row as the history reads it. */
export interface HistoryAudit {
  readonly id: string
  readonly at: string
  readonly audience: string
  readonly actorId: string
  readonly action: string
  readonly recordType: string
  readonly recordId: string
  readonly before: unknown
  readonly after: unknown
}

/** The names the API looked up: office people (actor ids), employees, units (Team ids). */
export interface HistoryNames {
  readonly actors: ReadonlyMap<string, string>
  readonly employees: ReadonlyMap<string, string>
  readonly units: ReadonlyMap<string, string>
}

/** Whose history: a unit (its id and code) or a person (their employee id). */
export type HistorySubject = { readonly kind: 'UNIT'; readonly unitId: string; readonly unitCode: string } | { readonly kind: 'PERSON'; readonly employeeId: string }

/** A row of the History tab (the Shape of owb-ss5.md). */
export interface HistoryRow {
  readonly at: string
  readonly who: string
  readonly words: string
  readonly icon: string
}

type Json = Record<string, unknown>
const obj = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const dayOf = (value: unknown): string | null => (typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : null)
const readyMadeName = (value: unknown): string => (typeof value === 'string' && (READY_MADE_KINDS as readonly string[]).includes(value) ? READY_MADE_NAMES[value as ReadyMadeKind] : 'ready-made')

/** Who wrote a row, as the office reads it. */
export function whoOf(row: Pick<HistoryAudit, 'audience' | 'actorId'>, actors: ReadonlyMap<string, string>): string {
  switch (row.audience) {
    case 'OFFICE':
      return actors.get(row.actorId) ?? 'Office'
    case 'SYSTEM':
      return 'System'
    case 'FLOOR':
      return 'Floor'
    default:
      return 'Portal'
  }
}

/** The words of the fields a profile change touched (people.units.update). */
const FIELD_WORDS: Readonly<Record<string, string>> = Object.freeze({
  kindWord: 'the kind',
  pictureKind: 'the picture',
  pictureIcon: 'the picture',
  pictureColour: 'the picture',
  about: 'what it does',
  standInEmployeeId: 'who stands in',
  standInUntil: 'who stands in',
  worksForPartyIds: 'the customers it works for',
  maxBaskets: 'baskets at one time',
  takesNewOrders: 'takes new orders',
  takesOrders: 'takes orders',
  lineId: 'the line',
})

const movedWords = (from: string | null, to: string | null): string => `${to === null ? 'Moved to the top' : `Moved under ${to}`} (was ${from === null ? 'at the top' : `under ${from}`})`

/** The words and icon of a Team row (a unit's own history), or null when it says nothing (a save without a change). */
function unitWords(row: HistoryAudit, subject: Extract<HistorySubject, { kind: 'UNIT' }>, names: HistoryNames): { words: string; icon: string } | null {
  const before = obj(row.before)
  const after = obj(row.after)
  const person = (id: unknown): string | null => (typeof id === 'string' ? (names.employees.get(id) ?? null) : null)
  switch (row.action) {
    case 'people.createTeam':
      return { words: 'Made', icon: 'plus' }
    case 'people.units.create':
      return { words: str(after.parentName) ? `Made under ${str(after.parentName)}` : 'Made at the top', icon: 'plus' }
    case 'people.updateTeam':
    case 'people.units.update': {
      if (after.unchanged === true) return null
      const parts: string[] = []
      if (str(after.name) !== null && str(before.name) !== null) parts.push(`the name (${str(before.name)} → ${str(after.name)})`)
      // In the profile window's order (the stored row is jsonb: its keys come back in no order of ours).
      for (const key of Object.keys(FIELD_WORDS).filter((field) => field in after)) {
        const word = FIELD_WORDS[key]
        if (key === 'standInEmployeeId') {
          const name = person(after.standInEmployeeId)
          const shown = `who stands in (${name ?? 'nobody'})`
          if (!parts.includes(shown)) parts.push(shown)
        } else if (word && !parts.includes(word) && !(key === 'standInUntil' && 'standInEmployeeId' in after)) parts.push(word)
      }
      if (parts.length === 0) return null
      return { words: `Profile changed: ${parts.join(', ')}`, icon: 'pencil' }
    }
    case 'people.archiveTeam':
    case 'people.units.close':
      return { words: 'Closed', icon: 'archive' }
    case 'people.setTeamLead': {
      const from = person(before.leadEmployeeId)
      const to = person(after.leadEmployeeId)
      if ((before.leadEmployeeId ?? null) === (after.leadEmployeeId ?? null)) return null
      return { words: `Leader: ${from ?? 'nobody'} → ${to ?? 'nobody'}`, icon: 'crown' }
    }
    case 'people.moveTeamMembers': {
      const moved = list(after.moved).map(obj)
      const into = moved.filter((entry) => entry.to === subject.unitCode).map((entry) => person(entry.employeeId) ?? 'a person')
      const out = moved.filter((entry) => entry.from === subject.unitCode).map((entry) => person(entry.employeeId) ?? 'a person')
      const parts = [...(into.length > 0 ? [`Moved in: ${into.join(', ')}`] : []), ...(out.length > 0 ? [`Moved out: ${out.join(', ')}`] : [])]
      return parts.length === 0 ? null : { words: parts.join(' · '), icon: 'arrow-right-left' }
    }
    case 'people.endMembership':
      return { words: `${person(before.employeeId) ?? 'A person'} left the unit`, icon: 'user-minus' }
    case 'people.units.move':
      return after.unchanged === true ? null : { words: movedWords(str(before.parentName), str(after.parentName)), icon: 'move' }
    case 'people.units.merge': {
      if (str(after.keptName) !== null) return { words: `Merged into ${str(after.keptName)}: closed`, icon: 'merge' }
      const merged = list(after.merged).map((entry) => str(obj(entry).name) ?? 'a unit')
      const moved = [plural(num(after.people), 'person', 'people'), plural(num(after.orders), 'open order', 'open orders'), plural(num(after.units), 'unit', 'units')]
      return { words: `${merged.join(', ')} became one with it: ${moved.join(', ')} moved here`, icon: 'merge' }
    }
    case 'people.units.readyMade': {
      const name = readyMadeName(after.kind)
      switch (after.change) {
        case 'MAKE':
          return { words: `Made by the ready-made structure “${name}”, ${str(after.to) ? `under ${str(after.to)}` : 'at the top'}`, icon: 'layers' }
        case 'REOPEN':
          return { words: `Opened again by the ready-made structure “${name}”, ${str(after.to) ? `under ${str(after.to)}` : 'at the top'}`, icon: 'layers' }
        case 'MOVE':
          return { words: `${movedWords(str(before.parentName), str(after.to))} by the ready-made structure “${name}”`, icon: 'layers' }
        case 'CLOSE':
          return { words: `Closed by the ready-made structure “${name}”`, icon: 'layers' }
        default:
          return null
      }
    }
    default:
      return null
  }
}

/** The words and icon of a row on a person's history (their Employee rows and the Team rows that name them), or null. */
function personWords(row: HistoryAudit, subject: Extract<HistorySubject, { kind: 'PERSON' }>, names: HistoryNames): { words: string; icon: string } | null {
  const before = obj(row.before)
  const after = obj(row.after)
  const me = subject.employeeId
  const unit = names.units.get(row.recordId) ?? 'a unit'
  switch (row.action) {
    case 'people.createEmployee':
    case 'people.employeeFromWorker':
    case 'people.employeeFromUser':
      return { words: 'Added to the people register', icon: 'user-plus' }
    case 'people.updateEmployee': {
      if (after.unchanged === true) return null
      const parts: string[] = []
      if ((before.jobRole ?? null) !== (after.jobRole ?? null)) parts.push(`Role: ${str(before.jobRole) ?? 'none'} → ${str(after.jobRole) ?? 'none'}`)
      if ((before.locale ?? null) !== (after.locale ?? null)) parts.push(`Reads and speaks: ${str(before.locale) ?? '—'} → ${str(after.locale) ?? '—'}`)
      if (before.firstName !== after.firstName || before.lastName !== after.lastName || before.displayName !== after.displayName) parts.push('Name changed')
      if ((before.siteId ?? null) !== (after.siteId ?? null)) parts.push('Moved to another site')
      return { words: parts.length > 0 ? parts.join(' · ') : 'Record changed', icon: 'pencil' }
    }
    case 'people.lendToLine': {
      const until = dayOf(after.endsAt)
      return { words: until ? `Lent to another line until ${until}` : 'Lent to another line', icon: 'handshake' }
    }
    case 'people.endLoan':
      return { words: 'A loan ended early', icon: 'clock' }
    case 'people.removeLoan':
      return { words: 'A planned loan was taken back', icon: 'undo-2' }
    case 'people.units.merge': {
      const to = str(obj(after.to).name) ?? 'the kept unit'
      const from = str(obj(after.from).name)
      return { words: `Moved to ${to} (the units were merged${from ? `; was in ${from}${after.wasLeader === true ? ', its leader' : ''}` : ''})`, icon: 'merge' }
    }
    case 'people.units.readyMade': {
      const from = str(obj(after.from).name) ?? 'a unit'
      return { words: `Taken out of ${from}: waits in “In no unit yet” (ready-made structure “${readyMadeName(after.kind)}”)`, icon: 'user-minus' }
    }
    case 'people.moveTeamMembers': {
      const mine = list(after.moved).map(obj).find((entry) => entry.employeeId === me)
      if (!mine) return null
      const from = str(mine.from)
      const to = str(mine.to)
      if (from === null && to === null) return null
      const words = from === null ? `Moved into team ${to}` : to === null ? `Taken out of team ${from}` : `Moved from team ${from} to team ${to}`
      return { words, icon: 'arrow-right-left' }
    }
    case 'people.setTeamLead':
      if (after.leadEmployeeId === me && before.leadEmployeeId !== me) return { words: `Leads ${unit}`, icon: 'crown' }
      if (before.leadEmployeeId === me && after.leadEmployeeId !== me) return { words: `No longer leads ${unit}`, icon: 'crown' }
      return null
    case 'people.endMembership':
      return before.employeeId === me ? { words: `Left ${unit}`, icon: 'user-minus' } : null
    default:
      return null
  }
}

/** The rows of a history, newest first as read (a row that says nothing is left out). */
export function historyRows(rows: readonly HistoryAudit[], subject: HistorySubject, names: HistoryNames): HistoryRow[] {
  return rows.flatMap((row) => {
    const face = subject.kind === 'UNIT' ? unitWords(row, subject, names) : personWords(row, subject, names)
    return face ? [{ at: row.at, who: whoOf(row, names.actors), words: face.words, icon: face.icon }] : []
  })
}
