/**
 * AE.4 — the field-state rule of live product sync, with no database (contract
 * docs/2026-09-19-shared-stock-build.md §6.1).
 *
 * A link keeps, for every followed field, a PAIR of fingerprints taken when it was last applied: the
 * source value it applied, and the follower value right after. Two fingerprints, never one: the
 * follower's field contracts may store a value in its own form (a trimmed text, a rounded number), and
 * comparing the source with the follower directly would then read every such field as an edit.
 *
 *   follower value ≠ its fingerprint            → OVERRIDE: the follower edited it; kept, never written
 *   follower same, source ≠ its fingerprint     → APPLY the source value
 *   both the same                               → nothing to do
 *   no fingerprint yet (a link made before this) → equal values are recorded; a differing value is
 *                                                  applied only where the follower's field is empty
 *                                                  (filling a blank overwrites nothing); otherwise it
 *                                                  is an override — never overwrite without evidence.
 *
 * Fingerprints compare within one business: the source's with the source's, the follower's with the
 * follower's. Only a field with no fingerprint compares the two businesses, so values that name a
 * record by its id (categories) compare by what does not differ between businesses (the slug path).
 */
import { createHash } from 'node:crypto'
import { transferCanonical, type TransferRow } from '@nexus/shared/catalog-transfer'

/** [source fingerprint as applied, follower fingerprint right after]. */
export type Pair = [source: string, target: string]

export interface MediaEntry {
  /** The source image id, and the follower's copy of it. */
  source: string
  target: string
  /** Fingerprint of the source image's file (its address) as applied. */
  file: string
  /** Fingerprint of its text and placement as applied. */
  meta: string
}

export interface MediaState {
  /** The follower's whole image set right after the last apply. A different set: the follower edited its images. */
  target: string
  map: MediaEntry[]
}

export interface AppliedState {
  v: 1
  fields: Record<string, Pair>
  media?: MediaState
}

export const emptyState = (): AppliedState => ({ v: 1, fields: {} })

export function readState(value: unknown): AppliedState {
  const state = value as Partial<AppliedState> | null
  if (!state || state.v !== 1 || typeof state.fields !== 'object' || state.fields === null) return emptyState()
  return { v: 1, fields: { ...state.fields }, ...(state.media ? { media: { target: state.media.target, map: [...state.media.map] } } : {}) }
}

export const fingerprint = (value: unknown): string => createHash('sha256').update(transferCanonical(value)).digest('hex').slice(0, 32)

/** A field that one export does not carry at all (a language with no text of its own). */
export const ABSENT = fingerprint({ absent: true })
const EMPTY = new Set([ABSENT, fingerprint({ action: 'CLEAR' }), fingerprint({ action: 'INHERIT' }), fingerprint({ action: 'SET', value: null })])
export const isEmpty = (print: string) => EMPTY.has(print)

/** A field's key: its master-sheet key, with its language for a translation. */
export const fieldKey = (row: Pick<TransferRow, 'field' | 'locale'>) => (row.locale ? `${row.field}@${row.locale}` : row.field)

/**
 * The comparable value of one exported row. Category ids differ per business, so they compare by slug
 * path. An inherited language row compares by its ownership alone: the text it shows is its parent's,
 * which follows through the parent's own link.
 */
export function rowValue(row: TransferRow, pathOf: (categoryId: string) => string | null): unknown {
  if (row.action === 'INHERIT') return { action: 'INHERIT' }
  if (row.action === 'CLEAR') return { action: 'CLEAR' }
  if (row.field === 'categoryIds') {
    const ids = Array.isArray(row.value) ? row.value : []
    return { action: 'SET', value: ids.map((id) => pathOf(String(id)) ?? `?${String(id)}`).sort() }
  }
  if (row.field === 'primaryCategoryId') return { action: 'SET', value: pathOf(String(row.value)) ?? `?${String(row.value)}` }
  return { action: 'SET', value: row.value ?? null }
}

/** key → fingerprint, for the Products rows of one product. */
export function rowPrints(rows: TransferRow[], pathOf: (categoryId: string) => string | null): Map<string, string> {
  const prints = new Map<string, string>()
  for (const row of rows) if (row.entity === 'Products') prints.set(fieldKey(row), fingerprint(rowValue(row, pathOf)))
  return prints
}

export type Decision = 'same' | 'apply' | 'override' | 'record'

/**
 * "Follow again": the follower's fingerprint is "whatever this business holds now", and the source's is
 * none — so the next run applies the source's value over it.
 */
export const FOLLOW_AGAIN = '*'

export function decide(input: { source: string; target: string; applied: Pair | undefined; overridden: boolean }): Decision {
  if (input.overridden) return 'override'
  const { applied } = input
  if (!applied) {
    if (input.source === input.target) return 'record'
    return isEmpty(input.target) ? 'apply' : 'override'
  }
  if (applied[1] !== FOLLOW_AGAIN && input.target !== applied[1]) return 'override'
  if (input.source !== applied[0]) return 'apply'
  return 'same'
}

// ── Images ──────────────────────────────────────────────────────────────────────────────────

export interface ImageFacts {
  id: string
  url: string
  alt: string | null
  type: string
  isPrimary: boolean
  sortOrder: number
  /** The language of the text in the photo (`zxx` = no text) and its language-version group. */
  languageTag?: string
  versionGroupId?: string | null
}

/**
 * The file of a source image: its address. A stored file gets a new address when its bytes change
 * (the storage versions it), so a new address is a new file, and the same address is the same file.
 */
export const imageFilePrint = (image: Pick<ImageFacts, 'url'>) => fingerprint({ file: image.url })
/**
 * Its text and placement, and the language of the text in it. The order among images is NOT followed: the
 * follower may keep images of its own between the copies. A photo with no text and no language versions prints
 * as before the language was followed, so a link made then sees no change; one with a language prints it, so a
 * copy that arrived as "no text" is corrected by the next sync.
 */
export const imageMetaPrint = (image: Pick<ImageFacts, 'alt' | 'type' | 'isPrimary' | 'languageTag' | 'versionGroupId'>) => {
  const language = image.languageTag && image.languageTag !== 'zxx' ? { language: image.languageTag } : {}
  const versions = image.versionGroupId ? { versions: image.versionGroupId } : {}
  return fingerprint({ alt: image.alt ?? null, type: image.type, primary: image.isPrimary, ...language, ...versions })
}

/** The follower's whole image set: any change to it (added, removed, edited, reordered) is an edit. */
export const followerMediaPrint = (images: ImageFacts[]) =>
  fingerprint([...images].sort((a, b) => a.id.localeCompare(b.id)).map((i) => [i.id, i.url, i.alt ?? null, i.type, i.isPrimary, i.sortOrder]))

export interface MediaPlan {
  add: ImageFacts[]
  /** A follower copy whose source image is gone, or whose file changed (it is copied again). */
  remove: MediaEntry[]
  /** Same file, new text or placement. */
  update: Array<{ source: ImageFacts; entry: MediaEntry }>
}

/** What the follower's copies must do to match the source's images again. */
export function planMedia(source: ImageFacts[], map: MediaEntry[]): MediaPlan {
  const bySource = new Map(map.map((entry) => [entry.source, entry]))
  const current = new Map(source.map((image) => [image.id, image]))
  const plan: MediaPlan = { add: [], remove: [], update: [] }
  for (const entry of map) if (!current.has(entry.source)) plan.remove.push(entry)
  for (const image of source) {
    const entry = bySource.get(image.id)
    if (!entry) plan.add.push(image)
    else if (entry.file !== imageFilePrint(image)) { plan.remove.push(entry); plan.add.push(image) }
    else if (entry.meta !== imageMetaPrint(image)) plan.update.push({ source: image, entry })
  }
  return plan
}
