import { contentAddress, type ContentAddress } from '@nexus/shared/content-language'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { writeTranslation } from './translation-write.js'
import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * FM.6 — catalog cascade apply engine.
 *
 * Applies a FM.5 propagation plan: persists cross-language translations
 * (BOTH Product.localizedContent[lang] for the resolver AND a
 * ProductTranslation row for the Locales tab — the operator's chosen
 * "both, synced" model), then enqueues one OutboundSyncQueue push per
 * affected coordinate (holdUntil undo window, dedup of PENDING rows),
 * writes ChannelListingOverride audit rows, and version-CASes the touched
 * entities — all in one transaction, with the BullMQ enqueue AFTER commit
 * (Redis down → DB row stays PENDING for the next drain). Mirrors
 * master-price.service.
 *
 * Scope: content + attribute fields. PRICE fields stay with
 * master-price.service (pricingRule-aware), so they're skipped here.
 *
 * Invoked-only today (FM.8 wires it to master-content saves; the editor
 * fan-out drawer calls it in FM.10). Recomputes the plan server-side — it
 * never trusts a client-sent value.
 */

import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { outboundSyncQueue } from '../../lib/queue.js'
import { logger } from '../../utils/logger.js'
import { translateProductCopy } from '../ai/translate.service.js'
import { PRICE_FIELD_KEYS } from '../field-resolution/propagation-fill.js'
import { planMappingPropagation, type MappingPropagationEntry } from './mapping-propagation.service.js'
import { valuesEqual } from './resolver-shadow.js'

const DEFAULT_HOLD_MS = 30 * 1000
const MAX_TRANSLATE_LANGS = 12

export interface ApplyCascadeContext {
  actor?: string | null
  reason?: string
  /** Apply the 30s push grace window (default true). */
  applyGrace?: boolean
}

export interface ApplyCascadeResult {
  productId: string
  sku: string
  translatedLanguages: string[]
  queuedCoordinates: number
  queuedSyncIds: string[]
  auditedFields: number
  skippedPriceFields: number
}

/** title/description channel fields → the localizedContent key + the
 *  ProductTranslation column. Only these are translated in FM.6. */
export function translatableTarget(
  fieldKey: string,
): { localized: 'title' | 'description'; pt: 'name' | 'description' } | null {
  const k = fieldKey.toLowerCase()
  if (k === 'title' || k === 'item_name' || k === 'name') return { localized: 'title', pt: 'name' }
  if (k === 'description' || k === 'product_description') return { localized: 'description', pt: 'description' }
  return null
}

/** The value a coordinate's push should carry: the translated value for a
 *  cross-language entry (resolved from translatedByLang), else the plan's
 *  proposed value. Pure. */
export function payloadValueFor(
  entry: MappingPropagationEntry,
  translatedByLang: Record<string, { title?: string | null; description?: string | null }>,
): unknown {
  if (entry.flags.needsTranslation && entry.language) {
    const t = translatableTarget(entry.fieldKey)
    const translated = t ? translatedByLang[entry.language]?.[t.localized] : undefined
    if (typeof translated === 'string' && translated.trim()) return translated
    throw new Error(`Translation is pending for ${entry.fieldKey} (${entry.marketplace}). No update was queued.`)
  }
  if (entry.flags.needsTranslation) throw new Error(`Translation target is missing for ${entry.fieldKey}. No update was queued.`)
  return entry.proposed
}

/** ChannelListingOverride.previousValue/newValue are String? — serialize
 *  any value to a stable string (or null) for the audit log. */
export function toAuditString(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * Apply the cascade of master-attribute changes to a product's mapped
 * channel coordinates.
 */
export async function applyCatalogCascade(
  input: {
    productId: string
    contentAddress?: ContentAddress
    changes: Record<string, unknown>
    channels?: string[]
    markets?: string[]
    locale?: string
    sourceMarketplace?: string
  },
  ctx: ApplyCascadeContext = {},
): Promise<ApplyCascadeResult> {
  const fieldLabel = Object.keys(input.changes)[0] ?? 'Content'
  const address = contentAddress(input.contentAddress, fieldLabel)
  if (address.tier === 'pin') throw Object.assign(new Error(`${fieldLabel} is pinned. Choose a shared content address before applying a catalogue cascade.`), { statusCode: 400 })
  const plan = await planMappingPropagation({
    productId: input.productId,
    changes: input.changes,
    channels: input.channels,
    markets: input.markets,
    locale: input.locale,
    sourceMarketplace: input.sourceMarketplace,
  })

  // Split: price fields are master-price.service's domain; skip them here.
  const applicable = plan.entries.filter((e) => e.action === 'update' && !PRICE_FIELD_KEYS.has(e.fieldKey))
  const skippedPriceFields = plan.entries.filter((e) => PRICE_FIELD_KEYS.has(e.fieldKey)).length

  const invalid = applicable.filter(e => e.errors?.length || e.flags.unmappedRequired)
  if (invalid.length) throw new Error(`Propagation has invalid values: ${invalid.map(e => `${e.fieldKey} (${e.marketplace}): ${e.errors?.join('; ') || 'Required value missing'}`).join('; ')}`)
  if (applicable.some(e => !e.flags.needsTranslation && !valuesEqual(e.current, e.proposed))) {
    throw new Error('Save the Master changes before applying propagation, then refresh the preview. Publication must use persisted product data.')
  }

  // ── translate (outside the tx — never hold a DB tx open across AI) ──
  const langsNeeded = Array.from(
    new Set(
      applicable
        .filter((e) => e.flags.needsTranslation && e.language && translatableTarget(e.fieldKey))
        .map((e) => e.language as string),
    ),
  ).slice(0, MAX_TRANSLATE_LANGS)

  const translatableChanges: { name?: string; description?: string } = {}
  if (typeof input.changes.title === 'string') translatableChanges.name = input.changes.title
  if (typeof input.changes.description === 'string') translatableChanges.description = input.changes.description

  const translatedByLang: Record<string, { title?: string | null; description?: string | null }> = {}
  let translateMeta: { source: string; sourceModel: string } | null = null
  if (langsNeeded.length > 0 && (translatableChanges.name || translatableChanges.description)) {
    const product = await prisma.product.findUnique({ where: { id: input.productId }, select: { brand: true } })
    const brand = product?.brand ?? null
    for (const lang of langsNeeded) {
      let glossary: Array<{ preferred: string; avoid?: string[]; context?: string | null }> = []
      try {
        const terms = await prisma.terminologyPreference.findMany({
          where: { language: lang, OR: [{ brand }, { brand: null }] },
          select: { preferred: true, avoid: true, context: true },
        })
        glossary = terms.map((t) => ({ preferred: t.preferred, avoid: t.avoid, context: t.context }))
      } catch {
        /* glossary best-effort */
      }
      try {
        const res = await translateProductCopy({
          source: translatableChanges,
          targetLanguage: lang,
          brand: brand ?? undefined,
          productId: input.productId,
          glossary: glossary.length > 0 ? glossary : undefined,
        })
        translatedByLang[lang] = { title: res.name, description: res.description }
        translateMeta = { source: res.source, sourceModel: res.sourceModel }
      } catch (err) {
        logger.warn('applyCatalogCascade: translation unavailable (publication blocked)', {
          productId: input.productId,
          lang,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // Map each coordinate → its ChannelListing for the queue rows.
  const listings = await prisma.channelListing.findMany({
    where: { productId: input.productId },
    select: { id: true, channel: true, marketplace: true, region: true, externalListingId: true, channelConnectionId: true, aliasKey: true, version: true, updatedAt: true },
  })
  const listingById = new Map(listings.map(l => [l.id, l]))

  // The account and alias are part of the coordinate, including audit and queue writes.
  const byCoord = new Map<string, MappingPropagationEntry[]>()
  for (const e of applicable) {
    const candidates = e.listingId ? [listingById.get(e.listingId)].filter(Boolean) : listings.filter(l =>
      l.channel === e.channel && l.marketplace === e.marketplace &&
      (e.channelConnectionId === undefined || l.channelConnectionId === e.channelConnectionId) &&
      (l.aliasKey ?? '') === (e.aliasKey ?? ''))
    if (candidates.length !== 1) throw new Error('Propagation requires one exact listing, account and alias. Refresh the preview.')
    const listing = candidates[0]!
    if (listing.channel !== e.channel || listing.marketplace !== e.marketplace ||
      (e.channelConnectionId !== undefined && listing.channelConnectionId !== e.channelConnectionId) ||
      (listing.aliasKey ?? '') !== (e.aliasKey ?? '')) throw new Error('Listing identity changed during propagation. Refresh the preview.')
    // Translation failures are atomic: no translation, audit or queue writes.
    payloadValueFor(e, translatedByLang)
    const key = listing.id
    const arr = byCoord.get(key) ?? []
    arr.push(e)
    byCoord.set(key, arr)
  }

  const holdUntil = ctx.applyGrace === false ? null : new Date(Date.now() + DEFAULT_HOLD_MS)
  const queuedSyncIds: string[] = []
  let auditedFields = 0
  let queuedCoordinates = 0

  await inDatabaseTransaction(prisma, async () => {
    const tx = prisma
    // Guard the product once before any translation or queue writes.
    if (plan.productVersion !== undefined) {
      const guarded = await tx.product.updateMany({ where: { id: input.productId, version: plan.productVersion, updatedAt: plan.productUpdatedAt },
        data: { version: { increment: 1 } } })
      if (guarded.count !== 1) throw new Error('Product changed during propagation. Reload and try again.')
    }
    // Generated text stays an unreviewed shared-language draft. The common
    // writer owns CAS, audit and same-language following intent for every caller.
    for (const [language, content] of Object.entries(translatedByLang)) {
      await writeTranslation({ productId: input.productId, locale: language, address: { tier: 'language', language },
        values: { ...content, sourceModel: translateMeta?.sourceModel }, state: 'draft', userId: ctx.actor })
    }

    // 2. Per-coordinate push + audit.
    for (const [coordKey, entries] of byCoord) {
      const listing = listingById.get(coordKey)
      if (!listing) throw new Error('Listing disappeared during propagation.')
      const snapshot = entries[0]
      if (snapshot.listingVersion !== undefined) {
        const guarded = await tx.channelListing.updateMany({ where: { id: listing.id, version: snapshot.listingVersion, updatedAt: snapshot.listingUpdatedAt },
          data: { version: { increment: 1 } } })
        if (guarded.count !== 1) throw new Error('Listing changed during propagation. Reload and try again.')
      }
      const fields: Record<string, unknown> = {}
      for (const e of entries.filter(entry => !entry.flags.needsTranslation)) {
        const value = payloadValueFor(e, translatedByLang)
        fields[e.fieldKey] = value
        await tx.channelListingOverride.create({
          data: {
            channelListingId: listing.id,
            fieldName: e.fieldKey,
            previousValue: toAuditString(e.current),
            newValue: toAuditString(value),
            isActive: true,
            changedBy: ctx.actor ?? null,
            reason: ctx.reason ?? 'fm-catalog-cascade',
          },
        })
        auditedFields++
      }

      if (!Object.keys(fields).length) continue
      const payload = {
        source: 'FM_CATALOG_CASCADE',
        productId: input.productId,
        productSku: plan.sku,
        channel: listing.channel,
        marketplace: listing.marketplace,
        channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey,
        fields,
        reason: ctx.reason ?? null,
      }

      // Dedup: merge into an existing PENDING ATTRIBUTE_UPDATE for this
      // coordinate rather than stacking duplicate pushes.
      const existing = await tx.outboundSyncQueue.findFirst({
        where: { channelListingId: listing.id, syncType: 'ATTRIBUTE_UPDATE', syncStatus: 'PENDING' },
        select: { id: true, payload: true },
      })
      let queueId: string
      if (existing) {
        const mergedFields = {
          ...(((existing.payload as any)?.fields as Record<string, unknown>) ?? {}),
          ...fields,
        }
        await tx.outboundSyncQueue.update({
          where: { id: existing.id },
          data: { payload: { ...payload, fields: mergedFields } as Prisma.InputJsonValue, holdUntil },
        })
        queueId = existing.id
      } else {
        const row = await tx.outboundSyncQueue.create({
          data: {
            productId: input.productId,
            channelListingId: listing.id,
            targetChannel: listing.channel as any,
            targetRegion: listing.region,
            syncStatus: 'PENDING' as any,
            syncType: 'ATTRIBUTE_UPDATE',
            holdUntil,
            externalListingId: listing.externalListingId,
            payload: payload as Prisma.InputJsonValue,
          },
          select: { id: true },
        })
        queueId = row.id
      }
      queuedSyncIds.push(queueId)
      await tx.channelListing.update({
        where: { id: listing.id },
        data: { lastSyncStatus: 'PENDING', lastSyncedAt: null, version: { increment: 1 } },
      })
      queuedCoordinates++
    }
  })

  // 3. BullMQ enqueue AFTER commit — DB row is the source of truth; a
  // failed enqueue just waits for the next cron drain.
  const delay = ctx.applyGrace === false ? 0 : DEFAULT_HOLD_MS
  for (const queueId of queuedSyncIds) {
    try {
      await outboundSyncQueue.add(
        'sync-job',
        { queueId, productId: input.productId, syncType: 'ATTRIBUTE_UPDATE', source: 'FM_CATALOG_CASCADE' },
        { delay, jobId: queueId },
      )
    } catch (err) {
      logger.warn('applyCatalogCascade: BullMQ enqueue failed (DB row remains PENDING)', {
        queueId,
        productId: input.productId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info('applyCatalogCascade', {
    productId: input.productId,
    translatedLanguages: Object.keys(translatedByLang),
    queuedCoordinates,
    auditedFields,
    skippedPriceFields,
    actor: ctx.actor ?? null,
  })

  return {
    productId: input.productId,
    sku: plan.sku,
    translatedLanguages: Object.keys(translatedByLang),
    queuedCoordinates,
    queuedSyncIds,
    auditedFields,
    skippedPriceFields,
  }
}
