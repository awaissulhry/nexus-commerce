import { MAX_TYPED_NUMBER_LENGTH, OVERRIDE_REASON_MIN, TYPED_NUMBER, isOverridableKind } from '@nexus/factory-domain/numbering/override'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { OVERRIDE_CODES, type DocumentKind, type NumberPreview, type OverrideCode } from './api'

/**
 * A document's number in a create dialog, and the popup "Type a number for a migrated document" (B-W2b-24; PLT-125; design
 * admin.documents popup `override`: "Number, why; clashes refused at once"), pure: what the line says (the number the
 * series would give now, NOT reserved; or the typed number in use), whether the popup's Use is held and why, and a refused
 * create in words. The rules themselves are factory-domain numbering/override's (the API checks them again).
 */

export const NAMESPACE = 'numbering'

export type PreviewRead = { readonly state: 'loading' } | { readonly state: 'ready'; readonly value: NumberPreview } | { readonly state: 'failed' }

export interface OverrideDraft {
  readonly kind: DocumentKind
  readonly number: string
  readonly reason: string
  /** The check of the number as typed: none yet, asking, nothing clashes, refused (with its code), or the check failed. */
  readonly check: 'idle' | 'checking' | 'ok' | 'refused' | 'failed'
  readonly refusal: OverrideCode | null
}

export interface NumberFieldModel {
  readonly kind: DocumentKind
  readonly preview: PreviewRead
  /** numbering.override over the company, and a kind a migrated document may keep its number for. */
  readonly canOverride: boolean
  /** The typed number in use (the old system's) with its reason, or null: the series' next number. */
  readonly typed: { readonly number: string; readonly reason: string } | null
  /** The popup, while it is open. */
  readonly dialog: OverrideDraft | null
}

export interface NumberFieldActions {
  onOpen?: () => void
  onClose?: () => void
  onNumber?: (text: string) => void
  onReason?: (text: string) => void
  onUse?: () => void
  /** Back to the series' number. */
  onClear?: () => void
}

export const emptyDraft = (kind: DocumentKind, typed: NumberFieldModel['typed'] = null): OverrideDraft => ({ kind, number: typed?.number ?? '', reason: typed?.reason ?? '', check: 'idle', refusal: null })

export const mayOverride = (kind: DocumentKind, held: boolean): boolean => held && isOverridableKind(kind)

/** The number as the server keeps it. */
export const typedOf = (text: string): string => text.trim()

/** Written as printed (the same shape the server checks), so the check is asked only for a number that could pass. */
export const wellFormed = (text: string): boolean => TYPED_NUMBER.test(typedOf(text))

/** Why "Use this number" is held (a key of `numbering`), or null. */
export function overrideHeld(draft: OverrideDraft): string | null {
  if (typedOf(draft.number) === '') return 'override.held.number'
  if (!wellFormed(draft.number)) return 'override.refusal.shape'
  if (draft.check === 'checking' || draft.check === 'idle') return 'override.held.checking'
  if (draft.check === 'failed') return 'override.held.failed'
  if (draft.check === 'refused') return `override.refusal.${draft.refusal ?? 'taken'}`
  if (draft.reason.trim().length < OVERRIDE_REASON_MIN) return 'override.held.reason'
  return null
}

/** What the number line says (a key of `numbering` and its params). */
export function lineWords(model: NumberFieldModel): { readonly key: string; readonly params?: Readonly<Record<string, string>> } {
  if (model.typed) return { key: 'line.typed', params: { number: model.typed.number, reason: model.typed.reason.trim() } }
  if (model.preview.state === 'loading') return { key: 'line.loading' }
  if (model.preview.state === 'failed') return { key: 'line.failed' }
  const preview = model.preview.value
  if (preview.held || preview.number === null) return { key: `line.held.${preview.held ?? 'noSeries'}` }
  if (preview.newPeriod) return { key: 'line.newPeriod', params: { number: preview.number, year: preview.scopeKey ?? '' } }
  return { key: 'line.preview', params: { number: preview.number } }
}

/** A create the API refused for the typed number: its code (`body/typedNumber/<code>`), else null. */
export function typedNumberRefusal(error: unknown): OverrideCode | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const parts = issuePath(issue).split(/[/.]/)
    const at = parts.indexOf('typedNumber')
    const code = at >= 0 ? parts[at + 1] : undefined
    if (code && (OVERRIDE_CODES as readonly string[]).includes(code)) return code as OverrideCode
  }
  return null
}

export { MAX_TYPED_NUMBER_LENGTH }
