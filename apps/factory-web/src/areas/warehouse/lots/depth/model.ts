import { attributesProblems, mergeAttributes } from '@nexus/factory-domain/inventory/lots-depth/attributes'
import { requestProblems } from '@nexus/factory-domain/inventory/lots-depth/trace-report'
import { TANNAGES } from '@nexus/factory-domain/product/materials/rules'
import type { Tone } from '../../../_shared/stock/model'
import { phrase, type Phrase } from '../../../_shared/stock/model'
import type { AttributeKey, HistoryRow, Lifecycle, LotAttributeValues, LotDepth, SplitHide, SplitRead, TraceAudience, TraceDirection, TraceFormat, TraceReportBody } from './api'

/**
 * B-W2b-320 — the W2b rules of Warehouse › Lots & traceability, pure: the lifecycle's tone and words, the W2b views, who may
 * sort hides and make a report, the attributes form (the domain's own checks), the split and regroup drafts and why their
 * button waits, the trace report's request, and each English sentence of the API said in our words by its facts. Words
 * are keys of `warehouse-lots-counts` (`ld.*`).
 */

export const DEPTH_NAMESPACE = 'warehouse-lots-counts'

export const LIFECYCLE_TONE: Readonly<Record<Lifecycle, Tone>> = Object.freeze({ QUARANTINE: 'warning', RELEASED: 'success', IN_USE: 'info', DEPLETED: 'neutral', BLOCKED: 'danger', RETURNED: 'neutral' })

// ---- abilities -------------------------------------------------------------------------------------------------------------

export interface DepthCan {
  /** Sort hides into lots, record attributes, check the lifecycle (inventory.lots.manage: warehouse, quality). */
  manage: boolean
  /** The dated trace report (inventory.trace.report: quality). */
  report: boolean
  /** Opening the report's file (files.read). */
  files: boolean
}
export function depthCan(permissions: readonly string[]): DepthCan {
  const held = new Set(permissions)
  return { manage: held.has('inventory.lots.manage'), report: held.has('inventory.trace.report'), files: held.has('files.read') }
}

// ---- the list's W2b views --------------------------------------------------------------------------------------------------

/** The views only B-W2b-313's list reads (the others are W1's, enriched by id). */
export const DEPTH_VIEWS = ['depleted', 'expiring'] as const
export type DepthView = (typeof DEPTH_VIEWS)[number]
export const isDepthView = (view: string): view is DepthView => (DEPTH_VIEWS as readonly string[]).includes(view)
export const depthViewQuery = (view: DepthView) => (view === 'depleted' ? { view: 'DEPLETED' as const } : { view: 'ALL' as const, documentsExpiring: true })

// ---- the record's facts in words -------------------------------------------------------------------------------------------

/** A history row in words: a lifecycle move by its cause, a quality decision by its action, a split by its kind. */
export function historyWords(row: HistoryRow): Phrase {
  if (row.kind === 'LIFECYCLE') return phrase(row.cause ? `ld.cause.${row.cause}` : 'ld.cause.none', { to: row.to ?? '' })
  if (row.kind === 'QUALITY') {
    const action = row.action.split('.').pop() ?? ''
    return phrase(['release', 'unblock', 'reject', 'block'].includes(action) ? `ld.decision.${action}` : 'ld.decision.other')
  }
  return phrase(row.action === 'inventory.regroupLot' ? 'ld.split.historyRegroup' : row.action === 'inventory.lotMadeBySplit' ? 'ld.split.historyMade' : 'ld.split.historySplit')
}
export const HISTORY_TONE: Readonly<Record<HistoryRow['kind'], Tone>> = Object.freeze({ LIFECYCLE: 'info', QUALITY: 'success', SPLIT: 'neutral' })

/** The lifecycle the ledger expects differs from the one recorded: a move not handled yet ("Check"). */
export const lifecycleBehind = (depth: Pick<LotDepth, 'lifecycle'>): boolean => depth.lifecycle.state !== depth.lifecycle.expected

/** Why the family is not split or regrouped (B-W2b-313 familyRefusal, from the lot's facts), or why this person may not. */
export function splitHeldKey(lot: { tracking: string; qualityStatus: string }, can: Pick<DepthCan, 'manage'>, may?: Pick<LotDepth['may'], 'manage'>): Phrase | null {
  if (lot.tracking !== 'HIDE') return phrase('ld.split.held.notHides')
  if (lot.qualityStatus === 'BLOCKED') return phrase('ld.split.held.blocked')
  if (lot.qualityStatus === 'REJECTED') return phrase('ld.split.held.rejected')
  if (!can.manage || (may && !may.manage)) return phrase('ld.split.held.noRight')
  return null
}

/**
 * A hide's refusal (B-W2b-313 hideMoveRefusal, English) in our words: each sentence of the domain is matched by its own
 * shape (the test runs the domain's function for every case, so a changed sentence fails there, never on screen).
 */
const HIDE_REFUSALS: readonly [RegExp, string][] = [
  [/ is (.+): only a whole hide moves/, 'notWhole'],
  [/ holds nothing at the site/, 'nothing'],
  [/ is reserved for /, 'reserved'],
  [/ is on a quality hold/, 'held'],
  [/ is in incoming inspection (\S+), still open/, 'inspection'],
  [/ is on stock count (\S+), still open/, 'count'],
  [/ has an open warehouse task/, 'task'],
  [/ is on a transfer to another site/, 'transfer'],
  [/ is on a supplier claim/, 'claim'],
  [/ is planned in a subcontract kit/, 'kit'],
]
export function hideRefusalKey(words: string | null): Phrase | null {
  if (!words) return null
  for (const [shape, key] of HIDE_REFUSALS) {
    const match = shape.exec(words)
    if (match) return phrase(`ld.split.hide.${key}`, { ref: match[1] ?? '' })
  }
  return phrase('ld.split.hide.other')
}

/** A proposal group kept apart by the inspection ("Rejected", "To sort", B-W2b-313 proposalFromInspection) in our words. */
export function proposalLabel(group: { shadeGroupId: string | null; label: string }): Phrase | null {
  if (group.shadeGroupId !== null) return null
  if (group.label === 'Rejected') return phrase('ld.split.apart.REJECTED')
  if (group.label === 'To sort') return phrase('ld.split.apart.TO_SORT')
  return null
}

// ---- attributes (lt-facts W2b) ----------------------------------------------------------------------------------------------

export const TANNAGE_CHOICES = TANNAGES

/** The form's text per key; the grade mix as "A 75, B 25". */
export type AttributeDraft = Partial<Record<AttributeKey, string>>

export const gradeMixText = (value: unknown): string =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value as Record<string, string>)
        .map(([grade, share]) => `${grade} ${share}`)
        .join(', ')
    : ''

/** "A 75, B 25" (or "A:75; B=25") → { A: "75", B: "25" }; null when a part has no grade and share. */
export function parseGradeMix(text: string): Record<string, string> | null {
  const parts = text.split(/[,;]/).map((part) => part.trim()).filter(Boolean)
  const mix: Record<string, string> = {}
  for (const part of parts) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,19})\s*[:= ]\s*([0-9]+(?:[.,][0-9]+)?)\s*%?$/.exec(part)
    if (!match) return null
    mix[match[1]!] = match[2]!.replace(',', '.')
  }
  return mix
}

export function attributeDraftOf(values: LotAttributeValues, keys: readonly AttributeKey[]): AttributeDraft {
  const draft: AttributeDraft = {}
  for (const key of keys) {
    const value = values[key]
    draft[key] = key === 'gradeMix' ? gradeMixText(value) : typeof value === 'string' ? value : ''
  }
  return draft
}

/** A typed decimal in either language's mark ("1,2" → "1.2"). */
const decimalText = (text: string): string => text.trim().replace(',', '.')

/** What the form sends: a changed key with its value, an emptied one with null; unchanged keys are left out. */
export function attributeChanges(values: LotAttributeValues, keys: readonly AttributeKey[], draft: AttributeDraft): { changes: Record<string, string | Record<string, string> | null>; badMix: boolean } {
  const changes: Record<string, string | Record<string, string> | null> = {}
  let badMix = false
  for (const key of keys) {
    const typed = (draft[key] ?? '').trim()
    const before = values[key]
    if (key === 'gradeMix') {
      if (typed === '') {
        if (before !== undefined) changes[key] = null
        continue
      }
      const mix = parseGradeMix(typed)
      if (!mix) {
        badMix = true
        continue
      }
      if (JSON.stringify(mix) !== JSON.stringify(before ?? null)) changes[key] = mix
      continue
    }
    const next = key === 'thicknessMinMm' || key === 'thicknessMaxMm' || key === 'widthCm' || key === 'weightGsm' ? decimalText(typed) : typed
    if (next === '') {
      if (before !== undefined) changes[key] = null
    } else if (next !== before) changes[key] = next
  }
  return { changes, badMix }
}

/** Each key the domain refuses (the same rules as the API and the database), as `ld.attr.problem.<key>`. */
export function attributeProblems(kind: string, values: LotAttributeValues, changes: Readonly<Record<string, unknown>>, badMix: boolean): Partial<Record<AttributeKey, Phrase>> {
  const out: Partial<Record<AttributeKey, Phrase>> = {}
  for (const issue of attributesProblems(kind, mergeAttributes(values, changes))) {
    const key = issue.path.split('/')[1] as AttributeKey | undefined
    if (key && !out[key]) out[key] = phrase(`ld.attr.problem.${key}`)
  }
  if (badMix) out.gradeMix = phrase('ld.attr.problem.gradeMix')
  return out
}

// ---- split into shade groups and regroup (lt-split) --------------------------------------------------------------------------

export interface DraftGroup {
  key: string
  shadeGroupId: string | null
  label: string
}

export interface SplitDraft {
  /** split: new child lots; regroup: hides into another lot of the family. */
  mode: 'split' | 'regroup'
  groups: DraftGroup[]
  /** hide id → a group key (split) or a lot id (regroup); absent: the hide stays where it is. */
  assign: Record<string, string>
  inspectionId: string | null
  note: string
}

/** The dialog's first proposal: the groups the newest incoming inspection sorted the hides into (LT1:01). */
export function draftOf(read: SplitRead, words?: (key: string) => string): SplitDraft {
  const movable = new Set(read.hides.filter((hide) => hide.refusal === null).map((hide) => hide.id))
  // A group the inspection kept apart is named in the reader's words (its label becomes the child lot's shade text).
  const labelOf = (group: SplitRead['proposal']['groups'][number]) => {
    const apart = proposalLabel(group)
    return apart && words ? words(apart.key) : group.label
  }
  const groups: DraftGroup[] = read.proposal.groups.map((group, index) => ({ key: `g${index + 1}`, shadeGroupId: group.shadeGroupId, label: group.shadeGroupId ? '' : labelOf(group) }))
  const assign: Record<string, string> = {}
  read.proposal.groups.forEach((group, index) => {
    for (const hideId of group.hideIds) if (movable.has(hideId)) assign[hideId] = `g${index + 1}`
  })
  return { mode: 'split', groups, assign, inspectionId: read.proposal.inspection && groups.length > 0 ? read.proposal.inspection.id : null, note: '' }
}

export const nextGroupKey = (draft: Pick<SplitDraft, 'groups'>): string => `g${draft.groups.reduce((top, group) => Math.max(top, Number(group.key.slice(1)) || 0), 0) + 1}`

/** The hides of each group, in the dialog's order (empty groups kept: they say they hold nothing). */
export function groupHides(draft: SplitDraft, hides: readonly SplitHide[]): Map<string, SplitHide[]> {
  const out = new Map<string, SplitHide[]>(draft.groups.map((group) => [group.key, []]))
  for (const hide of hides) {
    const key = draft.assign[hide.id]
    if (key && out.has(key)) out.get(key)!.push(hide)
  }
  return out
}

/** Why "Create N child lots" (or "Move N hides") waits, in words; null: it may go. */
export function splitHeld(read: SplitRead, draft: SplitDraft, can: Pick<DepthCan, 'manage'>, busy: boolean): Phrase | null {
  if (!can.manage || !read.may) return phrase('ld.split.held.noRight')
  if (busy) return phrase('ld.split.held.busy')
  const refused = new Set(read.hides.filter((hide) => hide.refusal !== null).map((hide) => hide.id))
  if (Object.keys(draft.assign).some((hideId) => refused.has(hideId))) return phrase('ld.split.held.refusedHide')
  if (draft.mode === 'regroup') {
    const moves = regroupMoves(read, draft)
    return moves.length === 0 ? phrase('ld.split.held.noMove') : null
  }
  const hides = groupHides(draft, read.hides)
  const filled = draft.groups.filter((group) => (hides.get(group.key)?.length ?? 0) > 0)
  if (filled.length === 0) return phrase('ld.split.held.noHides')
  if (filled.some((group) => !group.shadeGroupId && group.label.trim() === '')) return phrase('ld.split.held.noLabel')
  if (filled.some((group) => group.label.trim().length > 60)) return phrase('ld.split.held.longLabel')
  if (draft.note.length > 500) return phrase('ld.split.held.longNote')
  return null
}

/** The groups that hold hides: each becomes one child lot. */
export const filledGroups = (read: SplitRead, draft: SplitDraft): DraftGroup[] => {
  const hides = groupHides(draft, read.hides)
  return draft.groups.filter((group) => (hides.get(group.key)?.length ?? 0) > 0)
}

export function splitBodyOf(read: SplitRead, draft: SplitDraft) {
  const hides = groupHides(draft, read.hides)
  return {
    version: read.parent.version,
    groups: filledGroups(read, draft).map((group) => ({ ...(group.shadeGroupId ? { shadeGroupId: group.shadeGroupId } : { label: group.label.trim() }), hideIds: (hides.get(group.key) ?? []).map((hide) => hide.id) })),
    ...(draft.inspectionId ? { inspectionId: draft.inspectionId } : {}),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
  }
}

/** Regroup: each hide whose chosen lot is another lot of the family. */
export function regroupMoves(read: SplitRead, draft: SplitDraft): { hideId: string; toLotId: string }[] {
  const lots = new Set(read.lots.map((lot) => lot.id))
  return read.hides.flatMap((hide) => {
    const to = draft.assign[hide.id]
    return to && lots.has(to) && to !== hide.lot.id ? [{ hideId: hide.id, toLotId: to }] : []
  })
}
export const regroupBodyOf = (read: SplitRead, draft: SplitDraft) => ({ version: read.parent.version, moves: regroupMoves(read, draft), ...(draft.note.trim() ? { note: draft.note.trim() } : {}) })

/** A refused split or regroup in words: a stale version, a hide that cannot move, a frozen count line or a blocked place. */
export function splitProblem(error: { kind: string; code: string; issues: readonly { path?: unknown }[] } | null): Phrase {
  if (!error) return phrase('ld.split.failed')
  const paths = error.issues.map((issue) => (typeof issue.path === 'string' ? issue.path : Array.isArray(issue.path) ? issue.path.join('/') : ''))
  if (paths.some((path) => path.startsWith('warehouse/'))) return phrase('ld.split.refused.warehouse')
  if (error.kind === 'conflict') return phrase(paths.some((path) => path.includes('hide')) ? 'ld.split.refused.hide' : 'ld.split.refused.changed')
  if (error.kind === 'forbidden' || error.kind === 'step_up') return phrase('ld.split.held.noRight')
  if (error.kind === 'invalid') return phrase('ld.split.refused.invalid')
  if (error.kind === 'unavailable') return phrase('ld.split.refused.offline')
  return phrase('ld.split.failed')
}

// ---- the dated trace report (lt-report) ---------------------------------------------------------------------------------------

export interface ReportDraft {
  direction: TraceDirection
  audience: TraceAudience
  recipient: string
  reference: string
  requestedOn: string
  asOf: string
  format: TraceFormat
  language: 'it' | 'en'
  note: string
}

export const blankReport = (today: string, language: 'it' | 'en'): ReportDraft => ({ direction: 'BOTH', audience: 'CUSTOMER', recipient: '', reference: '', requestedOn: today, asOf: today, format: 'PDF', language, note: '' })

/** The request's problems by field (the domain's own check: who asked, the day asked and "as of" not after today). */
export function reportProblems(draft: ReportDraft, today: string): Partial<Record<'recipient' | 'reference' | 'requestedOn' | 'asOf' | 'note', Phrase>> {
  const out: Partial<Record<'recipient' | 'reference' | 'requestedOn' | 'asOf' | 'note', Phrase>> = {}
  const issues = requestProblems({ audience: draft.audience, recipient: draft.recipient, reference: draft.reference || null, requestedOn: draft.requestedOn as never, asOf: (draft.asOf || null) as never, note: draft.note || null }, today as never)
  for (const issue of issues) {
    const field = issue.path as keyof typeof out
    if (!out[field]) out[field] = phrase(`ld.report.problem.${field}`, { today })
  }
  return out
}

export function reportHeld(draft: ReportDraft, today: string, can: Pick<DepthCan, 'report'>, busy: boolean): Phrase | null {
  if (!can.report) return phrase('ld.report.held.noRight')
  if (busy) return phrase('ld.report.held.busy')
  return Object.values(reportProblems(draft, today))[0] ?? null
}

export const reportBodyOf = (lotId: string, draft: ReportDraft): TraceReportBody => ({
  kind: 'LOT',
  id: lotId,
  direction: draft.direction,
  audience: draft.audience,
  recipient: draft.recipient.trim(),
  reference: draft.reference.trim() || null,
  requestedOn: draft.requestedOn,
  asOf: draft.asOf || null,
  format: draft.format,
  language: draft.language,
  note: draft.note.trim() || null,
})

/** Today in the site's zone (YYYY-MM-DD): the report's default day and its limit. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}
