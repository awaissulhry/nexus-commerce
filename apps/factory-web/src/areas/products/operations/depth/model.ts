import { MAX_REASON, minutesFromAllowances, TIME_SOURCES, type BuiltMinutes, type TimeSource } from '@nexus/factory-domain/product/minutes/rules'
import { sameMinutes } from '@nexus/factory-domain/product/routing/operations'
import type { Notice, WriteProblem } from '../../library/model'
import type { LibrarySettings, MachineClassChoice, OperationMinutesView, Setting, SettingBody, TimeVersionView, WaitingEntry } from './api'

/**
 * The operation library's W2b depth, pure (B-W2b-235; design products.operations › Minutes "Basic time + personal, fatigue
 * and delay allowances", "SMV versions with effective dates and approver", pop:operations.smvChange "Propose SMV change",
 * the tile "SMV changes waiting for approval", Machine & settings, the links to People › Piece rates and Changes & versions):
 * who may do what, the proposal's draft and its checks (factory-domain's own minute rules, so the new SMV shown is the
 * one the API will store), why a typed SMV, a decision or a Send is held, the versions in words and tones, the settings
 * list's draft and checks, and where the connections lead. The hooks and the views use these; the tests hold them.
 */

export { TIME_SOURCES, MAX_REASON }
export type { TimeSource }

/** A part of a record read on its own: like the studio's parts, each loads and fails alone. */
export type Part<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

// ---- who may ----------------------------------------------------------------------------------------------------------------

export interface SmvCan {
  /** product.routing.view: the minutes, versions and the waiting list are read. */
  view: boolean
  /** product.smv.propose. */
  propose: boolean
  /** product.smv.approve (never one's own proposal: the API says per version). */
  approve: boolean
  /** product.operations.manage: the library's machine settings. */
  operationsManage: boolean
  /** people.piecerates.view: the piece rates an SMV change reaches, by row. */
  pieceRates: boolean
  /** plant.view: the machine classes a setting picks from. */
  machineClasses: boolean
}

export function smvCanOf(permissions: readonly string[]): SmvCan {
  const held = new Set(permissions)
  return {
    view: held.has('product.routing.view'),
    propose: held.has('product.smv.propose'),
    approve: held.has('product.smv.approve'),
    operationsManage: held.has('product.operations.manage'),
    pieceRates: held.has('people.piecerates.view'),
    machineClasses: held.has('plant.view'),
  }
}

// ---- typed decimals -----------------------------------------------------------------------------------------------------------

/** "4,25" or "4.25" as a plain decimal ("4.25"); '' → ''. Spaces dropped. */
export const plainOf = (text: string): string => text.trim().replace(/\s/g, '').replace(',', '.')

/** A plain decimal as the person types it in their language ("4.25" → "4,25" in Italian). */
export const typedOf = (value: string | null | undefined, locale: 'it' | 'en'): string => {
  if (value === null || value === undefined) return ''
  const clean = /^-?\d+\.\d*?0+$/.test(value) ? value.replace(/\.?0+$/, '') : value
  return locale === 'it' ? clean.replace('.', ',') : clean
}

// ---- Propose SMV change ---------------------------------------------------------------------------------------------------------

export interface ProposeDraft {
  basic: string
  personal: string
  fatigue: string
  delay: string
  source: TimeSource
  /** YYYY-MM-DD. */
  effectiveFrom: string
  reason: string
  /** Replace the waiting proposal (it becomes superseded with no decision). */
  replace: boolean
}

export type ProposeField = 'basic' | 'personal' | 'fatigue' | 'delay' | 'source' | 'effectiveFrom' | 'reason'

/** The first day a new version may apply from: today, and not before the day of an approved version. */
export function minDayOf(view: Pick<OperationMinutesView, 'today' | 'versions'>): string {
  return view.versions.filter((version) => version.status === 'APPROVED').reduce((day, version) => (version.effectiveFrom > day ? version.effectiveFrom : day), view.today)
}

/** The waiting proposal (one per operation), or null. */
export const pendingOf = (view: Pick<OperationMinutesView, 'versions'>): TimeVersionView | null => view.versions.find((version) => version.status === 'PROPOSED') ?? null

/**
 * The dialog's start: the operation's own basic time and allowances (a typed SMV is the basic time with no allowance), the
 * first day it may apply from, an empty reason.
 */
export function proposeDraftOf(view: OperationMinutesView, locale: 'it' | 'en'): ProposeDraft {
  const current = view.current
  return {
    basic: typedOf(current.basicMinutes ?? current.standardMinutes, locale),
    personal: typedOf(current.personalPct ?? '0', locale),
    fatigue: typedOf(current.fatiguePct ?? '0', locale),
    delay: typedOf(current.delayPct ?? '0', locale),
    source: 'TIME_STUDY',
    effectiveFrom: minDayOf(view),
    reason: '',
    replace: false,
  }
}

export type MinutesPreview = { ok: true; minutes: BuiltMinutes } | { ok: false; problems: Partial<Record<ProposeField, string>> }

/** The new SMV the typed basic time and allowances give (factory-domain minutesFromAllowances), or what to fix. */
export function previewOf(draft: Pick<ProposeDraft, 'basic' | 'personal' | 'fatigue' | 'delay'>): MinutesPreview {
  const outcome = minutesFromAllowances({ basicMinutes: plainOf(draft.basic), personalPct: plainOf(draft.personal) || '0', fatiguePct: plainOf(draft.fatigue) || '0', delayPct: plainOf(draft.delay) || '0' })
  if (outcome.ok) return { ok: true, minutes: outcome.minutes }
  const problems: Partial<Record<ProposeField, string>> = {}
  for (const issue of outcome.issues) {
    if (issue.path === 'basicMinutes') problems.basic = plainOf(draft.basic) === '' ? 'propose.problem.basicEmpty' : 'propose.problem.basic'
    if (issue.path === 'personalPct') problems.personal = 'propose.problem.allowance'
    if (issue.path === 'fatiguePct') problems.fatigue = 'propose.problem.allowance'
    if (issue.path === 'delayPct') problems.delay = 'propose.problem.allowance'
  }
  return { ok: false, problems }
}

/** The five numbers are those the operation has now (nothing to propose). */
function sameAsNow(minutes: BuiltMinutes, view: OperationMinutesView): boolean {
  const now = view.current
  const same = (a: string, b: string | null) => (b === null ? false : sameMinutes(a, b))
  if (!sameMinutes(minutes.standardMinutes, now.standardMinutes)) return false
  if (now.basicMinutes === null) return false
  return same(minutes.basicMinutes, now.basicMinutes) && same(minutes.personalPct, now.personalPct) && same(minutes.fatiguePct, now.fatiguePct) && same(minutes.delayPct, now.delayPct)
}

/** Every field's problem (a message key), checked before the API is asked. */
export function proposeProblems(draft: ProposeDraft, view: OperationMinutesView): Partial<Record<ProposeField | 'same', string>> {
  const preview = previewOf(draft)
  const problems: Partial<Record<ProposeField | 'same', string>> = preview.ok ? {} : { ...preview.problems }
  if (!(TIME_SOURCES as readonly string[]).includes(draft.source)) problems.source = 'propose.problem.source'
  const min = minDayOf(view)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.effectiveFrom)) problems.effectiveFrom = 'propose.problem.dayEmpty'
  else if (draft.effectiveFrom < min) problems.effectiveFrom = min === view.today ? 'propose.problem.dayPast' : 'propose.problem.dayBeforeApproved'
  const reason = draft.reason.trim()
  if (reason === '') problems.reason = 'propose.problem.reason'
  else if (reason.length > MAX_REASON) problems.reason = 'propose.problem.reasonLong'
  if (preview.ok && sameAsNow(preview.minutes, view)) problems.same = 'propose.held.same'
  return problems
}

/** Why "Send for approval" is held (a message key), or null. */
export function proposeHeld(draft: ProposeDraft, view: OperationMinutesView, busy: boolean): string | null {
  if (!view.may.propose) return 'propose.held.noRight'
  if (view.operation.status === 'ARCHIVED') return 'propose.held.archived'
  if (pendingOf(view) && !draft.replace) return 'propose.held.waiting'
  const problems = proposeProblems(draft, view)
  const first = problems.basic ?? problems.personal ?? problems.fatigue ?? problems.delay ?? problems.source ?? problems.effectiveFrom ?? problems.reason ?? problems.same
  if (first) return first
  return busy ? 'held.busy' : null
}

/** What "Send for approval" sends. */
export function proposeBodyOf(draft: ProposeDraft, view: OperationMinutesView) {
  const preview = previewOf(draft)
  const minutes = preview.ok ? preview.minutes : { basicMinutes: plainOf(draft.basic), personalPct: plainOf(draft.personal), fatiguePct: plainOf(draft.fatigue), delayPct: plainOf(draft.delay) }
  const pending = pendingOf(view)
  return {
    basicMinutes: minutes.basicMinutes,
    personalPct: minutes.personalPct,
    fatiguePct: minutes.fatiguePct,
    delayPct: minutes.delayPct,
    source: draft.source,
    effectiveFrom: draft.effectiveFrom,
    reason: draft.reason.trim(),
    ...(draft.replace && pending ? { replaces: pending.id } : {}),
  }
}

/** The proposal's changes, old → new (the review table): the SMV, the basic time, each allowance, the day. */
export function proposedChanges(draft: ProposeDraft, view: OperationMinutesView): Array<{ id: string; what: string; now: string | null; next: string | null; kind: 'minutes' | 'percent' | 'day' }> {
  const preview = previewOf(draft)
  const now = view.current
  const next = preview.ok ? preview.minutes : null
  const rows: Array<{ id: string; what: string; now: string | null; next: string | null; kind: 'minutes' | 'percent' | 'day' }> = [
    { id: 'smv', what: 'propose.change.smv', now: now.standardMinutes, next: next?.standardMinutes ?? null, kind: 'minutes' },
    { id: 'basic', what: 'propose.change.basic', now: now.basicMinutes, next: next?.basicMinutes ?? null, kind: 'minutes' },
    { id: 'personal', what: 'propose.change.personal', now: now.personalPct, next: next?.personalPct ?? null, kind: 'percent' },
    { id: 'fatigue', what: 'propose.change.fatigue', now: now.fatiguePct, next: next?.fatiguePct ?? null, kind: 'percent' },
    { id: 'delay', what: 'propose.change.delay', now: now.delayPct, next: next?.delayPct ?? null, kind: 'percent' },
  ]
  return [...rows, { id: 'day', what: 'propose.change.day', now: view.inForce.effectiveFrom, next: draft.effectiveFrom || null, kind: 'day' }]
}

// ---- the Minutes tab ---------------------------------------------------------------------------------------------------------

/** Why the SMV may not be typed straight on the operation (W1's way), or null: it is governed, built from allowances, or a proposal waits. */
export function typedSmvHeld(view: Pick<OperationMinutesView, 'governed' | 'current' | 'pendingId'>): string | null {
  if (view.governed) return 'minutes.typed.governed'
  if (view.current.basicMinutes !== null) return 'minutes.typed.allowances'
  if (view.pendingId !== null) return 'minutes.typed.waiting'
  return null
}

/** Why a person may not approve or reject this version (a message key), or null. */
export function decideHeld(version: Pick<TimeVersionView, 'status' | 'proposedBy'>, view: Pick<OperationMinutesView, 'may'>, userId: string | null): string | null {
  if (version.status !== 'PROPOSED') return 'decide.held.notWaiting'
  if (userId !== null && version.proposedBy.id === userId) return 'decide.held.own'
  if (!view.may.decide) return 'decide.held.noRight'
  return null
}

export type VersionTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral'

/** A version's state in words (a message key) and its tone: in force, approved and waiting for its day, waiting for approval… */
export function versionState(version: Pick<TimeVersionView, 'status' | 'inForce' | 'waiting'>): { key: string; tone: VersionTone } {
  if (version.status === 'PROPOSED') return { key: 'version.state.PROPOSED', tone: 'warning' }
  if (version.status === 'REJECTED') return { key: 'version.state.REJECTED', tone: 'danger' }
  if (version.status === 'SUPERSEDED') return { key: 'version.state.SUPERSEDED', tone: 'neutral' }
  if (version.inForce) return { key: 'version.state.inForce', tone: 'success' }
  if (version.waiting) return { key: 'version.state.waiting', tone: 'info' }
  return { key: 'version.state.APPROVED', tone: 'success' }
}

/** The routings an SMV change reaches, by where their run comes from. */
export function impactCounts(view: Pick<OperationMinutesView, 'impact'>): { drafts: number; released: number; following: number } {
  const routings = view.impact.routings
  return {
    drafts: routings.filter((use) => use.revision.status === 'DRAFT').length,
    released: routings.filter((use) => use.revision.status === 'RELEASED').length,
    following: routings.filter((use) => use.runFrom === 'VERSION').length,
  }
}

// ---- where the connections lead (design page.conn) -------------------------------------------------------------------------------

export type Place = { kind: 'page'; href: string } | { kind: 'notBuilt' } | { kind: 'noRight' }

/** People › Piece rates and Changes & versions: a link once the page is built and the role reads it, else why not. */
export function connectionsOf(prefix: string, pages: ReadonlySet<string>, permissions: readonly string[]): { pieceRates: Place; changes: Place } {
  const held = new Set(permissions)
  const pieceRates: Place = !pages.has('/people/piecerates') ? { kind: 'notBuilt' } : held.has('people.piecerates.view') ? { kind: 'page', href: `${prefix}/people/piecerates` } : { kind: 'noRight' }
  const changes: Place = pages.has('/products/changes') ? { kind: 'page', href: `${prefix}/products/changes` } : { kind: 'notBuilt' }
  return { pieceRates, changes }
}

// ---- the SMV changes waiting (the list's tile) ---------------------------------------------------------------------------------

/** Why a waiting change cannot be selected to approve (a message key), or null. */
export function waitingSelectHeld(entry: Pick<WaitingEntry, 'mayDecide' | 'proposal'>, userId: string | null): string | null {
  if (entry.mayDecide) return null
  return userId !== null && entry.proposal.proposedBy.id === userId ? 'decide.held.own' : 'decide.held.noRight'
}

// ---- machine and stitch settings ---------------------------------------------------------------------------------------------

/**
 * factory-domain routing-depth SETTING_LIMITS, written here (its file reaches `node:crypto`): a list of at most 10, texts of
 * 120, notes of 500, the stitch type of 20. routing-depth.vitest.test.ts holds them equal.
 */
export const SETTING_LIMITS = Object.freeze({ perList: 10, text: 120, notes: 500, stitchType: 20 })

export const SETTING_FIELDS = ['machineClassId', 'stitchType', 'needle', 'thread', 'stitchesPerCm', 'tension', 'foot', 'notes'] as const
export type SettingField = (typeof SETTING_FIELDS)[number]

export interface SettingDraft {
  /** The row's key in the editor (the setting's id, or a new one). */
  key: string
  machineClassId: string
  stitchType: string
  needle: string
  thread: string
  stitchesPerCm: string
  tension: string
  foot: string
  notes: string
}

export const emptySetting = (key: string): SettingDraft => ({ key, machineClassId: '', stitchType: '', needle: '', thread: '', stitchesPerCm: '', tension: '', foot: '', notes: '' })

export function settingDraftOf(setting: Setting, locale: 'it' | 'en'): SettingDraft {
  return {
    key: setting.id,
    machineClassId: setting.machineClass?.id ?? '',
    stitchType: setting.stitchType ?? '',
    needle: setting.needle ?? '',
    thread: setting.thread ?? '',
    stitchesPerCm: typedOf(setting.stitchesPerCm, locale),
    tension: setting.tension ?? '',
    foot: setting.foot ?? '',
    notes: setting.notes ?? '',
  }
}

const STITCHES = /^\d{1,4}(?:\.\d{1,2})?$/

/** Each row's problems (message keys by field): a row says something; stitches per cm above 0 with at most 2 decimals; lengths. */
export function settingProblems(drafts: readonly SettingDraft[]): Array<Partial<Record<SettingField | 'row', string>>> {
  return drafts.map((draft) => {
    const problems: Partial<Record<SettingField | 'row', string>> = {}
    if (SETTING_FIELDS.every((field) => draft[field].trim() === '')) problems.row = 'settings.problem.empty'
    const stitches = plainOf(draft.stitchesPerCm)
    if (stitches !== '' && (!STITCHES.test(stitches) || Number(stitches) <= 0)) problems.stitchesPerCm = 'settings.problem.stitches'
    if (draft.stitchType.trim().length > SETTING_LIMITS.stitchType) problems.stitchType = 'settings.problem.long'
    for (const field of ['needle', 'thread', 'tension', 'foot'] as const) if (draft[field].trim().length > SETTING_LIMITS.text) problems[field] = 'settings.problem.long'
    if (draft.notes.trim().length > SETTING_LIMITS.notes) problems.notes = 'settings.problem.long'
    return problems
  })
}

const orNull = (text: string): string | null => (text.trim() === '' ? null : text.trim())

/** What the list sends, in order. */
export const settingBodiesOf = (drafts: readonly SettingDraft[]): SettingBody[] =>
  drafts.map((draft) => ({
    machineClassId: draft.machineClassId || null,
    stitchType: orNull(draft.stitchType),
    needle: orNull(draft.needle),
    thread: orNull(draft.thread),
    stitchesPerCm: plainOf(draft.stitchesPerCm) || null,
    tension: orNull(draft.tension),
    foot: orNull(draft.foot),
    notes: orNull(draft.notes),
  }))

/** The list as stored, as it would be sent (for "nothing changed"). */
export const storedBodiesOf = (settings: readonly Setting[]): SettingBody[] =>
  settings.map((setting) => ({
    machineClassId: setting.machineClass?.id ?? null,
    stitchType: setting.stitchType,
    needle: setting.needle,
    thread: setting.thread,
    stitchesPerCm: setting.stitchesPerCm,
    tension: setting.tension,
    foot: setting.foot,
    notes: setting.notes,
  }))

const sameNumber = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : Number(a) === Number(b))

/** The drafts say what is stored (in the same order). */
export function sameSettings(drafts: readonly SettingDraft[], settings: readonly Setting[]): boolean {
  const next = settingBodiesOf(drafts)
  const now = storedBodiesOf(settings)
  if (next.length !== now.length) return false
  return next.every((body, index) => {
    const stored = now[index]!
    return SETTING_FIELDS.every((field) => (field === 'stitchesPerCm' ? sameNumber(body[field], stored[field]) : body[field] === stored[field]))
  })
}

/** Why the settings list cannot be saved (a message key), or null. */
export function settingsSaveHeld(drafts: readonly SettingDraft[], settings: readonly Setting[], busy: boolean): string | null {
  if (drafts.length > SETTING_LIMITS.perList) return 'settings.problem.tooMany'
  const problems = settingProblems(drafts)
  const count = problems.filter((entry) => Object.keys(entry).length > 0).length
  if (count > 0) return 'settings.held.fix'
  if (sameSettings(drafts, settings)) return 'settings.held.same'
  return busy ? 'held.busy' : null
}

/** Why the library's settings are read only (a message key), or null. */
export function librarySettingsHeld(view: Pick<LibrarySettings, 'may' | 'operation'>): string | null {
  if (!view.may.manage) return 'settings.held.noManage'
  if (view.operation.status === 'ARCHIVED') return 'settings.held.archived'
  return null
}

/** A machine class in the page's language ("Post-bed"). */
export const classLabel = (choice: Pick<MachineClassChoice, 'labelIt' | 'labelEn'>, locale: 'it' | 'en'): string => (locale === 'it' ? choice.labelIt : choice.labelEn)

// ---- the record's W2b state, shared by the hooks and the views -------------------------------------------------------------------

export type MinutesDialog = { kind: 'propose' } | { kind: 'approve'; versionId: string } | { kind: 'reject'; versionId: string }

export interface MinutesModel {
  part: Part<OperationMinutesView>
  dialog: MinutesDialog | null
  busy: boolean
  /** The last refused write, kept for the dialog's words. */
  refused: WriteProblem | null
  notice: Notice | null
  /** The person reading (a proposal is never decided by the one who made it). */
  userId: string | null
  can: SmvCan
  connections: { pieceRates: Place; changes: Place }
  /** The browser is offline: Send and decisions are held, what was typed stays on the page. */
  offline?: boolean
  /** Design cases: the proposal already typed. */
  draft?: ProposeDraft
}

export interface MinutesActions {
  onRetry?: () => void
  onDialog?: (dialog: MinutesDialog | null) => void
  onPropose?: (draft: ProposeDraft) => Promise<boolean>
  onApprove?: (version: TimeVersionView, note: string) => Promise<boolean>
  onReject?: (version: TimeVersionView, note: string) => Promise<boolean>
  onDismissNotice?: () => void
}

export interface SettingsModel {
  part: Part<LibrarySettings>
  /** The machine classes (null while unread; [] without plant.view or when the read failed). */
  classes: MachineClassChoice[] | null
  busy: boolean
  refused: WriteProblem | null
  notice: Notice | null
  /** The browser is offline: Save is held, the list stays on the page. */
  offline?: boolean
  /** Design cases: the list already being edited. */
  drafts?: SettingDraft[]
}

export interface SettingsActions {
  onRetry?: () => void
  onSave?: (drafts: readonly SettingDraft[]) => Promise<boolean>
  onDismissNotice?: () => void
}
