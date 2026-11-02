import type { ScanRefusal, Viewer } from '../scans/rules'
import type { ScanSubject } from '../settings/monitoring'

/**
 * Scan on behalf and several bundles at once (B-W2b-47; MES-099, MES-100; design floor.supervisor "Scan on behalf",
 * floor.operation "Several bundles at once"). Pure rules; apps/factory-api modules/production/onbehalf applies them.
 *
 * On behalf: the team leader, signed in on their own tablet, picks the station (and the person where the site names
 * workers), scans the bundle, gives the counts and a reason tile. The REPORT names the person (or the station), and the
 * team leader as who entered it (createdById); its `reason` starts with ON_BEHALF_MARK, so every reader of the row can say
 * "entered by the team leader". It goes through the same rules as any report (the checks before it counts, the steps of
 * the operation, a hold): nothing is lifted by being entered by a team leader; a held check needs another team leader's
 * override (four eyes). A person is named only once they acknowledged the notice in force (Statuto art. 4 c.3).
 *
 * Several at once: each bundle is its own REPORT, judged on its own; a refused one stays out and never stops the others.
 * A stack starts no timing: the one-bundle-at-a-time rule of timed work stands (MES-093 stays Later), and a REPORT needs no
 * START (Owner answer F3).
 */

export const ON_BEHALF_REASON_CODES = ['BADGE_MISSING', 'TABLET_DOWN', 'CALLED_AWAY', 'FORGOT_TO_SCAN', 'OTHER'] as const
export type OnBehalfReasonCode = (typeof ON_BEHALF_REASON_CODES)[number]

export interface OnBehalfReason {
  readonly code: OnBehalfReasonCode
  readonly label: { readonly it: string; readonly en: string }
  readonly needsNote: boolean
}

/** The reason tiles, fixed for now: the reason lists have no list for them (a schema need of the step's notes). */
export const ON_BEHALF_REASONS: readonly OnBehalfReason[] = Object.freeze([
  { code: 'BADGE_MISSING', label: { it: 'Senza badge', en: 'No badge with them' }, needsNote: false },
  { code: 'TABLET_DOWN', label: { it: 'Tablet fuori uso', en: 'The tablet was not working' }, needsNote: false },
  { code: 'CALLED_AWAY', label: { it: 'Chiamato altrove', en: 'Called away before scanning' }, needsNote: false },
  { code: 'FORGOT_TO_SCAN', label: { it: 'Dimenticato di scansionare', en: 'Forgot to scan' }, needsNote: false },
  { code: 'OTHER', label: { it: 'Altro (scrivi perché)', en: 'Other (say why)' }, needsNote: true },
])

/** How the scan's `reason` starts: the mark on the record. */
export const ON_BEHALF_MARK = 'Entered by the team leader'

/** The scan's `reason`: the mark, the tile's English words, and the note when there is one. */
export function onBehalfReasonText(code: OnBehalfReasonCode, note: string | null): string {
  const tile = ON_BEHALF_REASONS.find((reason) => reason.code === code)!
  return `${ON_BEHALF_MARK}: ${tile.label.en}${note ? ` (${note})` : ''}`
}

export const isOnBehalfEntry = (reason: string | null): boolean => reason?.startsWith(`${ON_BEHALF_MARK}:`) ?? false

export interface OnBehalfFacts {
  readonly scanSubject: ScanSubject
  /** The team leader signed in. */
  readonly leadId: string
  /** The person picked; none where the site records the station. */
  readonly workerId: string | null
  /** The person is an ACTIVE worker of the device's site. */
  readonly personHere: boolean
  /** The person acknowledged the notice in force. */
  readonly acknowledged: boolean
  /** The station picked is an ACTIVE station of the device's site. */
  readonly stationHere: boolean
  readonly reasonCode: OnBehalfReasonCode
  readonly note: string | null
}

const refused = (code: ScanRefusal['code'], message: string, fix: string, final = true): ScanRefusal => ({ code, message, fix, final })

/** Why this report cannot be entered on behalf, or null. Words never name the person. */
export function onBehalfRefusal(facts: OnBehalfFacts): ScanRefusal | null {
  if (!facts.stationHere) return refused('BEHALF_STATION_UNKNOWN', 'This is not an active station of this site.', 'Pick a station of this site.')
  if (facts.scanSubject === 'STATION') {
    if (facts.workerId !== null) return refused('BEHALF_NAMES_NOBODY', 'This site records the station, not the person.', 'Leave the person out.')
  } else {
    if (facts.workerId === null) return refused('BEHALF_PERSON_NEEDED', 'This site names the person on every report.', 'Pick the person who did the work.')
    if (facts.workerId === facts.leadId) return refused('BEHALF_SELF', 'Your own work is your own scan, not an entry on behalf.', 'Scan the bundle on the operation screen.')
    if (!facts.personHere) return refused('BEHALF_PERSON_UNKNOWN', 'This person is not an active worker of this site.', 'Pick a worker of this site.')
    if (!facts.acknowledged) {
      return refused('BEHALF_NO_NOTICE', 'No record names this person before they acknowledge the information notice in force (L. 300/1970 art. 4 c.3; GDPR art. 13).', 'They read and acknowledge the notice on a tablet; then send it again.', false)
    }
  }
  const tile = ON_BEHALF_REASONS.find((reason) => reason.code === facts.reasonCode)
  if (tile?.needsNote && !facts.note) return refused('BEHALF_NOTE_MISSING', 'With "Other" say why in a few words.', 'Write why, then send it again.')
  return null
}

/**
 * The viewer the undo rules judge a report by: the team leader who may take back an entry on behalf stands in for its
 * person or station (the database's UNDO names them anyway); anyone else stays themself. The rules' other checks stand:
 * the same tablet, the last scan on it, the window, the next operation.
 */
export function undoViewer(viewer: Viewer, target: { readonly reason: string | null; readonly workerId: string | null; readonly stationId: string | null }, mayEnterOnBehalf: boolean): Viewer {
  return mayEnterOnBehalf && isOnBehalfEntry(target.reason) ? { ...viewer, workerId: target.workerId, stationId: target.stationId } : viewer
}

// ---- several bundles at once -----------------------------------------------------------------------------------------------------------

export const SEVERAL_LIMITS = Object.freeze({ maxBundles: 20 })

export interface SeveralTotals {
  readonly finished: number
  readonly refused: number
  readonly good: number
  readonly scrap: number
  readonly rework: number
}

/** The receipt of one Finish over a stack: "3 bundles finished · 60 good · 1 refused". */
export function severalWords(totals: SeveralTotals): string {
  const finished = `${totals.finished} ${totals.finished === 1 ? 'bundle' : 'bundles'} finished · ${totals.good} good`
  const defects = [totals.scrap > 0 ? `${totals.scrap} scrap` : null, totals.rework > 0 ? `${totals.rework} rework` : null].filter((part) => part !== null)
  return [finished, ...defects, ...(totals.refused > 0 ? [`${totals.refused} refused`] : [])].join(' · ')
}
