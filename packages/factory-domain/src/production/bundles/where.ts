/**
 * Where is this bundle, and is it stuck (B-W2b-41; MES-074, MES-168; design production.bundles "Bundles" place now,
 * the bundle record's Progress, production.floor "Stuck bundles"), pure. The API reads the facts as the caller (the
 * bundle, its work order's operations, its scans, holds, open rework and subcontract sends) and asks here.
 *
 *   place   VOID           the bundle was voided.
 *           SUBCONTRACTOR  it went out to a workshop with a subcontract order and has not come back.
 *           QUALITY        it, or its work order, is on hold, or it travels in an open rework.
 *           FINISHED       every scanned operation has a standing report (its garments passed them all).
 *           CUTTING        made at the cutting table, no operation reported yet (waiting for the first one).
 *           LINE           on the line: the last operation it was reported at (with the station) and the next one.
 *           ("rack": no WIP location is recorded for a bundle, a schema need named in the notes.)
 *   stuck   an ACTIVE bundle at CUTTING or on the LINE with no scan for longer than the site's limit
 *           (ProductionSettings.stuckBundleHours, default 4), counted in WORKING minutes of the site's calendar since
 *           its last scan (else since it was made), so a weekend or a night shift that does not run stops no clock.
 *           A bundle on hold, in rework, at a subcontractor or finished is never "stuck": a hold, a rework and a
 *           subcontract order each have their own list and deadline.
 */

export const BUNDLE_PLACES = ['CUTTING', 'LINE', 'SUBCONTRACTOR', 'QUALITY', 'FINISHED', 'VOID'] as const
export type BundlePlace = (typeof BUNDLE_PLACES)[number]

/** Why a bundle is at QUALITY. */
export const QUALITY_REASONS = ['HOLD', 'REWORK'] as const
export type QualityReason = (typeof QUALITY_REASONS)[number]

/** The default of ProductionSettings.stuckBundleHours, and its range (the database keeps it). */
export const DEFAULT_STUCK_BUNDLE_HOURS = 4
export const MIN_STUCK_BUNDLE_HOURS = 1
export const MAX_STUCK_BUNDLE_HOURS = 720

export interface PlaceOperation {
  readonly id: string
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly scanRequired: boolean
}

export interface PlaceFacts {
  readonly status: 'ACTIVE' | 'VOID'
  readonly createdAt: Date
  /** The work order's operations (any order). */
  readonly operations: readonly PlaceOperation[]
  /** The operations it has a standing report at (a REPORT or CORRECTION no later scan voids). */
  readonly standing: ReadonlySet<string>
  /** Its newest scan of any kind: when, at which operation, at which station. */
  readonly lastScan: { readonly at: Date; readonly operationId: string; readonly stationId: string | null } | null
  readonly held: boolean
  readonly inRework: boolean
  /** The open subcontract order it went out with (sent, not come back), or null. */
  readonly subcontract: { readonly orderId: string; readonly number: string } | null
}

export interface PlaceAnswer {
  readonly place: BundlePlace
  readonly qualityReason: QualityReason | null
  /** LINE: the last operation it was reported at; FINISHED: the last scanned operation. */
  readonly operation: PlaceOperation | null
  /** LINE and CUTTING: the next scanned operation without a standing report. */
  readonly next: PlaceOperation | null
  /** Since when it has been where it is: its last scan, else when it was made. */
  readonly since: Date
}

const scanned = (operations: readonly PlaceOperation[]) => [...operations].filter((operation) => operation.scanRequired).sort((a, b) => a.seq - b.seq)

/** Where the bundle is now (the grid's "place now", the record's Progress band). */
export function placeOf(facts: PlaceFacts): PlaceAnswer {
  const since = facts.lastScan?.at ?? facts.createdAt
  const route = scanned(facts.operations)
  const next = route.find((operation) => !facts.standing.has(operation.id)) ?? null
  const reported = route.filter((operation) => facts.standing.has(operation.id))
  const last = facts.lastScan ? (facts.operations.find((operation) => operation.id === facts.lastScan!.operationId) ?? null) : null
  const base = { since, operation: null, next: null, qualityReason: null }
  if (facts.status === 'VOID') return { ...base, place: 'VOID' }
  if (facts.subcontract) return { ...base, place: 'SUBCONTRACTOR', next }
  if (facts.held || facts.inRework) return { ...base, place: 'QUALITY', qualityReason: facts.held ? 'HOLD' : 'REWORK', operation: last, next }
  if (route.length > 0 && next === null) return { ...base, place: 'FINISHED', operation: route.at(-1) ?? null }
  if (reported.length === 0) return { ...base, place: 'CUTTING', next }
  return { ...base, place: 'LINE', operation: last ?? reported.at(-1) ?? null, next }
}

/** Whether a place can be stuck (a hold, a rework, a workshop and the finished bundles have their own lists). */
export const STUCK_PLACES: readonly BundlePlace[] = Object.freeze(['CUTTING', 'LINE'])

export interface StuckAnswer {
  readonly stuck: boolean
  /** Working hours since its last scan (else since it was made), one decimal. */
  readonly hours: number
}

/** Stuck: at CUTTING or on the LINE with at least `limitHours` working hours since its last scan. */
export function stuckOf(place: BundlePlace, workingMinutes: number, limitHours: number): StuckAnswer {
  const hours = Math.round((Math.max(0, workingMinutes) / 60) * 10) / 10
  return { stuck: STUCK_PLACES.includes(place) && workingMinutes >= limitHours * 60, hours }
}

/** The site's limit: its setting, else the default. */
export const stuckLimitOf = (settings: { readonly stuckBundleHours: number } | null | undefined): number => settings?.stuckBundleHours ?? DEFAULT_STUCK_BUNDLE_HOURS

/** Problems with a limit an office user asks for (the database refuses the same). */
export function stuckLimitProblems(hours: number): string[] {
  if (!Number.isInteger(hours) || hours < MIN_STUCK_BUNDLE_HOURS || hours > MAX_STUCK_BUNDLE_HOURS) return [`A bundle is stuck after ${MIN_STUCK_BUNDLE_HOURS} to ${MAX_STUCK_BUNDLE_HOURS} working hours with no scan (a whole number).`]
  return []
}

/**
 * One stuck episode's key: the bundle and the scan it waits after (its creation when never scanned). The scheduler tells
 * once per episode (production.bundle_stuck); a new scan starts a new episode.
 */
export const stuckEpisodeKey = (bundleId: string, lastScanId: string | null): string => `bundle-stuck:${bundleId}:${lastScanId ?? 'made'}`
