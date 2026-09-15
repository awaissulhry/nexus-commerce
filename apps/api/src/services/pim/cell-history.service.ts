import { resolveWorkspaceDestination, workspaceListingWhere } from './workspace-destination.js'
import { workspaceMetadataWhere } from './workspace-history.js'
import type { Prisma } from '@prisma/client'
/**
 * PES.5 — per-cell history for the full-record drawer.
 *
 * ── What the data actually supports (measured 2026-09-01) ───────────────────
 * The layout promises "who / when / old→new / which layer, from the
 * override-audit table". The measurement said otherwise:
 *
 *   • `ChannelListingOverride` — the table the layout names — has 0 rows, and
 *     its only two writers in the whole API are the pricing routes. It is a
 *     PRICE audit trail, not a general one.
 *   • `PATCH /api/products/bulk` DOES keep a trail (`auditLogService.writeMany`,
 *     products.routes.ts) — 27 rows since 2026-05-06 — but it recorded only
 *     `after`, with `before` JSON-null and `userId` hardcoded null, and no
 *     channel/alias/locale coordinate.
 *
 * PES.5 enriched that write rather than adding a table (see the same file).
 * From that change forward the trail carries who, the previous value, and the
 * layer. Everything logged BEFORE it cannot be reconstructed — the old values
 * were never written down.
 *
 * ── So this service reports its own coverage ────────────────────────────────
 * `coverageSince` is the timestamp of the oldest entry that actually carries a
 * previous value. The drawer renders "no earlier history was recorded" rather
 * than an empty list, which would read as "this cell never changed". A history
 * panel that silently implies completeness it does not have is exactly the kind
 * of confidently-wrong surface this programme is removing.
 */
import { fieldsChangedIn } from './restore-points.service.js'
import { asDescriptor } from './audit-state.js'
import { CONTENT_COLUMNS } from './content-locale.js'
import { normalizeLanguage } from './content-language.js'

export type CellChangeSource = 'manual' | 'ai' | 'sync' | 'rule' | 'import' | 'pricing' | 'unknown'

export interface CellHistoryEntry {
  at: string
  by: string | null
  layer: string
  fieldKey: string
  previous: unknown
  next: unknown
  source: CellChangeSource
  /**
   * Whether a previous value was RECORDED — distinct from the previous value
   * having been empty. `previous: null, previousRecorded: true` means the cell
   * was genuinely blank before; `previous: null, previousRecorded: false` means
   * nobody wrote it down. Collapsing those two is what makes a history panel
   * quietly lie about a change it cannot actually describe (hub ruling #14).
   */
  previousRecorded: boolean
}

export interface CellHistory {
  entries: CellHistoryEntry[]
  /** Oldest point from which previous-values exist. Null = none recorded yet. */
  coverageSince: string | null
  /** Plain-language statement of what is and is not recorded, for the drawer. */
  coverageNote: string
}

export interface GetCellHistoryInput {
  productId: string
  locale?: string
  accountId?: string
  listingId?: string
  aliasKey?: string
  fieldKey?: string
  channel?: string
  marketplace?: string
  aliasId?: string
  limit?: number
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

export async function getCellHistory(input: GetCellHistoryInput): Promise<CellHistory> {
  const { default: prisma } = await import('../../db.js')
  const limit = Number.isFinite(input.limit) ? Math.min(200, Math.max(1, Math.trunc(input.limit!))) : 50
  let requestedLocale: string | undefined
  try { requestedLocale = input.locale ? normalizeLanguage(input.locale) : undefined }
  catch { throw Object.assign(new Error('Choose a valid content language.'), { statusCode: 400 }) }

  const destination = input.channel ? await resolveWorkspaceDestination({ productId: input.productId, channel: input.channel, marketplace: input.marketplace ?? '', accountId: input.accountId, listingId: input.listingId, aliasKey: input.aliasKey ?? input.aliasId ?? (input.listingId ? undefined : '') }) : null
  // A root listing may select the alias while the drawer inspects one of its children.
  const listings = destination ? await prisma.channelListing.findMany({ where: { productId: input.productId, ...workspaceListingWhere({ ...destination, listing: null }) }, select: { id: true } }) : []
  const productScope = destination ? workspaceMetadataWhere(destination) : { OR: ['master', 'language'].map(layer => ({ metadata: { path: ['layer'], equals: layer } })).concat([{ metadata: { path: ['scope'], equals: 'master' } }]) }
  const productWhere = { entityType: 'Product', entityId: input.productId, ...productScope }
  const pinWhere = destination ? { entityType: 'ChannelListing', entityId: { in: listings.map(listing => listing.id) }, AND: [
    { metadata: { path: ['layer'], equals: 'pin' } },
    { metadata: { path: ['coordinate', 'channel'], equals: destination.channel } },
    { metadata: { path: ['coordinate', 'market'], equals: destination.marketplace } },
    { metadata: { path: ['coordinate', 'accountId'], equals: destination.accountId } },
  ] } : null
  const rows = await prisma.auditLog.findMany({
    where: (pinWhere ? { OR: [productWhere, pinWhere] } : productWhere) as Prisma.AuditLogWhereInput,
    orderBy: { createdAt: 'desc' },
    // Over-fetch a little because field/coordinate filtering happens in process:
    // both live inside JSONB and indexing them is not worth it at this volume.
    take: limit * 4,
    select: { createdAt: true, userId: true, before: true, after: true, metadata: true, action: true, entityType: true },
  })

  const entries: CellHistoryEntry[] = []
  for (const r of rows) {
    let after = asRecord(r.after)
    let before = asRecord(r.before)
    const meta = asRecord(r.metadata) ?? {}
    const pin = r.entityType === 'ChannelListing' && meta.layer === 'pin'
    const coordinate = pin ? asRecord(meta.coordinate) : null
    if (pin && (coordinate?.aliasId ?? '') !== (destination?.aliasKey ?? '')) continue
    // Current content audits store translations as native columns/attributes;
    // pin writes also wrap their changed values and explicit resets.
    if (pin || meta.layer === 'language') {
      if (pin) after = { ...asRecord(after?.values), ...Object.fromEntries((Array.isArray(after?.reset) ? after.reset : []).map(key => [String(key), null])) }
      const stored = before
      before = { ...asRecord(stored?.attributes) }
      for (const [field, column] of Object.entries(CONTENT_COLUMNS)) if (stored && column in stored && !(field in before)) before[field] = stored[column]
      if (meta.intent === 'remove') after = Object.fromEntries(Object.keys(before).map(key => [key, null]))
    }
    // #366 — read BOTH audit payload shapes. Taking `after.field` alone skipped
    // every multi-key row (the ai-draft path writes `{ "de.description": … }`),
    // and those are the majority: measured 2026-09-02, 320 of 398 Product audit
    // rows carry no `field` key at all. A cell whose only edits came through
    // that path showed an empty history that read as "never changed".
    const canonical = (key: string) => {
      let field = key.replace(/^[a-z]{2,3}(?:-[A-Za-z0-9]+)?\./, '')
      const prefix = input.channel?.toLowerCase() + '_'
      if (input.channel && field.startsWith(prefix)) field = field.slice(prefix.length)
      return field.replace(/^attr_/, '').replace(/^name$/, 'title')
    }
    const requested = canonical(input.fieldKey ?? '')
    const slot = /^(.*?)(?:_(\d+)|\[(\d+)\])$/.exec(requested)
    const base = slot ? slot[1] : requested
    const changed = fieldsChangedIn(after, before)
    const fieldKey = changed.find(key => canonical(key) === requested)
      ?? (slot ? changed.find(key => canonical(key) === base) : undefined)
      ?? (!input.fieldKey && changed.length === 1 ? changed[0] : '')
    if (!fieldKey) continue
    // A numbered schema key is not a list slot when the audit stores that exact key.
    const slotIndex = slot && canonical(fieldKey) === base ? Number(slot[2] ?? slot[3]) : null
    const slotValue = (value: unknown) => slotIndex !== null && Array.isArray(value) ? value[slotIndex - 1] ?? null : value ?? null
    const languageScoped = pin || meta.layer === 'language' || meta.contentTier === 'source' || Object.prototype.hasOwnProperty.call(CONTENT_COLUMNS, base)
    const recordedLocale = meta.locale ?? (languageScoped ? meta.language : undefined) ?? /^[a-z]{2,3}(?:-[A-Za-z0-9]+)?(?=\.)/.exec(fieldKey)?.[0]
    if (requestedLocale && recordedLocale) {
      try { if (normalizeLanguage(String(recordedLocale)) !== requestedLocale) continue }
      catch { continue }
    }
    if (input.locale && !recordedLocale && ['title', 'description', 'bulletPoints', 'keywords'].includes(base)) continue
    // A descriptor row keeps its value under `value`; a map row holds it under
    // the field's own key. Reading `.value` on a map row yields undefined, which
    // would render as "changed to (empty)" — worse than not listing it.
    const isDescriptor = asDescriptor(after) !== null || asDescriptor(before) !== null
    if (input.channel && String(coordinate?.channel ?? meta.channel ?? '') !== input.channel) continue
    if (input.marketplace && String(coordinate?.market ?? meta.marketplace ?? '') !== input.marketplace) continue
    if (input.aliasId && String(coordinate?.aliasId ?? meta.aliasKey ?? meta.aliasId ?? '') !== input.aliasId) continue

    // A row written before the enrichment has `before: null` — which is NOT the
    // same as "the previous value was empty". Distinguishing them is the whole
    // point of previousRecorded.
    const previousRecorded = isDescriptor
      ? before !== null && 'value' in before
      : before !== null && fieldKey in before

    entries.push({
      at: r.createdAt.toISOString(),
      by: r.userId ?? null,
      layer: String(meta.layer ?? (meta.channel ? 'channel' : 'master')),
      fieldKey: input.fieldKey ?? fieldKey,
      previous: previousRecorded ? slotValue(isDescriptor ? before!.value : before![fieldKey]) : null,
      next: slotValue(isDescriptor ? after?.value : after?.[fieldKey]),
      source: r.action?.startsWith('formula.') ? 'rule' : (String(meta.source ?? 'unknown').replace('bulk-patch', 'manual') as CellChangeSource) ?? 'unknown',
      previousRecorded,
    })
    if (entries.length >= limit) break
  }

  const withPrevious = entries.filter((e) => e.previousRecorded)
  const coverageSince = withPrevious.length > 0 ? withPrevious[withPrevious.length - 1].at : null

  const coverageNote = 'Only changes attributed to this product, field and scope are shown. Older changes without account or scope attribution remain in the audit log. ' + (coverageSince
    ? `Recorded previous values are available from ${coverageSince}.`
    : 'No previous values were recorded in the returned changes.')

  return { entries, coverageSince, coverageNote }
}
