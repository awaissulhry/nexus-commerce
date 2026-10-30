import { businessDate } from '@nexus/factory-domain/core/time'
import { compareFingerprints, DRILL_KEYS, drillProblems, drillResultOf, parseFingerprint, type DrillCheck, type Fingerprint } from '@nexus/factory-domain/ops/drills'
import type { Drill, DrillStatus, FingerprintAnswer, SecurityFacts, StatusLine, TwoFactorChange, TwoFactorList, TwoFactorPreview, TwoFactorRole } from './api'

/**
 * Admin › Access › Security & health (SCR-166; design admin.security; B-W2a-36, PLT-045, PLT-214): pure rules of the
 * page. It reads one answer (`GET /admin/security`) and, for a reader with roles.view, the roles' two-factor rules. Its
 * sections, in the design's order: Is everything working? (W0), Sign-in rules (W2a: passwords and lockout fixed and
 * shown, two-factor per role in the list frame), Backups and restore drills (W2a: the proof the data can come back),
 * Protection in place (W0: facts, not settings). Jobs, session lengths, step-up actions, security events and SSO are
 * later waves (one line says so).
 */

/** A read: still loading, done, failed (a message key), or not this person's to read (the section is absent). */
export type Read<T> = { state: 'loading' } | { state: 'ok'; value: T } | { state: 'failed'; problem: string } | { state: 'no-right' }
export const LOADING: Read<never> = { state: 'loading' }

export type Dialog =
  | { kind: 'none' }
  | { kind: 'drill'; form: DrillForm; source: Read<FingerprintAnswer>; busy: boolean; problem: string | null; tried: boolean }
  | { kind: 'twoFactor'; changes: TwoFactorChange[]; requireMfa: boolean; preview: Read<TwoFactorPreview>; busy: boolean; problem: string | null; reason: string }

export const NO_DIALOG: Dialog = { kind: 'none' }

export interface SecurityViewModel {
  prefix: string
  facts: Read<SecurityFacts>
  twoFactor: Read<TwoFactorList>
  /** THIS database's fingerprint as of a time (for a copy restored here); null until asked. */
  fingerprint: Read<FingerprintAnswer> | null
  dialog: Dialog
  notice: { key: string; tone: 'success' | 'warning' | 'danger'; params?: Record<string, string | number> } | null
  /** Rows ticked at first (design fixtures). */
  selected?: readonly string[]
  /** The live stream's state, in words. */
  live?: 'connecting' | 'live' | 'offline'
}

// ---- Is everything working? ------------------------------------------------------------------------------------------

export const STATUS_TONE = { ok: 'success', warning: 'warning', failing: 'danger', needs: 'warning', unknown: 'neutral' } as const

/** The band's one line: never "all working" while a part is not watched; a failing part first. */
export function overallOf(status: readonly StatusLine[]): { key: string; params: Record<string, number> } {
  const failing = status.filter((line) => line.state === 'failing').length
  const attention = status.filter((line) => line.state === 'warning' || line.state === 'needs').length
  const unknown = status.filter((line) => line.state === 'unknown').length
  const ok = status.filter((line) => line.state === 'ok').length
  if (failing > 0) return { key: 'sec.overall.failing', params: { count: failing } }
  if (attention > 0) return { key: 'sec.overall.attention', params: { count: attention } }
  if (unknown > 0) return { key: 'sec.overall.partly', params: { ok, unknown } }
  return { key: 'sec.overall.all', params: { ok } }
}

/** Each part's line in words: a message key with its values (the drill's from the drill's own state). */
export function statusWords(line: StatusLine, drill: DrillStatus): { key: string; params: Record<string, string | number> } {
  switch (line.part) {
    case 'jobs':
      if (line.state === 'failing') return { key: 'sec.status.jobs.failing', params: { count: line.count ?? 0 } }
      if (line.state === 'warning') return { key: 'sec.status.jobs.late', params: { count: line.count ?? 0, minutes: line.minutes ?? 0 } }
      return { key: 'sec.status.jobs.ok', params: { count: line.count ?? 0 } }
    case 'files':
      if (line.state === 'needs') return { key: 'sec.status.files.none', params: {} }
      if (line.state === 'failing') return { key: 'sec.status.files.paused', params: {} }
      if (!line.count) return { key: line.mode === 'LIVE' ? 'sec.status.files.liveClean' : 'sec.status.files.testClean', params: {} }
      return { key: line.mode === 'LIVE' ? 'sec.status.files.live' : 'sec.status.files.test', params: { count: line.count } }
    case 'drill':
      return drillWords(drill)
    default:
      return { key: `sec.status.${line.part}.${line.state}`, params: {} }
  }
}

/** The restore drill's state in words ("82 days ago — due in 8 days"). */
export function drillWords(drill: DrillStatus): { key: string; params: Record<string, string | number> } {
  const days = { ago: drill.daysAgo ?? 0, left: Math.abs(drill.daysLeft ?? 0) }
  switch (drill.state) {
    case 'none':
      return { key: 'sec.drill.state.none', params: {} }
    case 'failed':
      return { key: 'sec.drill.state.failed', params: days }
    case 'overdue':
      return { key: 'sec.drill.state.overdue', params: days }
    case 'due_soon':
      return { key: 'sec.drill.state.dueSoon', params: days }
    default:
      return { key: 'sec.drill.state.ok', params: days }
  }
}

/** Where each status line's detail lives (a page of the Office, or a section of this page). */
export const STATUS_LINKS: Readonly<Partial<Record<StatusLine['part'], string>>> = { files: '/admin/connections', drill: '#backups', backups: '#backups' }

// ---- Sign-in rules: two-factor per role ------------------------------------------------------------------------------

/** Why a row's box is held (a message key), or null when it may be ticked. */
export function rowHeld(role: TwoFactorRole, canChange: boolean): string | null {
  if (!canChange) return 'sec.tf.held.right'
  if (role.heldByMe) return 'sec.tf.held.mine'
  return null
}

/** Whether this role can take the change by its own content (the server weighs the rest: versions, the lock-out rule). */
export const canTake = (role: TwoFactorRole, requireMfa: boolean): boolean =>
  !role.heldByMe && (requireMfa ? !role.requireMfa : role.requireMfa && role.lock === null)

/** The changes of a bulk action over the ticked rows: only the rows that can take it. */
export function changesFor(roles: readonly TwoFactorRole[], selected: readonly string[], requireMfa: boolean): TwoFactorChange[] {
  const ticked = new Set(selected)
  return roles.filter((role) => ticked.has(role.id) && canTake(role, requireMfa)).map((role) => ({ roleId: role.id, version: role.version, requireMfa }))
}

/** A bulk action's held reason over the ticked rows (none of them can take it), or null. */
export function bulkHeld(roles: readonly TwoFactorRole[], selected: readonly string[], requireMfa: boolean): string | null {
  return changesFor(roles, selected, requireMfa).length > 0 ? null : requireMfa ? 'sec.tf.bulk.held.ask' : 'sec.tf.bulk.held.stop'
}

/** Holders without two-factor (asked at their next sign-in while the role asks for it). */
export const withoutTwoFactor = (role: TwoFactorRole) => role.holders.filter((holder) => !holder.twoFactor)

/** A refusal of a change in words: its code's message key, and the role it is about (by the change's index). */
export function refusalWords(preview: TwoFactorPreview, changes: readonly TwoFactorChange[], roles: readonly TwoFactorRole[]): Array<{ key: string; role: string | null }> {
  return preview.refusals.map((refusal) => {
    const index = /^changes\/(\d+)$/.exec(refusal.path)?.[1]
    const change = index === undefined ? undefined : changes[Number(index)]
    return { key: `sec.tf.refusal.${refusal.code}`, role: change ? (roles.find((role) => role.id === change.roleId)?.name ?? null) : null }
  })
}

// ---- Backups and restore drills --------------------------------------------------------------------------------------

export interface DrillForm {
  drilledOn: string
  environment: string
  /** ISO instant of the backup restored. */
  backupAt: string
  /** The restored copy's fingerprint line, pasted. */
  restored: string
  durationMinutes: string
  notes: string
  evidence: { name: string; size: number } | null
}

export const emptyDrillForm = (now: Date): DrillForm => ({ drilledOn: businessDate(now), environment: '', backupAt: '', restored: '', durationMinutes: '', notes: '', evidence: null })

/** What is wrong with the form (field → message key), from factory-domain's own rules. */
export function drillFormErrors(form: DrillForm, now: Date): Partial<Record<keyof DrillForm, string>> {
  const errors: Partial<Record<keyof DrillForm, string>> = {}
  if (form.environment.trim() === '') errors.environment = 'sec.drill.error.environment'
  if (form.backupAt === '') errors.backupAt = 'sec.drill.error.backupAt'
  if (form.restored.trim() === '') errors.restored = 'sec.drill.error.restoredEmpty'
  else if (parseFingerprint(form.restored).issues.length > 0) errors.restored = 'sec.drill.error.restored'
  if (form.durationMinutes !== '' && !/^\d{1,5}$/.test(form.durationMinutes)) errors.durationMinutes = 'sec.drill.error.duration'
  if (form.backupAt !== '' && form.environment.trim() !== '') {
    const duration = form.durationMinutes === '' || !/^\d{1,5}$/.test(form.durationMinutes) ? null : Number(form.durationMinutes)
    for (const issue of drillProblems({ drilledOn: form.drilledOn, environment: form.environment, backupAt: new Date(form.backupAt), durationMinutes: duration, notes: form.notes }, now)) {
      const field = issue.path as keyof DrillForm
      if (errors[field]) continue
      errors[field] =
        field === 'environment' ? 'sec.drill.error.production' : field === 'drilledOn' ? 'sec.drill.error.future' : field === 'backupAt' ? 'sec.drill.error.backupLater' : field === 'notes' ? 'sec.drill.error.notes' : 'sec.drill.error.duration'
    }
  }
  return errors
}

/** The comparison the dialog shows before saving: this database's fingerprint at the backup's time beside the pasted one. */
export function drillPreview(form: DrillForm, source: FingerprintAnswer | null): { checks: DrillCheck[]; result: 'PASSED' | 'FAILED' } | null {
  const restored = parseFingerprint(form.restored).fingerprint
  if (!restored || !source) return null
  const checks = compareFingerprints(source.fingerprint as Fingerprint, restored)
  return { checks, result: drillResultOf(checks) }
}

/** A drill's checks matched out of how many ("5 of 5 matched"). */
export const matchedOf = (drill: Pick<Drill, 'checks'>) => ({ matched: drill.checks.filter((check) => check.match).length, of: drill.checks.length })

/** The words of a key a drill compared (older drills may name keys of their own: drawn as they are). */
export const keyWord = (key: string): string => ((DRILL_KEYS as readonly string[]).includes(key) ? `sec.drill.key.${key}` : key)

/** A checksum in groups of four, easier to compare by eye. */
export const grouped = (checksum: string | null): string => (checksum ? (checksum.match(/.{1,4}/g) ?? [checksum]).join(' ') : '—')

// ---- the page's abilities ------------------------------------------------------------------------------------------

export function securityCan(held: ReadonlySet<string>) {
  return {
    view: held.has('security.view'),
    record: held.has('security.drills.record'),
    roles: held.has('roles.view'),
    changeRoles: held.has('roles.manage'),
  }
}
