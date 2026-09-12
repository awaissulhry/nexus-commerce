/**
 * PES.7 — reading the product event log. Pure, tested.
 *
 * Written against the LIVE payload of `GET /products/:id/events`, measured across the full 157
 * events on GALE-JACKET rather than from the old tab's assumptions:
 *
 * | eventType | n | data | metadata |
 * |---|---|---|---|
 * | `IMAGES_UPDATED` | 76 | `{source, imageId, wasType}` | none |
 * | `FLAT_FILE_IMPORTED` | 72 | `{channel, marketplace, region, channelListingId}` | `{source, flatFileType}` |
 * | `BULK_OP_APPLIED` | 9 | `{bulkOperationId, fields[]}` | `{ip, source, bulkOperationId}` |
 *
 * 🔴 **Only `BULK_OP_APPLIED` carries a per-field delta.** The old tab's framing was
 * "flat-file imports expandable to per-field delta", and on this product a flat-file event carries
 * no field data whatsoever — expanding one would open an empty drawer and imply the detail was
 * lost. So a row is expandable only when there is something behind it, and a row without a delta
 * says what it *does* know instead.
 *
 * 🔴 **No raw enum ever reaches the screen.** `FLAT_FILE_IMPORTED` is not a sentence.
 */

export interface ProductEvent {
  id: string
  aggregateId: string
  aggregateType: string
  eventType: string
  data: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

export type EventKind = 'images' | 'import' | 'bulk' | 'other'

export interface FieldChange { field: string; value: unknown }

export interface EventReading {
  kind: EventKind
  /** The sentence shown on the row. Never the raw `eventType`. */
  title: string
  /** The secondary line — what this event knows about itself. */
  detail: string | null
  /** Present only when the event genuinely carries a per-field delta. */
  fields: FieldChange[] | null
  /** Who, when the record says. `null` means the log does not know — not "the system". */
  actor: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** How an image event describes itself. The `source` field is a vocabulary, not free text. */
function imageAction(source: string | null): string {
  switch (source) {
    case 'upload-cloudinary': return 'Image uploaded'
    case 'upload-video': return 'Video uploaded'
    case 'delete': return 'Image removed'
    case 'reorder': return 'Images reordered'
    case 'import-from-dam': return 'Image imported from the asset library'
    case 'derive': return 'Image derived from another'
    case 'patch-metadata': return 'Image details edited'
    // An unrecognised source is reported as itself rather than folded into a familiar verb —
    // a new source added upstream must not silently read as an upload.
    default: return source ? `Image changed (${source})` : 'Image changed'
  }
}

export function readEvent(event: ProductEvent): EventReading {
  const data = event.data ?? {}
  const meta = event.metadata ?? {}
  const actor = str(meta.source) === 'OPERATOR' ? 'An operator' : str(meta.source)

  switch (event.eventType) {
    case 'IMAGES_UPDATED': {
      const wasType = str(data.wasType)
      return {
        kind: 'images',
        title: imageAction(str(data.source)),
        detail: wasType ? `${wasType} slot` : null,
        fields: null,
        actor: null,
      }
    }
    case 'FLAT_FILE_IMPORTED': {
      const channel = str(data.channel)
      const market = str(data.marketplace) ?? str(data.region)
      const kindOfFile = str(meta.flatFileType)
      return {
        kind: 'import',
        title: 'Flat-file import',
        // Everything this event actually knows. It carries no field-level detail, so none is
        // implied by offering an expander that would open empty.
        detail: [channel, market, kindOfFile].filter(Boolean).join(' · ') || null,
        fields: null,
        actor: null,
      }
    }
    case 'BULK_OP_APPLIED': {
      const raw = Array.isArray(data.fields) ? data.fields : []
      const fields = raw
        .map((f) => (typeof f === 'object' && f !== null ? f as FieldChange : null))
        .filter((f): f is FieldChange => !!f && typeof f.field === 'string')
      return {
        kind: 'bulk',
        title: fields.length === 1
          ? `Bulk edit · ${fields[0].field}`
          : `Bulk edit · ${fields.length} fields`,
        detail: null,
        fields: fields.length > 0 ? fields : null,
        actor,
      }
    }
    default:
      return {
        kind: 'other',
        // Humanised, but honest that we do not have a specific rendering for it.
        title: event.eventType.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        detail: null,
        fields: null,
        actor,
      }
  }
}

/** How a value reads in a delta. `null` is a cleared field, which is not the string "null". */
export function readValue(value: unknown): string {
  if (value === null || value === undefined) return 'cleared'
  if (typeof value === 'string') return value.length > 0 ? value : 'empty'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  return JSON.stringify(value)
}

export interface EventGroup {
  id: string
  reading: EventReading
  events: ProductEvent[]
  at: string
  /** True when this row stands for more than one event. */
  grouped: boolean
}

/** Events this close together, of the same type, are one act by the operator. */
const GROUP_WINDOW_MS = 60_000

/**
 * Collapse bursts.
 *
 * 🔴 A group states its own size. 72 flat-file events arriving in pairs are 36 acts, and a list
 * that silently shows one row per pair has hidden half the record; a row that says "2 events"
 * has summarised it. The distinction is the whole difference between grouping and dropping.
 */
export function groupEvents(events: readonly ProductEvent[]): EventGroup[] {
  const out: EventGroup[] = []
  for (const event of events) {
    const last = out[out.length - 1]
    const sameKind = last && last.events[0].eventType === event.eventType
    const closeEnough = last
      && Math.abs(new Date(last.at).getTime() - new Date(event.createdAt).getTime()) <= GROUP_WINDOW_MS
    // A delta-carrying event is never merged away — its fields are the point of the row.
    const mergeable = sameKind && closeEnough && event.eventType !== 'BULK_OP_APPLIED'
    if (mergeable && last) {
      last.events.push(event)
      last.grouped = true
      continue
    }
    out.push({ id: event.id, reading: readEvent(event), events: [event], at: event.createdAt, grouped: false })
  }
  return out
}

export interface ActivitySummary {
  total: number
  byKind: Record<EventKind, number>
  firstAt: string | null
  lastAt: string | null
}

export function summariseActivity(events: readonly ProductEvent[]): ActivitySummary {
  const byKind: Record<EventKind, number> = { images: 0, import: 0, bulk: 0, other: 0 }
  for (const e of events) byKind[readEvent(e).kind]++
  const times = events.map((e) => e.createdAt).sort()
  return {
    total: events.length,
    byKind,
    firstAt: times[0] ?? null,
    lastAt: times[times.length - 1] ?? null,
  }
}
