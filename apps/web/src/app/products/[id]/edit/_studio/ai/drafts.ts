/**
 * PES.8 — the pure half of the review surface: indexing, grouping, and the display of a value.
 *
 * Kept free of React and of `fetch` so the rules that matter can be tested without a server: which
 * drafts a column offers, which of them an "approve column" would actually send, and how a value
 * that is a list renders beside one that is a string.
 */
import type { AiDraft, AiDraftViolation } from './types'

/** How the sheet addresses a cell: the row is a product, the column is the sheet column key. */
export interface CellRef {
  rowId: string
  colId: string
}

/**
 * PES.2's `ProvenanceLike` fields for one cell. The classifier reads only these two; supplying
 * them is this lane's whole contribution to how a drafted cell is drawn.
 */
export interface AiProvenance {
  aiDrafted: boolean
  aiStale: boolean
}

/**
 * `productId` + `columnKey` — the key the sheet can ask by.
 *
 * The separator is NUL, written as an ESCAPE and never as a literal byte. NUL is the right
 * separator — a product id or a column key can contain a space or a colon, neither can contain
 * NUL, so the key cannot collide — but a raw 0x00 in the source made this whole file read as
 * `data` to `file(1)`, so a plain `grep` found nothing in it and the exported types looked absent.
 * PES.2 nearly concluded the contract did not exist. Same value at runtime, plain text on disk.
 */
export function cellIndexKey(rowId: string, colId: string): string {
  return `${rowId}\u0000${colId}`
}

/**
 * Index the pending drafts by (product, column).
 *
 * `failed` drafts are indexed too but never marked drafted on the grid: the model broke a hard cap,
 * so there is no value to show in the cell. They surface in the review list, where the violation
 * can be read, rather than tinting a cell with something nobody can approve.
 */
export function indexDrafts(drafts: AiDraft[]): Map<string, AiDraft> {
  const out = new Map<string, AiDraft>()
  for (const d of drafts) {
    // One pending draft per cell is a server invariant (recordDrafts supersedes), but the client
    // must not fall over if it ever sees two — newest wins, deterministically.
    const key = cellIndexKey(d.productId, d.columnKey)
    const prev = out.get(key)
    if (!prev || d.createdAt > prev.createdAt) out.set(key, d)
  }
  return out
}

/**
 * The provenance a cell should carry. `null` when nothing is drafted there, so the caller can leave
 * the cell's existing provenance untouched rather than overwriting it with a negative.
 */
export function provenanceFor(index: Map<string, AiDraft>, ref: CellRef): AiProvenance | null {
  const d = index.get(cellIndexKey(ref.rowId, ref.colId))
  if (!d) return null
  // A failed draft is not a drafted VALUE — there is nothing in the cell to approve.
  if (d.status !== 'pending') return null
  return { aiDrafted: true, aiStale: d.stale || d.unverified }
}

/**
 * The shape PES.2's cell renderer takes (`BuildColumnsOptions['draftFor']`). Narrower than our own
 * `AiDraft` on purpose: the cell needs the proposal, the value it would replace, the two warning
 * states and the reasons — nothing else.
 */
export interface SheetAiDraft {
  draftValue: unknown
  baseValue?: unknown
  stale?: boolean
  unverified?: boolean
  violations?: string[]
}

/**
 * Project a draft onto the cell renderer's shape, or `null` when it must not reach a cell.
 *
 * 🔴 A failed draft returns null. The cell shows a proposal an operator can act on; a draft that
 * broke a hard cap is not one, because the server refuses to apply it. It stays in the review
 * list, where the cap it broke can actually be read.
 */
export function toSheetDraft(d: AiDraft): SheetAiDraft | null {
  if (d.status !== 'pending') return null
  return {
    draftValue: d.draftValue,
    baseValue: d.baseValue,
    stale: d.stale,
    unverified: d.unverified,
    violations: (d.violations ?? []).map((v) => v.message),
  }
}

/** A draft an operator can act on right now, without waiving anything. */
export function isCleanlyApprovable(d: AiDraft): boolean {
  return d.status === 'pending' && !d.stale && !d.unverified
}

/**
 * Drafts grouped by column, which is how the review reads: an operator judging thirty titles
 * judges them against each other, not against thirty unrelated fields.
 */
export interface DraftColumnGroup {
  columnKey: string
  writeField: string
  drafts: AiDraft[]
  /** Approvable without waiving staleness — what "approve column" would send. */
  approvable: AiDraft[]
  staleCount: number
  failedCount: number
  unverifiedCount: number
  /** The tightest cap any draft in this column was written against, for the header. */
  caps: { maxLength?: number | null; maxBytes?: number | null; capFrom?: string | null } | null
}

export function groupByColumn(drafts: AiDraft[]): DraftColumnGroup[] {
  const byCol = new Map<string, AiDraft[]>()
  for (const d of drafts) {
    const list = byCol.get(d.columnKey) ?? []
    list.push(d)
    byCol.set(d.columnKey, list)
  }
  const groups: DraftColumnGroup[] = []
  for (const [columnKey, list] of byCol) {
    const sorted = [...list].sort((a, b) => a.productId.localeCompare(b.productId))
    const withCaps = sorted.find((d) => d.capsUsed && (d.capsUsed.maxLength || d.capsUsed.maxBytes))
    groups.push({
      columnKey,
      writeField: sorted[0].writeField,
      drafts: sorted,
      approvable: sorted.filter(isCleanlyApprovable),
      staleCount: sorted.filter((d) => d.status === 'pending' && d.stale).length,
      failedCount: sorted.filter((d) => d.status === 'failed').length,
      unverifiedCount: sorted.filter((d) => d.unverified).length,
      caps: withCaps?.capsUsed
        ? {
            maxLength: withCaps.capsUsed.maxLength,
            maxBytes: withCaps.capsUsed.maxBytes,
            capFrom: withCaps.capsUsed.capFrom,
          }
        : null,
    })
  }
  return groups.sort((a, b) => a.columnKey.localeCompare(b.columnKey))
}

/**
 * Render a cell value for the diff.
 *
 * A list is shown one member per line because that is how a bullet set is read and how an operator
 * spots the one bullet that is wrong. Never truncated: this is the review, and a value the operator
 * cannot see in full is a value they cannot judge.
 */
export function displayValue(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.map((x) => (x == null ? '' : String(x))).join('\n')
  if (typeof v === 'object') return JSON.stringify(v, null, 2)
  return String(v)
}

/** True when the two sides of the diff are the same text — nothing to review. */
export function isNoOpDiff(d: AiDraft): boolean {
  return displayValue(d.draftValue) === displayValue(d.baseValue)
}

/** Errors block the offer; warnings ride along and are shown beside the value. */
export function splitViolations(v: AiDraftViolation[] | null): {
  errors: AiDraftViolation[]
  warnings: AiDraftViolation[]
} {
  const all = v ?? []
  return {
    errors: all.filter((x) => x.severity === 'error'),
    warnings: all.filter((x) => x.severity === 'warn'),
  }
}

/** Character and UTF-8 byte length of a rendered value, against the caps it was held to. */
export function measure(value: unknown): { chars: number; bytes: number } {
  const s = displayValue(value)
  return { chars: s.length, bytes: new TextEncoder().encode(s).length }
}
