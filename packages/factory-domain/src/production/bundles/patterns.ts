/**
 * Scan-pattern checks (B-W2b-41; MES-075 "ticket hoarding and late-scan detection"; design production.bundles
 * "Scan-pattern checks", "Show who (one finding)"), pure. Statuto dei Lavoratori (L. 300/1970) art. 4: these are
 * patterns ABOUT BUNDLES to talk about, never a score or a ranking of workers. The detection never groups by a person:
 * it groups by the place a scan came from (the station, else the tablet), and a finding names a bundle, an operation, a
 * window and counts. Who scanned is read only for ONE finding, with a stated reason and an audit row (the API's "Show
 * who"), and only where the site names workers with its legal basis on record and its PERFORMANCE purpose on.
 *
 *   BUNCHED_AT_SHIFT_END  at one station, at least `bunchedMinScans` reports in the window around a shift's end
 *                         (`shiftEndMinutes` before to `shiftEndMinutes` after): tickets kept and scanned together late.
 *                         One finding per bundle and operation reported in that burst.
 *   MOVED_NOT_SCANNED     the bundle has a standing report at an operation while an earlier scanned operation has none:
 *                         it moved on without being scanned there. One finding per bundle and missing operation.
 *   GAP_BELOW_STANDARD    at one station, a report came sooner after the station's previous report than
 *                         `gapRatio` × the operation's standard minutes × the bundle's garments (and the work is long
 *                         enough to judge: at least `minExpectedMinutes`); a gap of `maxGapHours` or more is a new
 *                         start, never compared. One finding per bundle and operation and window.
 *
 * Only REPORT scans no later scan voided are read (an undone or corrected report is not work done then). The job runs
 * over a look-back window and writes only findings it has not written before (`findingKey`).
 */

export const SCAN_PATTERN_KINDS = ['BUNCHED_AT_SHIFT_END', 'MOVED_NOT_SCANNED', 'GAP_BELOW_STANDARD'] as const
export type ScanPatternKind = (typeof SCAN_PATTERN_KINDS)[number]

export const FINDING_STATUSES = ['OPEN', 'REVIEWED', 'DISMISSED'] as const
export type FindingStatus = (typeof FINDING_STATUSES)[number]

/** The checks' numbers (fixed for now: no site setting holds them; a schema need if a site wants its own). */
export const PATTERN_RULES = Object.freeze({
  shiftEndMinutes: 15,
  bunchedMinScans: 5,
  gapRatio: 0.5,
  minExpectedMinutes: 5,
  maxGapHours: 4,
  /** How far back one run of the job looks. */
  lookbackHours: 26,
  /** The panel's counts: the last 7 days. */
  summaryDays: 7,
})
export type PatternRules = typeof PATTERN_RULES

export interface PatternScan {
  readonly id: string
  readonly bundleId: string
  readonly workOrderId: string
  readonly operationId: string
  /** The place it came from: the station, else the tablet (never the worker). */
  readonly placeKey: string
  /** The line of its station, or null. */
  readonly lineId: string | null
  readonly at: Date
  /** Garments it counted (good + scrap + rework). */
  readonly pieces: number
}

export interface PatternOperation {
  readonly id: string
  readonly seq: number
  readonly scanRequired: boolean
  /** Standard minutes per garment (WorkOrderOperation.standardMinutes). */
  readonly standardMinutes: number
}

export interface FoundPattern {
  readonly kind: ScanPatternKind
  readonly workOrderId: string
  readonly bundleId: string
  readonly operationId: string | null
  readonly windowStart: Date
  readonly windowEnd: Date
  /** Counts and times only: never a worker, never a station (a station can stand for one person). */
  readonly detail: Readonly<Record<string, number | string | null>>
}

const MINUTE = 60_000
const round1 = (value: number) => Math.round(value * 10) / 10

/** The key that keeps the job from writing a finding twice: kind, bundle, operation and (but for MOVED) the window's start. */
export function findingKey(finding: Pick<FoundPattern, 'kind' | 'bundleId' | 'operationId' | 'windowStart'>): string {
  const base = `${finding.kind}|${finding.bundleId}|${finding.operationId ?? '-'}`
  return finding.kind === 'MOVED_NOT_SCANNED' ? base : `${base}|${finding.windowStart.toISOString()}`
}

const byPlace = (scans: readonly PatternScan[]): Map<string, PatternScan[]> => {
  const groups = new Map<string, PatternScan[]>()
  for (const scan of scans) groups.set(scan.placeKey, [...(groups.get(scan.placeKey) ?? []), scan])
  for (const group of groups.values()) group.sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : 1))
  return groups
}

/** Reports bunched around the end of a shift at one place. `shiftEnds`: the ends of the shifts that are over (with their window). */
export function bunchedAtShiftEnd(scans: readonly PatternScan[], shiftEnds: readonly Date[], rules: PatternRules = PATTERN_RULES): FoundPattern[] {
  const found: FoundPattern[] = []
  for (const end of shiftEnds) {
    const windowStart = new Date(end.getTime() - rules.shiftEndMinutes * MINUTE)
    const windowEnd = new Date(end.getTime() + rules.shiftEndMinutes * MINUTE)
    const inside = scans.filter((scan) => scan.at >= windowStart && scan.at <= windowEnd)
    for (const group of byPlace(inside).values()) {
      if (group.length < rules.bunchedMinScans) continue
      const seen = new Set<string>()
      for (const scan of group) {
        const key = `${scan.bundleId}|${scan.operationId}`
        if (seen.has(key)) continue
        seen.add(key)
        found.push({
          kind: 'BUNCHED_AT_SHIFT_END',
          workOrderId: scan.workOrderId,
          bundleId: scan.bundleId,
          operationId: scan.operationId,
          windowStart,
          windowEnd,
          detail: { shiftEnd: end.toISOString(), windowMinutes: rules.shiftEndMinutes * 2, scansInTheBurst: group.length, scansOfThisBundle: group.filter((other) => other.bundleId === scan.bundleId && other.operationId === scan.operationId).length, lineId: scan.lineId },
        })
      }
    }
  }
  return found
}

/**
 * Bundles that moved on without a scan: a standing report at an operation while an earlier scanned operation has none.
 * `standing`: per bundle, its standing reports (operation and when).
 */
export function movedNotScanned(
  bundles: readonly { readonly bundleId: string; readonly workOrderId: string; readonly createdAt: Date; readonly standing: readonly { readonly operationId: string; readonly at: Date; readonly lineId: string | null }[] }[],
  operationsOf: (workOrderId: string) => readonly PatternOperation[],
): FoundPattern[] {
  const found: FoundPattern[] = []
  for (const bundle of bundles) {
    const route = [...operationsOf(bundle.workOrderId)].filter((operation) => operation.scanRequired).sort((a, b) => a.seq - b.seq)
    const at = new Map(bundle.standing.map((report) => [report.operationId, report]))
    for (const [index, operation] of route.entries()) {
      if (at.has(operation.id)) continue
      const later = route.slice(index + 1).flatMap((other) => (at.has(other.id) ? [{ operation: other, report: at.get(other.id)! }] : []))
      if (later.length === 0) continue
      const reached = later.reduce((first, entry) => (entry.report.at < first.report.at ? entry : first))
      const before = route.slice(0, index).flatMap((other) => (at.has(other.id) ? [at.get(other.id)!.at] : []))
      const start = before.length > 0 ? new Date(Math.max(...before.map((value) => value.getTime()))) : bundle.createdAt
      const windowStart = start < reached.report.at ? start : new Date(reached.report.at.getTime() - MINUTE)
      found.push({
        kind: 'MOVED_NOT_SCANNED',
        workOrderId: bundle.workOrderId,
        bundleId: bundle.bundleId,
        operationId: operation.id,
        windowStart,
        windowEnd: reached.report.at,
        detail: { missingSeq: operation.seq, reachedSeq: reached.operation.seq, lineId: reached.report.lineId },
      })
    }
  }
  return found
}

/** Reports at one place closer together than the work's standard minutes allow. `quantityOf`: the bundle's garments. */
export function gapBelowStandard(scans: readonly PatternScan[], operationOf: (operationId: string) => PatternOperation | undefined, quantityOf: (bundleId: string) => number, rules: PatternRules = PATTERN_RULES): FoundPattern[] {
  const found: FoundPattern[] = []
  for (const group of byPlace(scans).values()) {
    for (let index = 1; index < group.length; index++) {
      const previous = group[index - 1]!
      const scan = group[index]!
      const gap = (scan.at.getTime() - previous.at.getTime()) / MINUTE
      if (gap <= 0 || gap >= rules.maxGapHours * 60) continue
      const operation = operationOf(scan.operationId)
      if (!operation) continue
      const pieces = scan.pieces > 0 ? scan.pieces : quantityOf(scan.bundleId)
      const expected = operation.standardMinutes * pieces
      if (expected < rules.minExpectedMinutes || gap >= expected * rules.gapRatio) continue
      found.push({
        kind: 'GAP_BELOW_STANDARD',
        workOrderId: scan.workOrderId,
        bundleId: scan.bundleId,
        operationId: scan.operationId,
        windowStart: previous.at,
        windowEnd: scan.at,
        detail: { gapMinutes: round1(gap), standardMinutes: round1(expected), pieces, ratio: round1(gap / expected), lineId: scan.lineId },
      })
    }
  }
  return found
}

/** Every pattern found, without the ones already written (`known`: findingKey of the stored findings). */
export function newFindings(found: readonly FoundPattern[], known: ReadonlySet<string>): FoundPattern[] {
  const seen = new Set(known)
  const out: FoundPattern[] = []
  for (const finding of found) {
    const key = findingKey(finding)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(finding)
  }
  return out
}

// ---- the panel: counts per line and operation (never people) ---------------------------------------------------------

export interface SummaryFinding {
  readonly kind: ScanPatternKind
  readonly status: FindingStatus
  readonly lineId: string | null
  readonly operationCode: string | null
}

export interface SummaryRow {
  readonly lineId: string | null
  readonly operationCode: string | null
  readonly kind: ScanPatternKind
  readonly open: number
  readonly reviewed: number
  readonly dismissed: number
}

/** The findings counted per line, operation and kind (a count opens the bundles behind it, never the people). */
export function summarise(findings: readonly SummaryFinding[]): SummaryRow[] {
  const rows = new Map<string, { lineId: string | null; operationCode: string | null; kind: ScanPatternKind; open: number; reviewed: number; dismissed: number }>()
  for (const finding of findings) {
    const key = `${finding.lineId ?? '-'}|${finding.operationCode ?? '-'}|${finding.kind}`
    const row = rows.get(key) ?? { lineId: finding.lineId, operationCode: finding.operationCode, kind: finding.kind, open: 0, reviewed: 0, dismissed: 0 }
    if (finding.status === 'OPEN') row.open += 1
    else if (finding.status === 'REVIEWED') row.reviewed += 1
    else row.dismissed += 1
    rows.set(key, row)
  }
  return [...rows.values()].sort((a, b) => b.open - a.open || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || String(a.operationCode).localeCompare(String(b.operationCode)))
}

// ---- review and "Show who" -------------------------------------------------------------------------------------------

/** Why the office opens the scans behind one finding by name (the audit row keeps it). */
export const WHO_PURPOSES = ['TALK_WITH_THE_WORKER', 'WORKER_ASKED', 'PAY_QUERY'] as const
export type WhoPurpose = (typeof WHO_PURPOSES)[number]

/** Why the scans behind a finding may not be shown by name, or null (the API adds the PERFORMANCE gate of the site). */
export function whoRefusal(facts: { readonly scanSubject: 'WORKER' | 'STATION'; readonly basisRecorded: boolean; readonly performanceOpen: boolean }): { readonly code: 'STATION_SITE' | 'NO_BASIS' | 'GATE_CLOSED'; readonly message: string } | null {
  if (facts.scanSubject === 'STATION') return { code: 'STATION_SITE', message: 'Not available: this site records stations, not people.' }
  if (!facts.basisRecorded) return { code: 'NO_BASIS', message: 'Held: this site has no legal basis on record for naming workers (Statuto dei Lavoratori art. 4 c.1). Record it in Production › Settings first.' }
  if (!facts.performanceOpen) {
    return { code: 'GATE_CLOSED', message: "Held: one person's work figures are switched off at this site (purpose PERFORMANCE, Statuto dei Lavoratori art. 4 c.1). People › Settings switches it on with its basis, notice and impact assessment." }
  }
  return null
}

/** Problems with a review: a dismissal says why. */
export function reviewProblems(status: 'REVIEWED' | 'DISMISSED', note: string | null | undefined): string[] {
  if (status === 'DISMISSED' && (note ?? '').trim() === '') return ['Say why the finding is dismissed.']
  return []
}
