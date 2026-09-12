/** Shared family projection facts from /studio/family. */
import { projectionMeta, type ProjectionState } from '@/design-system/grid/renderers/projection'
import type { RowReadinessState } from '@/design-system/grid/renderers/readiness'

/* ── the shape, §5.1's `channels` + `projections` ─────────────────────────────────────────── */

/** One column of the CHANNEL PROJECTIONS group. */
export interface ProjectionChannel {
  accountId?: string | null
  /** `AMAZON`, `EBAY`, … */
  channel: string
  /** `IT`, or `GLOBAL` for a webstore. */
  market: string
  /** `Amazon · IT` — the header, from the server. Never assembled here. */
  label: string
  /**
   * The marketplace is configured WITH an active account.
   *
   * 🔴 Not "this family has a listing there". An unconnected channel still gets a column so the
   * absence is visible (§3.3); a connected channel a variant is simply not on reads `Excluded`,
   * which is a different fact and a different verb.
   */
  connected: boolean
  /** `AMAZON:IT` — the key every row's projections are keyed by. */
  key: string
}

/** One row against one coordinate. */
export interface RowProjection {
  projectionState?: ProjectionState
  /** The child has a `ChannelListing` row on this coordinate (§5: inclusion IS that row). */
  included: boolean
  published: boolean
  /** The server's per-coordinate row readiness, or `null` when there is none to report. */
  state: RowReadinessState | null
  externalId: string | null
}

/**
 * One shared axis, as §5.1 states it.
 *
 * 🔴 `key` is the STORED axis name, and on the real catalogue it is NOT a sheet column key —
 * measured on GALE-JACKET 2026-09-11: the family's axes are `Colore` and `Taglia`, and the sheet
 * returns 235 columns with no `Colore` and no `Taglia` among them, case-insensitively. So an axis
 * key is a key into `axisValues`, never an assumed column id. See `columns.tsx` for what that costs.
 */
export interface FamilyAxis {
  valueOrder?: string[]
  key: string
  label: string
  /** Value codes in the order the server states. May be incomplete — see `axisSummary`. */
  values: string[]
  /**
   * The ATTRIBUTE key this axis is stored under — `Colore` is stored as `Color`, `Taglia` as `Size`.
   *
   * 🔴 This is the bridge between an axis and its sheet COLUMN, and it is the server's own field, not
   * a table copied across the app boundary. The API canonicalises both sides
   * (`variant-attribute-keys.ts`: `colore → color`, `taglia → size`) before setting
   * `SheetColumn.axis`, so a client re-deriving that mapping would be a fork of a rule that already
   * has one home. `storedKey` lets the pairing be a case-insensitive match on a value the server
   * supplies.
   */
  storedKey?: string
}

export interface FamilyProjections {
  version?: number
  suspect?: Record<string, Array<{ axisKey: string; reason: string }>>
  source: 'studio'
  channels: ProjectionChannel[]
  /** productId → coordinate key → projection. A missing entry is "no listing", never "unknown". */
  byProduct: Record<string, Record<string, RowProjection>>
  /** coordinate key → how many DISTINCT listings the family has there (eBay's "1 listing"). */
  listingsPerChannel: Record<string, number>
  /**
   * The family's axes, in stored order. EMPTY on the derived read: the catalogue response has no
   * axis information at all, and an empty list is the honest answer rather than a guess.
   */
  axes: FamilyAxis[]
  /**
   * productId → axis key → value code.
   *
   * 🔴 This is the ONLY source of a variant's axis values that actually answers. The studio SHEET
   * carries `axisValues: {}` on every row and `null` in its `color`/`size` cells (measured, 20 of
   * 20 children on GALE-JACKET), so a page reading the sheet for them draws an empty AXES group
   * beside a family that plainly varies by two.
   */
  axisValues: Record<string, Record<string, string>>
  /**
   * productId → the row's face image.
   *
   * Same reason as `axisValues`: the studio sheet's own contract does not supply `imageUrl` (its
   * type says so in as many words), and the family read does — with `imageInherited` saying whose
   * picture it is, which is not cosmetic when a quarter of children have none of their own.
   */
  images: Record<string, { url: string | null; inherited: boolean }>
}

export const EMPTY_PROJECTIONS: FamilyProjections = { source: 'studio', channels: [], byProduct: {}, listingsPerChannel: {}, axes: [], axisValues: {}, images: {} }

/* ── the five states (VP.5's vocabulary) ──────────────────────────────────────────────────── */

/**
 * Which of §9's five words this row says about this coordinate.
 *
 * 🔴 It returns VP.5's `ProjectionState` and nothing else: the WORD, the TONE, the dot shape and
 * the hint all come from `projectionMeta()` in the DS, whose tones are themselves read from
 * `readinessMeta()`. Deciding any of those here would be the local colour map §3.3 forbids, one
 * indirection further out.
 *
 * The order is the design's. Not-set-up beats everything (there is no channel to be on), exclusion
 * beats readiness (an excluded variant's missing fields are nobody's problem), and a readiness
 * complaint beats "Listed" — a live listing carrying a value the channel rejects is not fine.
 */
export function projectionState(channel: ProjectionChannel, projection: RowProjection | undefined): ProjectionState {
  if (projection?.projectionState) return projection.projectionState
  if (!channel.connected) return 'not-set-up'
  if (!projection?.included) return 'excluded'
  if (projection.state === 'missing' || projection.state === 'errors') return 'needs-value'
  return projection.published ? 'listed' : 'draft'
}

/** The cell VALUE — the include flag, which is what AG's fill handle carries down a column. */
export function projectionIncluded(channel: ProjectionChannel, projection: RowProjection | undefined): boolean | null {
  if (!channel.connected) return null
  return projection?.included === true
}

/**
 * The PARENT row's note beside the channel identity (§3.3: "the channel parent identity + a muted
 * note").
 *
 * 🔴 Channel VOCABULARY, and it moves to VP.2's `vocabulary` block the moment §5.4 exposes one —
 * the same class of fact as `axisNoun`. It is here rather than inlined so there is one place to
 * move. Amazon's family record is a real parent ASIN; eBay has no parent item at all, so the
 * identifier IS the single multi-variation listing and the honest note is how many there are;
 * everywhere else the identifier is the channel's product id and the useful note is its state.
 */
export function parentIdentityNote(channel: ProjectionChannel, listings: number, state: ProjectionState): string {
  if (channel.channel === 'AMAZON') return 'Parent ASIN'
  if (channel.channel === 'EBAY') return `${listings} ${listings === 1 ? 'listing' : 'listings'}`
  return projectionMeta(state).label
}

/* ── merging the two sources of a row's axis values ───────────────────────────────────────── */

/**
 * The row's axis values, keyed by the AXIS keys the columns use.
 *
 * 🔴 This function exists because of a defect it now prevents, and the defect is worth stating: the
 * two sources use DIFFERENT KEY VOCABULARIES for the same field name.
 *
 *   `/studio/family`  children[].axisValues  `{ Colore: 'Nero', Taglia: 'XS' }`   ← the AXIS keys
 *   `/studio/sheet`   rows[].axisValues      `{ Color: 'Nero',  Size:   'XS' }`   ← the COLUMN keys
 *
 * Measured on GALE-JACKET: the sheet carries that object on exactly TWO of its twenty-one rows and
 * `{}` on the rest. My first merge said "use the family read only where the sheet is empty" — a rule
 * that sounds conservative and is wrong here, because on those two rows the sheet was not empty, it
 * was keyed differently. The grid then looked up `Colore` in an object keyed `Color`, found nothing,
 * and drew `—` on two variants that have values; `orderByAxisValues` sorted them last as
 * value-less, the `Missing axis values` chip claimed 2 variants that were missing nothing, and
 * `Duplicate combinations` claimed 0 where the server's own coverage reports 2 real pairs. One wrong
 * merge, three wrong numbers on screen, and every one of them looked plausible.
 *
 * So the resolution is per AXIS KEY and the family read wins: it is the source whose keys ARE the
 * axis keys. The sheet is consulted under the same key only as a fallback, for a family whose axes
 * happen to be spelled like its columns.
 */
export function mergeAxisValues(
  axisKeys: readonly string[],
  stated: Record<string, string> | undefined,
  fromSheet: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of axisKeys) {
    const value = stated?.[key] ?? fromSheet?.[key]
    if (typeof value === 'string' && value.trim()) out[key] = value
  }
  return out
}

/* ── the toolbar's chips ──────────────────────────────────────────────────────────────────── */

/** Variants excluded from at least one CONNECTED channel — §3.2's first chip. */
export function excludedSomewhere(projections: FamilyProjections, childIds: readonly string[]): string[] {
  const live = projections.channels.filter(c => c.connected)
  if (live.length === 0) return []
  return childIds.filter(id => live.some(c => !projections.byProduct[id]?.[c.key]?.included))
}

const ROW_STATES = new Set<RowReadinessState>(['ready', 'missing', 'errors', 'live', 'unlisted'])

export function asRowState(state: unknown): RowReadinessState | null {
  return typeof state === 'string' && ROW_STATES.has(state as RowReadinessState) ? (state as RowReadinessState) : null
}
