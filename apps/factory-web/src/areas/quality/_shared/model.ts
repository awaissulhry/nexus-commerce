import { isApiError, issuePath } from '../../../lib/api/errors'

/**
 * The parts every quality screen of this step shares (B-W1-34/43/45 part 2: Inspections SCR-075, the inspection and
 * release SCR-076, the evidence trail, Tests & substances SCR-054, the PPE register SCR-113): read states, the live
 * state, notices, the permissions each screen asks for, and an API error turned into this app's words. Pure: no React,
 * no API client.
 */

/** The live stream's state in words: connecting, live, offline (the screen keeps its last copy with its time). */
export type LiveState = 'connecting' | 'live' | 'offline'

/** One read: `value` null and `problem` null = still reading; `problem` = a message key of the failure. */
export interface Read<T> {
  readonly value: T | null
  readonly problem: string | null
}

export const reading = <T>(): Read<T> => ({ value: null, problem: null })
export const ready = <T>(value: T): Read<T> => ({ value, problem: null })
export const failedRead = <T>(problem: string): Read<T> => ({ value: null, problem })

export type Tone = 'success' | 'info' | 'warning' | 'danger'

/** A receipt or a refusal shown above the page's work, in the screen's own catalogue. */
export interface Notice {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly tone: Tone
  /** The API's own words, when they carry facts our words cannot (a gate check's sentence). Shown under the key's. */
  readonly detail?: readonly string[]
}

/** Every permission the quality screens ask about (factory-domain quality/final, quality/lab, compliance/register). */
export const QUALITY_PERMISSIONS = {
  inspectionsView: 'quality.inspections.view',
  inspectionsRecord: 'quality.inspections.record',
  garmentsRelease: 'quality.garments.release',
  garmentsReverse: 'quality.garments.reverse',
  lotsView: 'quality.lots.view',
  lotsTest: 'quality.lots.test',
  lotsDocuments: 'quality.lots.documents',
  lotsRelease: 'quality.lots.release',
  lotsReject: 'quality.lots.reject',
  settingsManage: 'quality.settings.manage',
  registerView: 'compliance.register.view',
  registerManage: 'compliance.register.manage',
  workOrdersView: 'workorders.view',
  partiesView: 'parties.view',
  filesRead: 'files.read',
  filesUpload: 'files.upload',
  // B-W2a-67 (Holds SCR-078, Defects & dispositions SCR-079, Inspections every day): holds, the library, NCRs, returns.
  holdsView: 'quality.holds.view',
  holdsPlace: 'quality.holds.place',
  holdsRelease: 'quality.holds.release',
  defectsView: 'quality.defects.view',
  defectsManage: 'quality.defects.manage',
  ncrView: 'quality.ncr.view',
  ncrRaise: 'quality.ncr.raise',
  returnsView: 'sales.returns.view',
  returnsInspect: 'sales.returns.inspect',
  stockView: 'inventory.stock.view',
  threadsRead: 'threads.read',
} as const

export type QualityAbility = keyof typeof QUALITY_PERMISSIONS
export type QualityCan = Readonly<Record<QualityAbility, boolean>>

/** What a permission list allows, by the names above. */
export function qualityCan(permissions: readonly string[]): QualityCan {
  const held = new Set(permissions)
  return Object.fromEntries(Object.entries(QUALITY_PERMISSIONS).map(([name, permission]) => [name, held.has(permission)])) as unknown as QualityCan
}

/** The message key (namespace `quality`) for a failed call: the kind decides the words, never the API's English. */
export function problemKey(error: unknown): string {
  if (!isApiError(error)) return 'problem.unavailable'
  switch (error.kind) {
    case 'signed_out':
      return 'problem.signedOut'
    case 'forbidden':
      return 'problem.forbidden'
    case 'step_up':
      return 'problem.stepUp'
    case 'not_found':
      return 'problem.notFound'
    case 'conflict':
      return 'problem.conflict'
    case 'invalid':
      return 'problem.invalid'
    case 'rate_limited':
      return 'problem.rateLimited'
    case 'contract':
      return 'problem.contract'
    case 'unavailable':
      return 'problem.unavailable'
    default:
      return 'problem.internal'
  }
}

/**
 * The API's sentences of a refusal whose issues carry facts in words (a 409 `checks/<CODE>` with the check's sentence,
 * then `checks/<CODE>/fix` with how to fix it): the screen shows its own title and these lines under it. The API's words
 * are English (the domain's); they are data here, like a lot code.
 */
export function refusalLines(error: unknown, prefix: string): { code: string; message: string; fix: string | null }[] {
  if (!isApiError(error)) return []
  const lines: { code: string; message: string; fix: string | null }[] = []
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (!path.startsWith(`${prefix}/`)) continue
    const rest = path.slice(prefix.length + 1)
    if (rest.endsWith('/fix')) {
      const code = rest.slice(0, -4)
      const line = lines.find((entry) => entry.code === code)
      if (line) line.fix = issue.message ?? null
      continue
    }
    lines.push({ code: rest, message: issue.message ?? '', fix: null })
  }
  return lines
}

/** Whether an API error names this issue path (`maker`, `stepUp`, `overrideReason` …). */
export function hasIssue(error: unknown, path: string): boolean {
  return isApiError(error) && error.issues.some((issue) => issuePath(issue).split('.')[0] === path)
}

/** "—" for an unknown value (never 0, never empty). */
export const UNKNOWN = '—'

/** A count shown in words or "—" when unknown (a tile that could not count says so, never 0). */
export function countText(count: number | null | undefined): string {
  return count === null || count === undefined ? UNKNOWN : String(count)
}

/** The company-free address with the company's prefix. */
export const withPrefix = (prefix: string, address: string): string => `${prefix}${address}`

/** The evidence trail's address for a batch or a serial (a new tab: design compliance.techfiles#evidence-trail). */
export function evidenceAddress(prefix: string, subject: { batch?: string | null; serial?: string | null }): string | null {
  if (subject.serial) return `${prefix}/compliance/evidence/serial/${encodeURIComponent(subject.serial)}`
  if (subject.batch) return `${prefix}/compliance/evidence/batch/${encodeURIComponent(subject.batch)}`
  return null
}

/**
 * B-W2a-67: the ONE create flow of a nonconformance in the Office is B-W2a-68's New NCR, prefilled from its source record
 * (`/quality/ncr?new=1&from=<Type>&id=<id>`, Type = the API record type). Every "Create NCR" / "Decide in NCR" of
 * Inspections and Holds opens it; there is no second dialog.
 */
export const newNcrAddress = (prefix: string, from: 'Inspection' | 'QualityHold', id: string): string =>
  `${prefix}/quality/ncr?new=1&from=${from}&id=${encodeURIComponent(id)}`
