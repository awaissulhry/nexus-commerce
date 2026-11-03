import { depthRefusal, type DepthRefusal } from './refusals'

/**
 * The unsafe-machine lock and who may set and lift it (B-W2b-96; QHS-183; D.Lgs. 81/2008 art. 71; Owner answer H1; design
 * plant.requests "Lock as unsafe", plant.settings "Unsafe lock", plant.jobs "Unsafe lock"). Pure.
 *
 *   H1        anyone at the station locks a machine AT ONCE; only a technician signs it safe again. PlantSettings (one row
 *             per site, id = the site's; no row = these defaults) carries the design's other choices — leads and
 *             technicians lock, a safety officer also signs safe — but the database holds both at H1 until the Owner
 *             decides, and so does this rule: a change to another value is refused in words (H1_HELD).
 *   lock      from the office's request detail ("Lock as unsafe"): a NEW unsafe request of the same machine reported by the
 *             office user (a request's own `unsafe` never changes), the machine DO_NOT_USE in the same command; the open
 *             request it came from joins it (merged), so one request carries the lock and every reporter is kept.
 *   hazard    with hazardReportOnLock (the default) a lock asks for a hazard report in Plant › Incidents: the event
 *             maintenance_request.locked says so (`hazardReport`), for the incidents module to open it.
 *   loosen    switching the hazard report off loosens a safety rule: the office's fresh code (step-up), as any loosening.
 */

export const LOCK_BY = ['ANYONE_AT_STATION', 'LEADS_AND_TECHNICIANS'] as const
export type LockBy = (typeof LOCK_BY)[number]
export const SIGN_SAFE_BY = ['TECHNICIANS', 'TECHNICIANS_AND_SAFETY_OFFICER'] as const
export type SignSafeBy = (typeof SIGN_SAFE_BY)[number]

export interface LockSettings {
  readonly lockBy: LockBy
  readonly signSafeBy: SignSafeBy
  readonly hazardReportOnLock: boolean
}

/** Owner answer H1, and the settings of a site without a row. */
export const H1_SETTINGS: LockSettings = Object.freeze({ lockBy: 'ANYONE_AT_STATION', signSafeBy: 'TECHNICIANS', hazardReportOnLock: true })

const H1_FIX = 'Keep anyone at the station locking and only a technician signing safe; the other choices wait for the Owner’s word.'

/** Why a change of the lock settings is refused, or null: only H1's choices are taken (the database holds the same). */
export function lockSettingsRefusal(next: LockSettings): DepthRefusal | null {
  if (next.lockBy !== H1_SETTINGS.lockBy) return depthRefusal('H1_HELD', 'Owner answer H1 holds: anyone at the station locks an unsafe machine at once.', H1_FIX)
  if (next.signSafeBy !== H1_SETTINGS.signSafeBy) return depthRefusal('H1_HELD', 'Owner answer H1 holds: only a technician signs a machine safe again (D.Lgs. 81/2008 art. 71).', H1_FIX)
  return null
}

/** Whether a change loosens a safety rule (it asks the office's fresh code). */
export const loosens = (before: LockSettings, after: LockSettings): boolean =>
  (before.hazardReportOnLock && !after.hazardReportOnLock) || (before.lockBy === 'LEADS_AND_TECHNICIANS' && after.lockBy === 'ANYONE_AT_STATION') || (before.signSafeBy === 'TECHNICIANS' && after.signSafeBy !== 'TECHNICIANS')

/** Who is locking: a line lead (floor.lead) or a technician (plant.jobs.work, or the office's triage). */
export interface Locker {
  readonly lead: boolean
  readonly technician: boolean
}

/** Why this person may not lock a machine under the site's settings, or null (H1: anyone who may report). */
export function lockRefusal(settings: Pick<LockSettings, 'lockBy'>, locker: Locker): DepthRefusal | null {
  if (settings.lockBy === 'ANYONE_AT_STATION' || locker.lead || locker.technician) return null
  return depthRefusal('LOCK_NOT_ALLOWED', 'At this site only line leads and technicians mark a machine unsafe.', 'Call your line lead or a technician; report the problem without marking it unsafe meanwhile.')
}

/** A lock from a request whose machine is locked already: nothing more to lock. */
export function lockedAlready(assetNumber: string): DepthRefusal {
  return depthRefusal('LOCKED_ALREADY', `Machine ${assetNumber} is locked as unsafe already: it stays do-not-use until a technician signs it safe.`, 'Make a job of the request; the technician signs the machine safe when it is.')
}

/** The words of the lock request the office makes ("Lock as unsafe" from a request). */
export function lockDescription(fromWords: string | null, note: string | null): string {
  const parts = ['Locked as unsafe from the office', fromWords ? `after the report "${fromWords}"` : null, note ? `: ${note}` : null].filter((part): part is string => part !== null)
  return `${parts.join(' ')}`.replace(' :', ':').slice(0, 2000)
}
