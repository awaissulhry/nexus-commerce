import { scheduleProblems, SCHEDULE_LIMITS } from '@nexus/factory-domain/inventory/counts-depth/schedules'
import type { Tone } from '@nexus/ui/primitives'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { CountItemKind } from '../api'
import type { CountsCan, Phrase } from '../model'
import type { AbcClass, BlockedPlace, DueState, Schedule, ScheduleBody, ScheduleChange } from './api'

/**
 * B-W2b-320 — the W2b rules of Warehouse › Counts, pure: the schedule's due state in words and tone, its scope in parts,
 * the Count schedule form (the domain's own check) and why Save or Start waits, the New count's class and freeze, and the
 * places a count blocks. Words are keys of `warehouse-lots-counts` (`cd.*`).
 */

export const DEPTH_NAMESPACE = 'warehouse-lots-counts'
export const ABC_CHOICES: readonly AbcClass[] = ['A', 'B', 'C']

export const DUE_TONE: Readonly<Record<DueState, Tone>> = Object.freeze({ OVERDUE: 'danger', DUE_TODAY: 'warning', DUE_SOON: 'info', LATER: 'neutral', RETIRED: 'neutral' })

/** The due words of a schedule: "Overdue 3 days", "Due today", "Due this week", "Later", "Retired". */
export const dueWords = (schedule: Pick<Schedule, 'due' | 'overdueDays'>): Phrase => (schedule.due === 'OVERDUE' ? { key: 'cd.due.OVERDUE', params: { count: schedule.overdueDays } } : { key: `cd.due.${schedule.due}` })

/** The scope in parts (location, class, kind), each a key and its words' params. */
export function scopeParts(scope: Pick<Schedule, 'location' | 'abcClass' | 'itemKind'>): Phrase[] {
  const parts: Phrase[] = []
  if (scope.location) parts.push({ key: 'cd.scope.location', params: { code: scope.location.code, name: scope.location.name } })
  if (scope.abcClass) parts.push({ key: 'cd.scope.class', params: { abc: scope.abcClass } })
  if (scope.itemKind) parts.push({ key: `cd.scope.kind.${scope.itemKind}` })
  return parts
}

/** Who may plan schedules and start their counts (inventory.counts.manage), and see the places (inventory.locations.view). */
export const mayPlan = (can: Pick<CountsCan, 'manage'>): boolean => can.manage

/** Why "Start count" of a schedule waits: no right, a count of it is open already (its task), retired, busy. */
export function startHeld(schedule: Pick<Schedule, 'active' | 'openTaskId'>, can: Pick<CountsCan, 'manage'>, busy: boolean): Phrase | null {
  if (!can.manage) return { key: 'cd.held.noManage' }
  if (!schedule.active) return { key: 'cd.held.retired' }
  if (busy) return { key: 'cd.held.busy' }
  return null
}

// ---- the Count schedule form (cn-schedule) ----------------------------------------------------------------------------------

export interface ScheduleDraft {
  /** null: a new schedule. */
  id: string | null
  version: number
  siteId: string | null
  name: string
  locationId: string | null
  abcClass: AbcClass | null
  itemKind: CountItemKind | null
  everyDays: string
  nextDueOn: string
  note: string
}

export const blankSchedule = (siteId: string | null, today: string): ScheduleDraft => ({ id: null, version: 0, siteId, name: '', locationId: null, abcClass: null, itemKind: null, everyDays: '30', nextDueOn: today, note: '' })

export const draftOfSchedule = (schedule: Schedule): ScheduleDraft => ({
  id: schedule.id,
  version: schedule.version,
  siteId: schedule.siteId,
  name: schedule.name,
  locationId: schedule.location?.id ?? null,
  abcClass: schedule.abcClass,
  itemKind: schedule.itemKind,
  everyDays: String(schedule.everyDays),
  nextDueOn: schedule.nextDueOn,
  note: schedule.note ?? '',
})

const everyOf = (text: string): number => (/^\s*\d{1,3}\s*$/.test(text) ? Number(text.trim()) : Number.NaN)

/** The form's problems by field (the domain's scheduleProblems: a name, something to count, every 1–366 days, a day). */
export function scheduleFormProblems(draft: ScheduleDraft): Partial<Record<'site' | 'name' | 'scope' | 'everyDays' | 'nextDueOn' | 'note', Phrase>> {
  const out: Partial<Record<'site' | 'name' | 'scope' | 'everyDays' | 'nextDueOn' | 'note', Phrase>> = {}
  if (!draft.siteId) out.site = { key: 'cd.form.problem.site' }
  for (const issue of scheduleProblems({ name: draft.name, locationId: draft.locationId, abcClass: draft.abcClass, itemKind: draft.itemKind, everyDays: everyOf(draft.everyDays), nextDueOn: draft.nextDueOn || null })) {
    const field = issue.path === 'body/name' ? 'name' : issue.path === 'body/everyDays' ? 'everyDays' : issue.path === 'body/nextDueOn' ? 'nextDueOn' : 'scope'
    out[field] ??= { key: `cd.form.problem.${field}`, params: { min: SCHEDULE_LIMITS.minDays, max: SCHEDULE_LIMITS.maxDays } }
  }
  if (draft.note.length > SCHEDULE_LIMITS.note) out.note = { key: 'cd.form.problem.note', params: { max: SCHEDULE_LIMITS.note } }
  return out
}

export function scheduleSaveHeld(draft: ScheduleDraft, can: Pick<CountsCan, 'manage'>, busy: boolean): Phrase | null {
  if (!can.manage) return { key: 'cd.held.noManage' }
  if (busy) return { key: 'cd.held.busy' }
  return Object.values(scheduleFormProblems(draft))[0] ?? null
}

export const scheduleBodyOf = (draft: ScheduleDraft): ScheduleBody => ({
  siteId: draft.siteId!,
  name: draft.name.trim(),
  locationId: draft.locationId,
  abcClass: draft.abcClass,
  itemKind: draft.itemKind,
  everyDays: everyOf(draft.everyDays),
  ...(draft.nextDueOn ? { nextDueOn: draft.nextDueOn } : {}),
  note: draft.note.trim() || null,
})

export const scheduleChangeOf = (draft: ScheduleDraft): ScheduleChange => {
  const { siteId: _site, ...rest } = scheduleBodyOf(draft)
  return { ...rest, version: draft.version }
}

/** A refused schedule write in our words (a place of another site, a transit place, a changed schedule, no right). */
export function scheduleProblem(error: unknown): Phrase {
  if (!isApiError(error)) return { key: 'cd.form.failed' }
  const paths = error.issues.map(issuePath)
  if (paths.some((path) => path.includes('locationId'))) return { key: 'cd.form.problem.place' }
  if (paths.some((path) => path.includes('everyDays'))) return { key: 'cd.form.problem.everyDays', params: { min: SCHEDULE_LIMITS.minDays, max: SCHEDULE_LIMITS.maxDays } }
  if (error.kind === 'conflict') return { key: 'cd.form.changed' }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'cd.held.noManage' }
  if (error.kind === 'unavailable') return { key: 'cd.form.offline' }
  return { key: 'cd.form.failed' }
}

/** A refused Start count in our words: a count of it is open, a place is blocked, nothing to count, no right. */
export function startProblem(error: unknown, name: string): Phrase {
  if (!isApiError(error)) return { key: 'cd.start.failed', params: { name } }
  if (error.kind === 'conflict') return { key: 'cd.start.conflict', params: { name } }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'cd.held.noManage' }
  if (error.kind === 'invalid') return { key: 'cd.start.invalid', params: { name } }
  if (error.kind === 'unavailable') return { key: 'cd.form.offline' }
  return { key: 'cd.start.failed', params: { name } }
}

// ---- New count: the class and the freeze (cn-new W2b) -------------------------------------------------------------------------

/** A class count starts at once, is a cycle count and names no single material or lot (B-W2b-299's rule). */
export const classCount = (draft: { abcClass?: AbcClass | null }): boolean => !!draft.abcClass

// ---- the places a count blocks (conn "Locations (blocked during a count)") -------------------------------------------------------

export const placesOfCount = (places: readonly BlockedPlace[] | null, number: string): BlockedPlace[] => (places ?? []).filter((place) => place.block?.reason === 'COUNT' && place.block.holds && place.block.countNumber === number)
export const countBlocked = (places: readonly BlockedPlace[] | null): number => (places ?? []).filter((place) => place.block?.reason === 'COUNT' && place.block.holds).length
