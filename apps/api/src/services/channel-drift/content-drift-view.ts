/**
 * E5a (Etsy publisher, 2026-10-05) — what the product sheet shows of a content read-back: the stored `ChannelDrift`
 * of ONE source, per listing, for the Listing ID cell's "Differs on Etsy" mark.
 *
 * A view, never a verdict of its own: the mark appears only when the source's own clock says its LAST read compared
 * (`outcome: 'compared'`, with a valid time) and that read counted at least one differing field. A listing never read,
 * read without a comparison (`not_compared`), or read clean returns nothing, so the sheet shows nothing — "Differs"
 * never stands for "not checked", and "no mark" never claims "checked and clean".
 *
 * The count includes differences an EARLIER read found that the last read did not compare (the writer keeps them). Each
 * field therefore carries the time of the read that found it (the entry's own `checkedAt`), and `lastRead` says how many
 * the last read itself found: the sheet never credits an older find to the last read's time.
 *
 * ONE query for every listing of the sheet (no per-row read); an empty list makes none. The source is a parameter so
 * eBay's and Amazon's content reads can reach their sheets later with one line (E5 §7 Q1: Etsy only for now).
 */
import prisma from '../../db.js'
import { etsyFieldLabel } from '../pim/studio-publication-etsy-problems.js'
import { PHOTO_COUNT_FIELD } from './etsy-content-compare.js'

export interface SheetContentDrift {
  source: string
  /** When the source's last read ran (a read that compared). */
  checkedAt: string
  /** Every differing field the source holds for this listing — the true count, before any cap. */
  differing: number
  /**
   * How many of them that last read itself found (the writer stamps each fresh entry with the read's own time). The rest
   * were found by an EARLIER read and the last read did not compare them (a field it compares is cleared or re-stamped),
   * so they are never credited to the last read's time (E5a review MINOR-10).
   */
  lastRead: number
  /** Up to 8 by name, the last read's first; `foundAt` = when the read that found it ran (null: no valid time stored). */
  fields: Array<{ field: string; label: string; foundAt: string | null }>
}

/** At most this many differing fields are named on the wire; the hover says "and N more" for the rest. */
export const SHEET_DRIFT_FIELDS_SHOWN = 8

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
/** The overwrite evidence's own rule (`studio-publication-overwrite.ts`): an ISO time that parses. */
const timestamp = (value: unknown): string | null => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : null
const named = (value: unknown): string | null => {
  const name = record(value).property_name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

/**
 * The words for one stored field: a listing field by the sheet's column label (`taxonomy_id` → "Category"), an attribute
 * by the name either side holds, a translation by its language, the photo count by name.
 */
export function contentDriftFieldLabel(field: string, entry: { ours?: unknown; theirs?: unknown } = {}): string {
  const property = /^property:(\d+)$/.exec(field)
  if (property) return named(entry.ours) ?? named(entry.theirs) ?? `Attribute ${property[1]}`
  if (field.startsWith('translation:') && field.length > 'translation:'.length) return `Translation (${field.slice('translation:'.length)})`
  if (field === PHOTO_COUNT_FIELD) return 'Photo count'
  return etsyFieldLabel(field)
}

/** PURE — one stored `ChannelDrift` row as the sheet's view of `source`, or null when that source's last read shows no difference. */
export function contentDriftView(row: { driftedFields: unknown; checkedBySource: unknown }, source: string): SheetContentDrift | null {
  const clock = record(record(row.checkedBySource)[source])
  const at = timestamp(clock.at)
  if (!at || clock.outcome !== 'compared') return null
  const entries = (Array.isArray(row.driftedFields) ? row.driftedFields : []).map(record)
    .filter(entry => entry.source === source && typeof entry.field === 'string' && entry.field.trim() !== '')
  const differing = count(clock.differing) ?? entries.length
  if (differing <= 0) return null
  const seen = new Set<string>()
  const all: SheetContentDrift['fields'] = []
  for (const entry of entries) {
    const field = entry.field as string
    if (seen.has(field)) continue
    seen.add(field)
    all.push({ field, label: contentDriftFieldLabel(field, entry), foundAt: timestamp(entry.checkedAt) })
  }
  // The last read's own finds first, then the earlier ones newest first (a time not stored: last).
  const rank = (f: SheetContentDrift['fields'][number]) => f.foundAt === at ? Number.POSITIVE_INFINITY : f.foundAt ? Date.parse(f.foundAt) : Number.NEGATIVE_INFINITY
  const ordered = all.map((f, i) => ({ f, i })).sort((a, b) => rank(b.f) - rank(a.f) || a.i - b.i).map(({ f }) => f)
  const lastRead = Math.min(differing, all.filter(f => f.foundAt === at).length)
  return { source, checkedAt: at, differing, lastRead, fields: ordered.slice(0, SHEET_DRIFT_FIELDS_SHOWN) }
}

/** Every listing among `listingIds` whose last `source` read differs from Nexus, keyed by listing id. One query. */
export async function contentDriftByListing(listingIds: string[], source: string): Promise<Map<string, SheetContentDrift>> {
  const views = new Map<string, SheetContentDrift>()
  const ids = [...new Set(listingIds.filter(id => typeof id === 'string' && id))]
  if (!ids.length) return views
  const rows = await prisma.channelDrift.findMany({
    where: { channelListingId: { in: ids } },
    select: { channelListingId: true, driftedFields: true, checkedBySource: true },
  })
  for (const row of rows) {
    const view = contentDriftView(row, source)
    if (view) views.set(row.channelListingId, view)
  }
  return views
}
