import { resolveWorkspaceDestination } from './workspace-destination.js'
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
  const limit = Math.min(200, Math.max(1, input.limit ?? 50))

  const destination = input.channel ? await resolveWorkspaceDestination({ productId: input.productId, channel: input.channel, marketplace: input.marketplace ?? '', accountId: input.accountId, listingId: input.listingId, aliasKey: input.aliasKey ?? input.aliasId ?? (input.listingId ? undefined : '') }) : null
  const rows = await prisma.auditLog.findMany({
    where: { entityType: 'Product', entityId: input.productId, ...(destination ? workspaceMetadataWhere(destination) : { OR: [{ metadata: { path: ['layer'], equals: 'master' } }, { metadata: { path: ['scope'], equals: 'master' } }] }) as Prisma.AuditLogWhereInput },
    orderBy: { createdAt: 'desc' },
    // Over-fetch a little because field/coordinate filtering happens in process:
    // both live inside JSONB and indexing them is not worth it at this volume.
    take: limit * 4,
    select: { createdAt: true, userId: true, before: true, after: true, metadata: true, action: true },
  })

  const entries: CellHistoryEntry[] = []
  for (const r of rows) {
    const after = asRecord(r.after)
    const before = asRecord(r.before)
    const meta = asRecord(r.metadata) ?? {}
    // #366 — read BOTH audit payload shapes. Taking `after.field` alone skipped
    // every multi-key row (the ai-draft path writes `{ "de.description": … }`),
    // and those are the majority: measured 2026-09-02, 320 of 398 Product audit
    // rows carry no `field` key at all. A cell whose only edits came through
    // that path showed an empty history that read as "never changed".
    const canonical = (key: string) => key.replace(/^[a-z]{2,3}(?:-[A-Za-z0-9]+)?\./, '').replace(/^attr_/, '').replace(/^name$/, 'title')
    const requested = canonical(input.fieldKey ?? '')
    const slot = /^(.*?)(?:_(\d+)|\[(\d+)\])$/.exec(requested)
    const base = slot ? slot[1] : requested
    const changed = fieldsChangedIn(r.after, r.before)
    const fieldKey = changed.find(key => canonical(key) === requested || slot && canonical(key) === base)
      ?? (!input.fieldKey && changed.length === 1 ? changed[0] : '')
    if (!fieldKey) continue
    const recordedLocale = meta.locale ?? /^[a-z]{2,3}(?:-[A-Za-z0-9]+)?(?=\.)/.exec(fieldKey)?.[0]
    if (input.locale && recordedLocale && String(recordedLocale).toLowerCase() !== input.locale.toLowerCase()) continue
    if (input.locale && !recordedLocale && ['title', 'description', 'bulletPoints', 'keywords'].includes(base)) continue
    // A descriptor row keeps its value under `value`; a map row holds it under
    // the field's own key. Reading `.value` on a map row yields undefined, which
    // would render as "changed to (empty)" — worse than not listing it.
    const isDescriptor = asDescriptor(r.after) !== null || asDescriptor(r.before) !== null
    if (input.channel && String(meta.channel ?? '') !== input.channel) continue
    if (input.marketplace && String(meta.marketplace ?? '') !== input.marketplace) continue
    if (input.aliasId && String(meta.aliasKey ?? meta.aliasId ?? '') !== input.aliasId) continue

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
      previous: previousRecorded ? slot && Array.isArray(isDescriptor ? before!.value : before![fieldKey]) ? (isDescriptor ? before!.value : before![fieldKey])[Number(slot[2] ?? slot[3]) - 1] ?? null : (isDescriptor ? before!.value : before![fieldKey]) : null,
      next: slot && Array.isArray(isDescriptor ? after?.value : after?.[fieldKey]) ? (isDescriptor ? after?.value : after?.[fieldKey])[Number(slot[2] ?? slot[3]) - 1] ?? null : (isDescriptor ? after?.value : after?.[fieldKey]) ?? null,
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
