/**
 * W3-6 (product sheet consistency, wave 3, 2026-10-05) — ONE column header for both sheet scopes.
 *
 * The Shared scope marked a required column with " *" and named who requires it, how long it may be and its help in the
 * header tooltip; the channel scopes showed the name and the help only (audit E15, B1). Both builders now ask this.
 *
 *   header  — the column's name, plus " *" when anyone requires it (paste drops the mark: `headerPaste.ts`).
 *   tooltip — "Required by eBay · IT (COAT only)" · "Max 80 characters" · "Max 2000 bytes" · the column's help.
 *
 * Owner decision 13: a column one product type of a mixed family requires keeps its "*", and the tooltip names the type
 * ("(COAT only)"). Pure `.ts` (no `@/design-system/grid` barrel), so the node suite reaches it.
 */
import { requirementLabel } from './master/columnRules'

export interface HeaderColumnLike {
  label: string
  group?: string
  requiredBy: string[]
  /** Product types that define the column (absent = every type). */
  applicableProductTypes?: string[]
  /** Product types for which a channel requires it (absent = every type). */
  requiredForProductTypes?: string[]
  maxLength?: number | null
  maxBytes?: number | null
  capFrom?: string | null
  helpText?: string | null
  familyRules?: Record<string, { required: boolean; sortOrder: number }>
}

export interface SheetColumnHeaderOptions {
  /** Name whose cap it is ("Max 80 characters (eBay · IT)"): the Shared scope, where several channels set caps. */
  capSource?: boolean
  /** The tooltip when the column has nothing else to say. */
  fallbackTooltip?: string
}

/** The types a channel requires the column for, when that is not every type the column applies to. */
export function requiredOnlyFor(col: Pick<HeaderColumnLike, 'applicableProductTypes' | 'requiredForProductTypes'>): string[] | null {
  const required = col.requiredForProductTypes ?? []
  if (required.length === 0) return null
  const applies = col.applicableProductTypes
  if (applies?.length && applies.every((type) => required.includes(type))) return null
  return [...required].sort()
}

/** Who requires the column, in user words: "the product family, Amazon · IT (COAT only)". Empty when nobody does. */
export function requirementSentence(col: HeaderColumnLike): string {
  const labels = [...new Set(col.requiredBy)]
  if (labels.length === 0) return ''
  const shared = labels.filter((label) => label === 'Master').map((label) => requirementLabel(col, label))
  const channels = labels.filter((label) => label !== 'Master')
  const only = requiredOnlyFor(col)
  const channelPart = channels.length ? `${channels.join(', ')}${only ? ` (${only.join(', ')} only)` : ''}` : ''
  return `Required by ${[...shared, channelPart].filter(Boolean).join(', ')}`
}

export function sheetColumnHeader(col: HeaderColumnLike, options: SheetColumnHeaderOptions = {}): { headerName: string; headerTooltip: string | undefined } {
  const tooltip = [
    requirementSentence(col) || null,
    col.maxLength ? `Max ${col.maxLength} characters${options.capSource && col.capFrom ? ` (${col.capFrom})` : ''}` : null,
    col.maxBytes ? `Max ${col.maxBytes} bytes` : null,
    col.helpText || null,
  ].filter(Boolean).join(' · ')
  return {
    headerName: col.label + (col.requiredBy.length > 0 ? ' *' : ''),
    headerTooltip: tooltip || options.fallbackTooltip || undefined,
  }
}
