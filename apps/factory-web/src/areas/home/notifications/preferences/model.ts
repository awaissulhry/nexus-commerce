import { z } from 'zod'
import { CADENCES, EVENT_KINDS, PREFERENCE_CHANNELS, PREFERENCE_SOURCES, type Cadence, type EventKind, type PreferenceChannel } from '@nexus/factory-domain/notifications/preferences/preferences'

/**
 * Home › Notifications › Notification preferences (B-W2b-388; design home.notifications popup preferences, W2b; PLT-141): the
 * matrix — event (Mentioned · Assigned · Approval waiting · Approval decided · Record I follow changed · Alert on my area · Mail
 * assigned) × channel (In app · E-mail · Push) × cadence (Instant · Daily digest · Off) — "Role defaults shown with
 * SourceIndicator ('Default for Planner'). Quiet defaults on.", "Each cell saves at once (CellSaveMark); 'Reset to my role's
 * defaults'". On B-W2b-385's routes: GET/PUT/DELETE /notifications/preferences; an admin (mayManageDefaults) sets the office
 * roles' defaults (GET/PUT /notifications/role-defaults). Words from the codes only.
 */

const event = z.enum(EVENT_KINDS)
const channel = z.enum(PREFERENCE_CHANNELS)
const cadence = z.enum(CADENCES)

export const matrixSchema = z.object({
  asOf: z.string(),
  events: z.array(event),
  channels: z.array(channel),
  cells: z.array(
    z.object({
      event,
      channel,
      cadence,
      source: z.enum(PREFERENCE_SOURCES),
      role: z.object({ id: z.string(), name: z.string() }).nullable(),
      quiet: cadence,
      choices: z.array(cadence),
    }),
  ),
  roles: z.array(z.object({ id: z.string(), name: z.string() })),
  digestOn: z.boolean(),
  pushDevices: z.number().int(),
  mayManageDefaults: z.boolean(),
})
export type Matrix = z.infer<typeof matrixSchema>
export type MatrixCell = Matrix['cells'][number]

export const roleDefaultsSchema = z.object({
  roles: z.array(z.object({ id: z.string(), name: z.string(), key: z.string(), system: z.boolean() })),
  roleId: z.string().nullable(),
  cells: z.array(z.object({ event, channel, cadence: cadence.nullable(), quiet: cadence, choices: z.array(cadence), changedAt: z.string().nullable() })),
})
export type RoleDefaults = z.infer<typeof roleDefaultsSchema>

export type Loaded<T> = { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly data: T }

/** A cell's save state as the DS CellSaveMark draws it (saving · waiting · unknown), or failed with why (a message key). */
export type CellSave = { readonly state: 'saving' } | { readonly state: 'failed'; readonly problem: string }

export interface PreferencesModel {
  readonly matrix: Loaded<Matrix>
  /** The cells being saved or refused, by `event:channel`. */
  readonly saving: Readonly<Record<string, CellSave>>
  /** Admins: the office roles' defaults (null: not open, or not an admin). */
  readonly defaults: Loaded<RoleDefaults> | null
  readonly defaultsSaving: Readonly<Record<string, CellSave>>
  /** Why changing is held (offline, a reset in flight): a message key of `home-mywork`, or null. */
  readonly held: string | null
  readonly notice: { readonly key: string; readonly tone: 'success' | 'warning' | 'danger' } | null
}

export const cellKey = (event: EventKind, channel: PreferenceChannel): string => `${event}:${channel}`

/** The cell of a matrix. */
export function cellOf<C extends { readonly event: EventKind; readonly channel: PreferenceChannel }>(cells: readonly C[], event: EventKind, channel: PreferenceChannel): C | undefined {
  return cells.find((cell) => cell.event === event && cell.channel === channel)
}

/** A cell's source as the DS SourceIndicator draws it: mine (override), my role's default (rule), the quiet default. */
export const SOURCE_KIND = { PERSON: 'override', ROLE: 'rule', QUIET: 'default' } as const

/** The e-mail column chose a daily digest while the digest is off: the screen says the digest must be on to send it. */
export const digestWaits = (matrix: Pick<Matrix, 'cells' | 'digestOn'>): boolean => !matrix.digestOn && matrix.cells.some((cell) => cell.channel === 'EMAIL' && cell.cadence === 'DAILY_DIGEST')

/** The push column brings something but no device has push on: the screen offers "Push on this device". */
export const pushWaits = (matrix: Pick<Matrix, 'cells' | 'pushDevices'>): boolean => matrix.pushDevices === 0 && matrix.cells.some((cell) => cell.channel === 'PUSH' && cell.cadence === 'INSTANT')

/** The next cell for the arrow keys in the matrix (rows = events, columns = channels), or null at an edge. */
export function nextCell(events: readonly EventKind[], channels: readonly PreferenceChannel[], at: { readonly event: EventKind; readonly channel: PreferenceChannel }, key: string): { readonly event: EventKind; readonly channel: PreferenceChannel } | null {
  const row = events.indexOf(at.event)
  const column = channels.indexOf(at.channel)
  const move = key === 'ArrowDown' ? [1, 0] : key === 'ArrowUp' ? [-1, 0] : key === 'ArrowRight' ? [0, 1] : key === 'ArrowLeft' ? [0, -1] : null
  if (!move || row < 0 || column < 0) return null
  const event = events[row + move[0]!]
  const channelAt = channels[column + move[1]!]
  return event && channelAt ? { event, channel: channelAt } : null
}

/** A role default's choice in the select: a cadence, or none (its holders get the quiet default). */
export const NO_DEFAULT = 'NONE'
export type RoleChoice = Cadence | typeof NO_DEFAULT
