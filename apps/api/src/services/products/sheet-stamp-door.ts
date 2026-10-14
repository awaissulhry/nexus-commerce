/**
 * The product sheet's field stamps at the write door (the Information page, 2026-10-13; the Matrix twin is
 * `pim/matrix-write.service.ts` `applyCell`).
 *
 * A sheet write is guarded by ONE version per row: `Product.version` for the Shared product and its language text,
 * `ChannelListing.version` for a listing and its pinned text, and the version of the translation row a text cell writes.
 * A sale, a cascade, another tab or another person editing ANOTHER field moves it, and the write was refused although the
 * field the person edited had not changed. Each sheet write now carries, per cell, what the cell showed (`expected`, the
 * `@nexus/shared/sheet-stamp` stamp of the cell the person edited, from the read the page holds) and which column it is
 * (`column`). The door:
 *   - the version matches                     → the write goes ahead, exactly as before;
 *   - the version moved, every stamp holds     → the write goes ahead at the version read now, in this transaction, and
 *                                                answers it (`writtenAt`);
 *   - a stamped field moved                    → refused as before, with each moved cell as it is now (`current`).
 * A unit with any change that carries no stamp is checked on the version alone, as before.
 *
 * "The stamp holds" is asked of the SAME cell the page read: the product sheet's own read (`getStudioSheet`) of this
 * product's family, in this scope and language, inside this transaction — so the page and the door read the cell with
 * one derivation, and the version the retry writes at is one this transaction saw beside it.
 *
 * 🔴 Review state. A text write marks its WHOLE language (or pin) row reviewed and `manual`
 * (`pim/translation-write.ts`, `pim/content-write.ts`). A write at a fresh version must never mark as reviewed a field
 * someone else (the AI translator, `pim/catalog-translate.ts`) drafted after the person read the row. So when the
 * translation row this write lands on moved since the person's read (or the page sent no token for it) and that row
 * holds unreviewed MACHINE text now, the write is refused: the person reads the draft first. "Machine text" is the
 * publish gate's own predicate (`pim/publish-review-gate.ts` `unreviewedMachineDraft`). A row with no source is never
 * one: every Shared text edit cascades onto the listings that follow Shared and creates or bumps their pin row with only
 * `follows` (`master-content.service.ts`) — nothing was drafted, so it refuses nothing (review of #611).
 */
import { isSheetCellStamp, sheetCellStamp, sheetStampHolds, type SheetCellStamp } from '@nexus/shared/sheet-stamp'
import { FEATURES } from '@nexus/shared/permissions'
import prisma from '../../db.js'
import { activeDatabaseTransaction, inDatabaseTransaction, inSavepoint } from '../../lib/database-context.js'
import { ProductBulkError } from '../../lib/product-bulk-error.js'
import { applyProductBulkEdits, type ProductBulkContext, type ProductBulkInput } from './bulk-edit.service.js'
import { unreviewedMachineDraft } from '../pim/publish-review-gate.js'
import type { StudioSheet } from '../pim/studio-sheet.service.js'

/** One try of the unit's write (the caller's own writer and its per-try evidence); the door gives each try a savepoint. */
export type StampedAttempt<T> = (unit: ProductBulkInput) => Promise<T>
/** `'value' in outcome` tells the two apart (this workspace compiles without strict null checks). */
export type StampedOutcome<T> = { ok: true; value: T; writtenAt?: number } | { ok: false; error: unknown }

/** The sentence for a text row someone drafted after the person read it. */
export const DRAFT_SINCE_READ = 'Other text in this language was drafted since you read it, and saving would mark that draft as reviewed. Refresh, review the draft, then save again.'

/**
 * Does this text row hold unreviewed machine text? The publish gate's predicate, on the row as the content resolver reads
 * it: no source is a person's text (`content-resolver.ts` reads it as `manual`). So a follow-only row a Shared cascade made
 * (no source, never reviewed) is not a draft.
 */
const holdsMachineDraft = (row: { source: string | null; reviewedAt: Date | null }) => unreviewedMachineDraft({ translation: {
  source: (row.source ?? 'manual') as 'manual' | 'ai' | 'translated', reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null, outdated: false } })

/** The one destination a stamped unit names: a Shared scope (no channel) or one channel coordinate. */
interface StampScope { channel?: string; marketplace: string; accountId?: string; locale?: string; aliasKey: string }

function scopeOf(input: ProductBulkInput): StampScope | null {
  const contexts = input.marketplaceContexts?.length ? input.marketplaceContexts : input.marketplaceContext ? [input.marketplaceContext] : []
  if (contexts.length !== 1 || !contexts[0]?.marketplace) return null
  const c = contexts[0] as { channel?: string; marketplace: string; accountId?: string; locale?: string; aliasKey?: string }
  return { ...(c.channel ? { channel: c.channel } : {}), marketplace: c.marketplace, ...(c.accountId ? { accountId: c.accountId } : {}),
    ...(c.locale ? { locale: c.locale } : {}), aliasKey: typeof c.aliasKey === 'string' ? c.aliasKey : '' }
}

/**
 * Does this unit carry stamps the door can check? Every change stamped, one product, one destination, the version the
 * person read (never 0 — "I saw no listing" keeps its own adopt-and-retry path), and none of the paths a stamp does not
 * describe (a dry run, an If-Match header, a formula's own write, a cascade, Shopify's enriched read).
 */
export function carriesStamps(input: ProductBulkInput, context: Pick<ProductBulkContext, 'ifMatch' | 'formulaWriteToken'>): boolean {
  if (input.dryRun || context.ifMatch !== undefined || context.formulaWriteToken !== undefined) return false
  if (typeof input.expectedVersion !== 'number' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) return false
  const scope = scopeOf(input)
  if (!scope || scope.channel === 'SHOPIFY') return false
  const id = input.changes?.[0]?.id
  return typeof id === 'string' && !!id && input.changes.every((change) => !!change && change.id === id && !change.cascade
    && typeof change.column === 'string' && !!change.column && isSheetCellStamp(change.expected))
}

/** A refusal that only says the row's version (or its text row's) moved — the one a stamp may answer. */
function versionRefusal(error: unknown): error is ProductBulkError {
  if (!(error instanceof ProductBulkError) || error.statusCode !== 409) return false
  const code = error.details.code
  if (code === 'VERSION_CONFLICT') return true
  return code === undefined && / changed\. Reload before saving it\.$/.test(String(error.details.error ?? ''))
}

/** The scope's sheet read, once per family and scope in one transaction attempt (a sheet operation's rows share it). */
const reads = new WeakMap<object, Map<string, Promise<StudioSheet | null>>>()

async function sheetFor(productId: string, scope: StampScope, context: ProductBulkContext): Promise<StudioSheet | null> {
  const seed = await prisma.product.findUnique({ where: { id: productId }, select: { parentId: true } })
  if (!seed) return null
  const rootId = seed.parentId ?? productId
  const canEditPrice = context.can ? context.can(FEATURES.productsPriceEdit) : true
  const key = JSON.stringify([rootId, scope.channel ?? null, scope.marketplace.toUpperCase(), scope.accountId ?? null, scope.locale ?? null, canEditPrice])
  const transaction = activeDatabaseTransaction()
  let cache = transaction ? reads.get(transaction) : undefined
  if (transaction && !cache) reads.set(transaction, cache = new Map())
  const known = cache?.get(key)
  if (known) return known
  const read = (async () => {
    const { getStudioSheet } = await import('../pim/studio-sheet.service.js')
    // In a savepoint: a read that fails must not leave this transaction unusable for the refusal that follows.
    const outcome = await inSavepoint(() => getStudioSheet({ productId: rootId, scope: scope.channel ? 'channel' : 'master', market: scope.marketplace,
      ...(scope.channel ? { channel: scope.channel } : {}), ...(scope.accountId ? { accountId: scope.accountId } : {}),
      ...(scope.locale ? { locale: scope.locale } : {}), canEditPrice }))
    if ('error' in outcome) { context.logger.warn({ err: outcome.error, productId }, '[products/bulk] the sheet read for a stamped write failed; the write is refused'); return null }
    return outcome.value
  })()
  cache?.set(key, read)
  return read
}

/** The retry at the fresh versions, or the refusal (the original one, with each moved cell as it is now). */
async function stampVerdict(input: ProductBulkInput, context: ProductBulkContext, refusal: ProductBulkError):
  Promise<{ retry: ProductBulkInput } | { refuse: ProductBulkError }> {
  const refuse = (extra: Record<string, unknown> = {}) => ({ refuse: new ProductBulkError(409, { ...refusal.details, ...extra }, refusal) })
  const scope = scopeOf(input)!
  const productId = input.changes[0].id
  const sheet = await sheetFor(productId, scope, context)
  const row = sheet?.rows.find((r) => r.id === productId && (!scope.channel || (r.aliasId ?? '') === scope.aliasKey))
  if (!row) return refuse()
  // The listing the page read: a listing that took this coordinate since is not what the person saw.
  if (input.expectedListingId !== undefined && (row.listing?.id ?? null) !== (input.expectedListingId ?? null)) return refuse()
  const current: Record<string, SheetCellStamp | null> = {}
  for (const change of input.changes) {
    const cell = row.values[change.column!]
    if (!sheetStampHolds(change.expected, cell)) current[change.column!] = sheetCellStamp(cell) ?? null
  }
  if (Object.keys(current).length) return refuse({ current })

  // The owner the unit's version guards — the listing for a listing write, else the product — as it is now.
  const onListing = input.changes.some((change) => change.target === 'channel')
  const listingId = row.listing?.id ?? null
  const owner = onListing
    ? listingId ? await prisma.channelListing.findUnique({ where: { id: listingId }, select: { version: true } }) : null
    : await prisma.product.findUnique({ where: { id: productId }, select: { version: true } })
  if (!owner) return refuse()

  // Each text change's translation row as it is now: its version becomes the change's token, and a row someone drafted
  // since the person's read is never marked reviewed by this write.
  const changes: ProductBulkInput['changes'] = []
  for (const change of input.changes) {
    const address = change.contentAddress as { tier?: string; language?: string } | undefined
    if ((address?.tier !== 'language' && address?.tier !== 'pin') || !address.language) { changes.push(change); continue }
    const select = { version: true, reviewedAt: true, source: true } as const
    const text = address.tier === 'language'
      ? await prisma.productTranslation.findFirst({ where: { productId, language: address.language }, select })
      : listingId ? await prisma.channelListingTranslation.findFirst({ where: { channelListingId: listingId, language: address.language }, select }) : null
    const version = text?.version ?? 0
    const moved = change.contentVersion === undefined || change.contentVersion !== version
    // `current` is empty — every stamped cell held — and present, so the page treats this as the field-level refusal it is.
    if (moved && text && holdsMachineDraft(text) && change.contentState !== 'draft') return refuse({ error: DRAFT_SINCE_READ, message: DRAFT_SINCE_READ, current: {} })
    changes.push(change.contentVersion === undefined ? change : { ...change, contentVersion: version })
  }
  return { retry: { ...input, expectedVersion: owner.version, changes } }
}

/**
 * One sheet unit through the door, inside the caller's transaction: the write as sent; when the version it names moved
 * and every change carries a stamp that still holds, the write once more at the version read now (`writtenAt`). Each try
 * runs in its own savepoint, so a refused try leaves nothing behind.
 */
export async function applyWithStamps<T>(input: ProductBulkInput, context: ProductBulkContext, attempt: StampedAttempt<T>): Promise<StampedOutcome<T>> {
  const first = await inSavepoint(() => attempt(input))
  if ('value' in first || !versionRefusal(first.error) || !carriesStamps(input, context)) return first
  const verdict = await stampVerdict(input, context, first.error)
  if ('refuse' in verdict) return { ok: false, error: verdict.refuse }
  const second = await inSavepoint(() => attempt(verdict.retry))
  return 'value' in second ? { ok: true, value: second.value, writtenAt: verdict.retry.expectedVersion } : second
}

/**
 * `PATCH /api/products/bulk` (one row of the sheet): a stamped unit runs through the door in one transaction; any other
 * request runs exactly as before. A write that went ahead at a fresh version says so in its answer (`writtenAt`).
 *
 * Editing speed (2026-10-13) — a stamped unit is the product sheet's own write: it answers before its family's readiness
 * is rebuilt (`ProductBulkContext.readinessAfterResponse`), as the sheet's operation save does.
 */
export async function applySheetBulkEdits(input: ProductBulkInput, context: ProductBulkContext) {
  if (!carriesStamps(input, context)) return applyProductBulkEdits(input, context)
  const sheetContext: ProductBulkContext = { ...context, readinessAfterResponse: true }
  return inDatabaseTransaction(prisma, async () => {
    const outcome = await applyWithStamps<Record<string, unknown>>(input, sheetContext, (unit) => applyProductBulkEdits(unit, sheetContext))
    if ('error' in outcome) throw outcome.error
    return outcome.writtenAt === undefined ? outcome.value : { ...outcome.value, writtenAt: outcome.writtenAt }
  }, { restarts: SHEET_SAVE_RESTARTS })
}

/** Two saves of one family typed a moment apart can lose to each other; the sheet's saves get five attempts, not three. */
export const SHEET_SAVE_RESTARTS = 4
