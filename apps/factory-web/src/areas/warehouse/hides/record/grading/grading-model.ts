import { isApiError, issuePath } from '../../../../../lib/api/errors'
import type { Locale } from '../../../../../lib/i18n/locales'
import { phrase, writeProblem, type Phrase } from '../../../../_shared/stock/model'
import type { Part } from '../../../lots/shared/model'
import type { AreaUnit, GradingChange, GradingHideState, GradingPatch, GradingView, MeasureBody, MeasureOutcome, MeasureRecorded, MeasuresView, MeasureView } from './api'

/**
 * The hide record's "Measurements & grade" and "Defects & photos" tabs (B-W2b-131 on B-W2b-94's routes; design
 * warehouse.hides rec:Hide tabs `grade` and `defects`), pure: what the person may do there, the draft of each tab and the
 * correction it sends (only what changed; null clears), why Apply is held, a refused correction or measure in OUR words (a
 * key of `warehouse-lots`, or `stock:` for the shared ones), why a hide is read-only or cannot be measured (from its state:
 * the API's sentence is never drawn), a measure's tone and who took it, and a change's lines.
 */

/** What the person may do on the two tabs beyond reading the hide (from the session's permissions). */
export interface GradingCan {
  /** inventory.hides.manage: correct grade, shade, thickness, defects; measure again. */
  manage: boolean
  /** inventory.adjust: correct the hide's stock with a measure. */
  adjust: boolean
  /** files.read: the hide's photos. */
  filesRead: boolean
  /** files.upload: add a photo from the office. */
  filesUpload: boolean
}

export function gradingCan(permissions: readonly string[]): GradingCan {
  const held = new Set(permissions)
  return { manage: held.has('inventory.hides.manage'), adjust: held.has('inventory.adjust'), filesRead: held.has('files.read'), filesUpload: held.has('files.upload') }
}

export type GradingTab = 'grade' | 'defects'

/** What a tab's form holds (a decimal typed as the person types it: "1,25"). */
export interface GradingDraft {
  /** The hide's version the draft started from: a correction is sent at it (a newer one: refused, read again). */
  version: number
  gradeId: string | null
  /** A grade known only by its W1 text, recorded as its record (the same grade, now a record). */
  recordByText: boolean
  shadeGroupId: string | null
  thicknessMm: string
  defects: string
  reason: string
}

/** "1.20" → "1,20" in Italian (a typed field shows the person's decimal mark). */
export const decimalForEdit = (text: string | null, locale: Locale): string => (text === null ? '' : locale === 'it' ? text.replace('.', ',') : text)

/** What the person typed as the API's decimal: "1,25" → "1.25", spaces dropped; '' stays ''. */
export function plainDecimal(text: string): string {
  const compact = text.trim().replace(/\s+/g, '')
  if (compact === '') return ''
  // The last of a comma and a dot is the decimal mark ("1.234,5" in Italian, "1,234.5" in English); the other groups thousands.
  const comma = compact.lastIndexOf(',')
  const dot = compact.lastIndexOf('.')
  if (comma > dot) return `${compact.slice(0, comma).replace(/[.,]/g, '')}.${compact.slice(comma + 1)}`
  return compact.replace(/,/g, '')
}

/** The draft of a tab as the hide is now. */
export function draftOf(view: GradingView, locale: Locale): GradingDraft {
  return {
    version: view.hide.version,
    gradeId: view.grade?.id ?? null,
    recordByText: false,
    shadeGroupId: view.shade?.id ?? null,
    thicknessMm: decimalForEdit(view.hide.thicknessMm, locale),
    defects: view.hide.defects ?? '',
    reason: '',
  }
}

const THICKNESS = /^\d{1,4}(\.\d{1,2})?$/
const sameNumber = (a: string, b: string | null): boolean => (a === '' ? b === null : b !== null && Number(a) === Number(b))

/** The fields a tab corrects. */
const FIELDS: Readonly<Record<GradingTab, readonly ('grade' | 'shade' | 'thickness' | 'defects')[]>> = { grade: ['grade', 'shade', 'thickness'], defects: ['defects'] }

/** The correction a tab's draft makes: only what differs from the hide as read (null clears), at the draft's version. */
export function patchOf(view: GradingView, draft: GradingDraft, tab: GradingTab): GradingPatch | null {
  const patch: GradingPatch = { version: draft.version }
  let changed = 0
  for (const field of FIELDS[tab]) {
    if (field === 'grade') {
      const current = view.grade?.id ?? null
      if (draft.gradeId !== current || (draft.recordByText && view.grade?.byText && draft.gradeId === current)) {
        patch.gradeId = draft.gradeId
        changed += 1
      }
    }
    if (field === 'shade' && draft.shadeGroupId !== (view.shade?.id ?? null)) {
      patch.shadeGroupId = draft.shadeGroupId
      changed += 1
    }
    if (field === 'thickness') {
      const typed = plainDecimal(draft.thicknessMm)
      if (!sameNumber(typed, view.hide.thicknessMm)) {
        patch.thicknessMm = typed === '' ? null : typed
        changed += 1
      }
    }
    if (field === 'defects' && draft.defects.trim() !== (view.hide.defects ?? '').trim()) {
      patch.defects = draft.defects.trim() === '' ? null : draft.defects.trim()
      changed += 1
    }
  }
  if (changed === 0) return null
  if (draft.reason.trim() !== '') patch.reason = draft.reason.trim()
  return patch
}

/** How many fields a tab's draft changes (the EditModeBar's count). */
export function changeCount(view: GradingView, draft: GradingDraft, tab: GradingTab): number {
  const patch = patchOf(view, draft, tab)
  return patch ? Object.keys(patch).filter((key) => key !== 'version' && key !== 'reason').length : 0
}

export const DEFECTS_LIMIT = 2000
export const REASON_LIMIT = 500

/** Why a tab's Apply is held (a key of `warehouse-lots`), or null when it may go. */
export function applyHeldKey(view: GradingView, draft: GradingDraft, tab: GradingTab, can: Pick<GradingCan, 'manage'>, saving: boolean): string | null {
  if (saving) return 'hd.grading.held.saving'
  if (view.readOnly !== null) return 'hd.grading.held.readOnly'
  if (!can.manage || !view.canEdit) return 'hd.grading.held.noRight'
  if (!patchOf(view, draft, tab)) return 'hd.grading.held.nothing'
  if (tab === 'grade') {
    const typed = plainDecimal(draft.thicknessMm)
    if (typed !== '' && (!THICKNESS.test(typed) || Number(typed) <= 0)) return 'hd.grading.held.thickness'
  }
  if (tab === 'defects' && draft.defects.trim().length > DEFECTS_LIMIT) return 'hd.grading.held.defectsLong'
  if (draft.reason.trim().length > REASON_LIMIT) return 'hd.grading.held.reasonLong'
  if (view.reasonRequired && draft.reason.trim() === '') return 'hd.grading.held.reason'
  return null
}

/** Why the hide is read-only on these tabs (a key of `warehouse-lots`, from its state; never the API's sentence), or null. */
export function readOnlyKey(view: Pick<GradingView, 'readOnly' | 'hide'>): string | null {
  if (view.readOnly === null) return null
  return ['CONSUMED', 'SCRAPPED', 'RETURNED'].includes(view.hide.state) ? `hd.grading.readOnly.${view.hide.state}` : 'hd.grading.readOnly.other'
}

const withStock = (refused: Phrase): Phrase => ({ ...refused, key: `stock:${refused.key}` })

/** A refused correction in our words: by the field the API names, a newer version, a read-only hide, else the shared words. */
export function gradingRefusal(error: unknown): Phrase {
  if (isApiError(error)) {
    const paths = error.issues.map(issuePath)
    const field = (name: string) => paths.some((path) => path === `body/${name}` || path === `body.${name}`)
    if (error.kind === 'invalid') {
      if (field('reason')) return phrase('hd.grading.refused.reason')
      if (field('gradeId')) return phrase('hd.grading.refused.grade')
      if (field('shadeGroupId')) return phrase('hd.grading.refused.shade')
      if (field('thicknessMm')) return phrase('hd.grading.refused.thickness')
      if (field('defects')) return phrase('hd.grading.refused.defects')
    }
    if (error.kind === 'conflict') return phrase(error.code === 'invalid_state' ? 'hd.grading.refused.readOnly' : 'hd.grading.refused.stale')
    if (error.kind === 'forbidden' || error.kind === 'step_up') return phrase('hd.grading.refused.forbidden')
  }
  return withStock(writeProblem(error))
}

// ---- measures ----------------------------------------------------------------------------------------------------------

/** A measure's outcome as a tone (always with its word beside it). */
export const OUTCOME_TONE: Readonly<Record<MeasureOutcome, 'success' | 'danger' | 'info'>> = { WITHIN: 'success', SHORT: 'danger', OVER: 'info' }

/** Who measured, in words: an office person's name, a floor worker's only where shown, else who in general. */
export function measuredBy(measure: Pick<MeasureView, 'by'>, t: (key: string) => string): string {
  if (measure.by.name) return measure.by.name
  if (measure.by.audience === 'FLOOR') return t(measure.by.hidden ? 'hd.measure.by.floorHidden' : 'hd.measure.by.floor')
  return t('hd.measure.by.office')
}

/** Why "Measure again…" is held (a key of `warehouse-lots`), or null. Only a whole hide is measured against the tannery. */
export function measureHeldKey(measures: Pick<MeasuresView, 'measureRefusal' | 'canMeasure'> & { hide: { state: GradingHideState } }, can: Pick<GradingCan, 'manage'>): string | null {
  if (measures.measureRefusal !== null) {
    const state = measures.hide.state
    if (state === 'PARTLY_CUT' || state === 'REMNANT') return 'hd.measure.held.cut'
    if (state === 'CONSUMED' || state === 'SCRAPPED' || state === 'RETURNED') return `hd.measure.held.${state}`
    return 'hd.measure.held.notWhole'
  }
  if (!can.manage || !measures.canMeasure) return 'hd.measure.held.noRight'
  return null
}

/** Why "Correct the area…" is held (a key of `warehouse-lots`), or null: a measure first, and inventory.adjust. */
export function correctHeldKey(measures: Pick<MeasuresView, 'measureRefusal' | 'canMeasure' | 'canCorrectStock'> & { hide: { state: GradingHideState } }, can: Pick<GradingCan, 'manage' | 'adjust'>): string | null {
  const held = measureHeldKey(measures, can)
  if (held) return held
  if (!can.adjust || !measures.canCorrectStock) return 'hd.measure.held.noAdjust'
  return null
}

/** The Re-measure dialog's fields (decimals as typed). */
export interface MeasureDraft {
  measuredArea: string
  declaredArea: string
  note: string
  /** Also correct the hide's stock to the measured area (an adjustment move). */
  correctStock: boolean
  correctNote: string
}

export const EMPTY_MEASURE: MeasureDraft = Object.freeze({ measuredArea: '', declaredArea: '', note: '', correctStock: false, correctNote: '' })

const AREA = /^\d{1,10}(\.\d{1,4})?$/
const positiveArea = (text: string): boolean => AREA.test(text) && Number(text) > 0

/** Why the dialog's Save is held (a key of `warehouse-lots`), or null. */
export function measureDraftHeldKey(draft: MeasureDraft, posting: boolean): string | null {
  if (posting) return 'hd.measure.held.saving'
  const measured = plainDecimal(draft.measuredArea)
  if (measured === '') return 'hd.measure.held.measured'
  if (!positiveArea(measured)) return 'hd.measure.held.measuredBad'
  const declared = plainDecimal(draft.declaredArea)
  if (declared !== '' && !positiveArea(declared)) return 'hd.measure.held.declaredBad'
  if (draft.note.trim().length > 500 || draft.correctNote.trim().length > 500) return 'hd.measure.held.noteLong'
  return null
}

/** The measure's body in the hide's own unit; the stock correction only when asked. */
export function measureBodyOf(draft: MeasureDraft, uom: AreaUnit): MeasureBody {
  const declared = plainDecimal(draft.declaredArea)
  return {
    measuredArea: plainDecimal(draft.measuredArea),
    areaUom: uom,
    ...(declared !== '' ? { declaredArea: declared } : {}),
    ...(draft.note.trim() !== '' ? { note: draft.note.trim() } : {}),
    ...(draft.correctStock ? { correctStock: { note: draft.correctNote.trim() === '' ? null : draft.correctNote.trim() } } : {}),
  }
}

/** A refused measure in our words. */
export function measureRefusal(error: unknown): Phrase {
  if (isApiError(error)) {
    const paths = error.issues.map(issuePath)
    const at = (prefix: string) => paths.some((path) => path === `body/${prefix}` || path.startsWith(`body/${prefix}/`) || path === `body.${prefix}`)
    if (error.kind === 'invalid') {
      if (at('correctStock')) return phrase('hd.measure.refused.adjust')
      if (at('measuredArea')) return phrase('hd.measure.refused.measured')
      if (at('declaredArea')) return phrase('hd.measure.refused.declared')
      if (at('measuredAt')) return phrase('hd.measure.refused.when')
    }
    if (error.kind === 'conflict') return phrase(error.code === 'invalid_state' ? 'hd.measure.refused.notWhole' : 'hd.measure.refused.notOnePlace')
    if (error.kind === 'forbidden' || error.kind === 'step_up') return phrase('hd.measure.refused.forbidden')
  }
  return withStock(writeProblem(error))
}

/** The Re-measure dialog (opened as "Measure again…" or as "Correct the area…": the stock correction ticked). */
export interface MeasureDialogModel {
  /** Opened from "Correct the area…": the correction is asked from the start. */
  correcting: boolean
  draft: MeasureDraft
  posting: boolean
  problem: Phrase | null
  done: MeasureRecorded | null
}

// ---- the tabs' model ------------------------------------------------------------------------------------------------------

export interface GradingModel {
  can: GradingCan
  view: Part<GradingView>
  measures: Part<MeasuresView>
  /** The Measurements & grade form; null until the hide is read. */
  gradeDraft: GradingDraft | null
  /** The Defects form; null until the hide is read. */
  defectsDraft: GradingDraft | null
  /** The tab whose correction is being sent. */
  saving: GradingTab | null
  /** The last refused correction, on its tab. */
  problem: { tab: GradingTab; phrase: Phrase } | null
  /** The last correction saved, on its tab (a notice). */
  saved: GradingTab | null
  /** The hide changed meanwhile (live) while a form was being edited: the form keeps what was typed, Apply is refused as stale. */
  changedMeanwhile: boolean
  measure: MeasureDialogModel | null
}

export interface GradingActions {
  onDraft?: (tab: GradingTab, draft: GradingDraft) => void
  onApply?: (tab: GradingTab) => void
  onDiscard?: (tab: GradingTab) => void
  onRetry?: () => void
  onRetryMeasures?: () => void
  onDismissNotice?: () => void
  onMeasureOpen?: (correcting: boolean) => void
  onMeasureDraft?: (draft: MeasureDraft) => void
  onMeasureSave?: () => void
  onMeasureClose?: () => void
}

// ---- a change's lines (design hd-grade-history: from → to, why) -------------------------------------------------------------

export const CHANGE_FIELDS = ['grade', 'shade', 'thicknessMm', 'defects'] as const
export type ChangeField = (typeof CHANGE_FIELDS)[number]

/** The fields a change touched, in a fixed order, with from → to (null: none). */
export function changeLines(change: Pick<GradingChange, 'from' | 'to'>): { field: ChangeField; from: string | null; to: string | null }[] {
  return CHANGE_FIELDS.filter((field) => field in change.from || field in change.to).map((field) => ({ field, from: change.from[field] ?? null, to: change.to[field] ?? null }))
}

/** Where a change was made, in words (a key of `warehouse-lots`): the office, the floor, the system. */
export function audienceKey(audience: string): string {
  const known = audience.toLowerCase()
  return known === 'office' || known === 'floor' || known === 'system' ? `hd.grading.changes.by.${known}` : 'hd.grading.changes.by.other'
}
