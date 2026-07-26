/**
 * ED v2 Phase 4a — DESCRIPTION-ONLY push for eBay listings, both lanes.
 *
 * The gap this closes: a family's ADOPTED Trading listings (Lane B —
 * SharedListingMembership rows sharing the family's child SKUs) had NO way to
 * receive a description update — they diverged from the family forever. This
 * service revises Description (and ONLY Description) on each Trading listing
 * via a minimal ReviseFixedPriceItem, rendering each listing's OWN body copy
 * through the family's assigned theme (operator decision D5: per-listing
 * descriptions — a listing's membership flatFileSnapshot description/title/
 * subtitle wins when present, else the family parent's per-market content).
 *
 * Lane A (Inventory-managed primary — child CLs carry __offerIds, the
 * deterministic Incident-#23 marker) is deliberately NOT revised here:
 *   • Trading revises are rejected outright on Inventory-managed listings
 *     ("non consentita per gli oggetti del magazzino").
 *   • The Inventory API has no description-only call: inventory_item_group is
 *     a full-replace PUT (title, aspects, variantSKUs, imageVariesBy, images);
 *     a hand-rolled partial PUT would clobber the live group. The EXISTING safe
 *     mechanism — the flat-file Full Publish (pushVariationGroup) — already
 *     re-renders the themed description with curation-first images + parity.
 * So Lane A returns an explicit, honest per-listing skip pointing there.
 *
 * Safety invariants:
 *   • The <Item> node carries ONLY ItemID + Description — no price, quantity,
 *     title, SKU or variations can move.
 *   • An empty rendered body is REFUSED (never blank a live description).
 *   • PARITY read-back after every revise: GetItem (OutputSelector
 *     Item.Description), compare a normalized hash of what we sent vs what
 *     eBay returns; mismatch → loud 'PARITY MISMATCH' warning.
 *   • callTradingApi's real-API gate applies: without NEXUS_EBAY_REAL_API the
 *     call is a dry-run in dev and a hard refusal in production.
 */
import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { callTradingApi, siteIdForMarket, escapeXml } from './ebay-trading-api.service.js'
import { renderListingDescriptionSafe, stampDescriptionPushSafe } from './ebay-description-theme.service.js'
import { resolvePerMarketContent } from './ebay-variation-push.service.js'

// Same detector the axes-convert service proved live: eBay rejects Trading
// revises on Inventory-managed listings with an inventory/magazzino message.
const INVENTORY_MANAGED_RE = /inventor|magazzino|non consentita/i

export const LANE_A_SKIP_MESSAGE =
  'inventory-managed — update via Full Publish (safe: curation-first images + parity)'

// ── Pure XML builders / parsers (unit-tested) ────────────────────────────────

/**
 * Minimal Description-only ReviseFixedPriceItem. The <Item> carries ONLY
 * ItemID + Description — the proven metadata-revise shape (label-guard /
 * membership-reconcile) so nothing else on the live listing can change.
 * HTML rides in CDATA exactly like buildAddFixedPriceItemXml does, with the
 * `]]>` splitting that keeps a literal "]]>" in the body from breaking out.
 */
export function buildDescriptionReviseXml(itemId: string, descriptionHtml: string): string {
  const cdataSafe = descriptionHtml.replace(/]]>/g, ']]]]><![CDATA[>')
  return `<?xml version="1.0" encoding="utf-8"?>\n<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><Item><ItemID>${escapeXml(itemId)}</ItemID><Description><![CDATA[${cdataSafe}]]></Description></Item></ReviseFixedPriceItemRequest>`
}

/** Narrow GetItem for the parity read-back — only the Description comes back. */
export function buildGetItemDescriptionXml(itemId: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${escapeXml(itemId)}</ItemID><OutputSelector>Item.Description</OutputSelector></GetItemRequest>`
}

/**
 * Extract the Description from a GetItem response. eBay returns it either
 * CDATA-wrapped or entity-escaped depending on content — handle both. The
 * CDATA strip also reverses the `]]>` split (removing the CDATA open/close
 * tokens from `]]]]><![CDATA[>` yields the original `]]>`).
 */
export function parseDescriptionFromGetItem(raw: string): string | null {
  const m = /<Description(?:\s[^>]*)?>([\s\S]*?)<\/Description>/.exec(raw)
  if (!m) return null
  const body = m[1]
  if (body.includes('<![CDATA[')) {
    return body.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
  }
  return body
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Whitespace-insensitive canonical form for parity comparison — eBay
 * re-serializes markup (newlines/indentation shift) but must not change the
 * actual content. Collapse all whitespace runs and inter-tag gaps.
 */
export function normalizeDescriptionHtml(html: string): string {
  return html.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim()
}

export function normalizedDescriptionHash(html: string): string {
  return createHash('sha256').update(normalizeDescriptionHtml(html)).digest('hex')
}

// ── Pure per-listing content resolution (operator decision D5) ───────────────

export interface PerListingContent {
  title: string
  subtitle: string
  description: string
  /** Where the BODY came from — 'membership' = this listing's own saved row. */
  bodySource: 'membership' | 'parent'
}

/**
 * D5 — each adopted listing renders its OWN copy: the first non-blank value
 * across that listing's membership flatFileSnapshots wins per field, falling
 * back to the family parent's per-market content. bodySource reports whether
 * the description specifically was the listing's own.
 */
export function resolvePerListingContent(
  snapshots: Array<unknown>,
  parent: { title: string; subtitle: string; description: string },
): PerListingContent {
  const firstNonBlank = (key: string): string => {
    for (const s of snapshots) {
      if (!s || typeof s !== 'object') continue
      const v = (s as Record<string, unknown>)[key]
      if (typeof v === 'string' && v.trim() !== '') return v
    }
    return ''
  }
  const ownDescription = firstNonBlank('description')
  return {
    title: firstNonBlank('title') || parent.title,
    subtitle: firstNonBlank('subtitle') || parent.subtitle,
    description: ownDescription || parent.description,
    bodySource: ownDescription ? 'membership' : 'parent',
  }
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export interface DescriptionPushInput {
  productIds: string[]
  /** Flat-file market code (IT/DE/FR/ES/UK). Defaults to IT. */
  marketplace?: string
  /** When provided, persisted to the family's eBay ChannelListing
   *  platformAttributes.descriptionThemeId BEFORE rendering ('none' = raw). */
  themeId?: string
}

export interface DescriptionPushListingResult {
  itemId: string
  parentSku: string
  lane: 'inventory' | 'trading'
  outcome: 'revised' | 'inventory-managed' | 'skipped-empty-body' | 'dry-run' | 'failed'
  /** Whether a theme wrapped the body (from renderListingDescriptionSafe). */
  themed: boolean
  themeName?: string
  bodySource?: 'membership' | 'parent'
  warnings: string[]
  message?: string
}

export interface DescriptionPushProductSummary {
  productId: string
  parentSku?: string
  themePersisted?: boolean
  listings: number
  warnings: string[]
  error?: string
}

export interface DescriptionPushResult {
  marketplace: string
  listings: DescriptionPushListingResult[]
  products: DescriptionPushProductSummary[]
}

interface MinimalLog {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
}

export interface DescriptionPushCtx {
  prisma: PrismaClient
  oauthToken: string
  log?: MinimalLog
  /** Courtesy delay between live listing operations (tests pass 0). */
  sleepMs?: number
}

const regionOf = (mp: string): string => (mp.toUpperCase() === 'UK' ? 'GB' : mp.toUpperCase())

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/**
 * Description-only push for one or more families. Never touches price,
 * quantity, title, variations or images on any listing. Reads eBay back after
 * every revise (parity). Writes to our DB only to persist the theme choice.
 */
export async function pushDescriptions(
  input: DescriptionPushInput,
  ctx: DescriptionPushCtx,
): Promise<DescriptionPushResult> {
  const { prisma, oauthToken } = ctx
  const marketplace = (input.marketplace ?? 'IT').toUpperCase()
  const siteId = siteIdForMarket(marketplace) // throws on unknown market — before any work
  const region = regionOf(marketplace)
  const sleepMs = ctx.sleepMs ?? 300
  const themeId = input.themeId?.trim() || undefined

  const listings: DescriptionPushListingResult[] = []
  const products: DescriptionPushProductSummary[] = []
  // The same live listing can be reachable from two selected products (shared
  // families) — revise each ItemID at most once per invocation.
  const processedItemIds = new Set<string>()

  for (const productId of input.productIds) {
    const summary: DescriptionPushProductSummary = { productId, listings: 0, warnings: [] }
    products.push(summary)
    try {
      // ── Resolve the FAMILY ROOT (child selection walks up to the parent) ──
      let node = await prisma.product.findFirst({
        where: { id: productId, deletedAt: null },
        select: { id: true, sku: true, parentId: true },
      })
      if (!node) {
        summary.error = 'product not found (or deleted)'
        continue
      }
      for (let hop = 0; node.parentId && hop < 3; hop++) {
        const parent = await prisma.product.findFirst({
          where: { id: node.parentId, deletedAt: null },
          select: { id: true, sku: true, parentId: true },
        })
        if (!parent) break
        node = parent
      }
      const root = node
      summary.parentSku = root.sku

      const children = await prisma.product.findMany({
        where: { parentId: root.id, deletedAt: null },
        select: { id: true },
      })
      const familyIds = [root.id, ...children.map((c) => c.id)]

      // ── The family's eBay listing row for THIS market (same query shape the
      // renderer uses, so what we persist is what render reads back) ──
      const parentCl = await prisma.channelListing.findFirst({
        where: { productId: root.id, channel: 'EBAY', region },
        select: {
          id: true,
          externalListingId: true,
          title: true,
          description: true,
          platformAttributes: true,
          flatFileSnapshot: true,
        },
      })

      // ── Persist the theme choice FIRST so this render (and every future
      // push) uses it. Merge-only — __offerIds and friends are never dropped. ──
      if (themeId) {
        if (parentCl) {
          const attrs = asObj(parentCl.platformAttributes)
          await prisma.channelListing.update({
            where: { id: parentCl.id },
            data: { platformAttributes: { ...attrs, descriptionThemeId: themeId } },
          })
          summary.themePersisted = true
        } else {
          summary.themePersisted = false
          summary.warnings.push(
            `no eBay ChannelListing for ${region} — theme not persisted for this family`,
          )
        }
      }

      // ── Lane marker (Incident #23): __offerIds on any family CL means OUR
      // Inventory-API group publish owns the primary listing. ──
      const familyCls = await prisma.channelListing.findMany({
        where: { productId: { in: familyIds }, channel: 'EBAY' },
        select: { platformAttributes: true },
      })
      const inventoryManaged = familyCls.some((cl) => {
        const offerIds = asObj(cl.platformAttributes).__offerIds
        return !!offerIds && typeof offerIds === 'object' && Object.keys(offerIds as object).length > 0
      })

      // ── Family parent's per-market content (P9e field authority). ──
      const parentContent = resolvePerMarketContent(parentCl, {})

      // ── Both lanes' listings: the family's own primary + ACTIVE adopted
      // memberships grouped per ItemID (their snapshots carry per-listing copy). ──
      const memberships = await prisma.sharedListingMembership.findMany({
        where: { parentSku: root.sku, marketplace, status: 'ACTIVE' },
        select: { itemId: true, flatFileSnapshot: true },
        orderBy: { itemId: 'asc' },
      })
      const snapshotsByItemId = new Map<string, Array<unknown>>()
      for (const m of memberships) {
        if (!snapshotsByItemId.has(m.itemId)) snapshotsByItemId.set(m.itemId, [])
        if (m.flatFileSnapshot) snapshotsByItemId.get(m.itemId)!.push(m.flatFileSnapshot)
      }
      const primaryItemId =
        parentCl?.externalListingId && /^\d+$/.test(parentCl.externalListingId)
          ? parentCl.externalListingId
          : undefined
      const itemIds: string[] = []
      if (primaryItemId) itemIds.push(primaryItemId)
      for (const id of snapshotsByItemId.keys()) if (!itemIds.includes(id)) itemIds.push(id)

      if (itemIds.length === 0) {
        summary.warnings.push('no live eBay listings found for this family (no primary ItemID, no ACTIVE memberships)')
        continue
      }

      const mode: 'group' | 'single' = children.length > 0 ? 'group' : 'single'

      // ED v2 P5 — after ANY listing of this family is actually revised, stamp
      // the delivery (fire-and-forget) so the staleness badge clears.
      let anyRevised = false
      let revisedThemeInfo: { themeId?: string; themeVersion?: number } = {}

      for (const itemId of itemIds) {
        if (processedItemIds.has(itemId)) continue
        processedItemIds.add(itemId)
        summary.listings++

        // ── Lane A: Inventory-managed primary — honest skip (see header). ──
        if (inventoryManaged && itemId === primaryItemId) {
          listings.push({
            itemId,
            parentSku: root.sku,
            lane: 'inventory',
            outcome: 'inventory-managed',
            themed: false,
            warnings: [],
            message: LANE_A_SKIP_MESSAGE,
          })
          continue
        }

        // ── Lane B: Trading revise, Description only. ──
        const warnings: string[] = []
        const content = resolvePerListingContent(snapshotsByItemId.get(itemId) ?? [], parentContent)
        const rendered = await renderListingDescriptionSafe(prisma, {
          productId: root.id,
          marketplace,
          mode,
          body: content.description,
          title: content.title,
          subtitle: content.subtitle || undefined,
        })
        warnings.push(...rendered.warnings)

        if (!rendered.html.trim()) {
          listings.push({
            itemId,
            parentSku: root.sku,
            lane: 'trading',
            outcome: 'skipped-empty-body',
            themed: rendered.themed,
            themeName: rendered.themeName,
            bodySource: content.bodySource,
            warnings,
            message:
              'no body copy found (membership snapshots and parent listing are both empty) — refusing to blank the live description',
          })
          continue
        }

        try {
          const res = await callTradingApi(
            'ReviseFixedPriceItem',
            buildDescriptionReviseXml(itemId, rendered.html),
            { oauthToken, siteId },
          )
          if (!res.raw) {
            // dev dry-run (NEXUS_EBAY_REAL_API off) — nothing was sent, no parity possible
            listings.push({
              itemId,
              parentSku: root.sku,
              lane: 'trading',
              outcome: 'dry-run',
              themed: rendered.themed,
              themeName: rendered.themeName,
              bodySource: content.bodySource,
              warnings,
              message: 'NEXUS_EBAY_REAL_API not enabled — revise was not sent',
            })
            continue
          }

          // ── PARITY read-back: what does eBay actually hold now? ──
          try {
            const got = await callTradingApi('GetItem', buildGetItemDescriptionXml(itemId), {
              oauthToken,
              siteId,
            })
            const live = got.raw ? parseDescriptionFromGetItem(got.raw) : null
            if (live === null) {
              warnings.push('parity read-back returned no Description — verify the listing manually')
            } else if (normalizedDescriptionHash(live) !== normalizedDescriptionHash(rendered.html)) {
              warnings.push(
                `PARITY MISMATCH — do not trust this result: eBay returned a different description than we sent for ${itemId} (sent ${rendered.html.length} chars, live ${live.length} chars). Inspect the listing before assuming the update took.`,
              )
            }
          } catch (err) {
            warnings.push(
              `parity read-back failed (revise itself succeeded): ${err instanceof Error ? err.message : String(err)}`,
            )
          }

          anyRevised = true
          revisedThemeInfo = { themeId: rendered.themeId, themeVersion: rendered.themeVersion }
          listings.push({
            itemId,
            parentSku: root.sku,
            lane: 'trading',
            outcome: 'revised',
            themed: rendered.themed,
            themeName: rendered.themeName,
            bodySource: content.bodySource,
            warnings,
          })
          ctx.log?.info(
            { itemId, parentSku: root.sku, themed: rendered.themed, bodySource: content.bodySource },
            'ebay-description-push: description revised',
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (INVENTORY_MANAGED_RE.test(msg)) {
            // Defensive: an Inventory-managed listing the lane marker missed
            // still gets the honest Lane-A answer, not a scary failure.
            listings.push({
              itemId,
              parentSku: root.sku,
              lane: 'inventory',
              outcome: 'inventory-managed',
              themed: rendered.themed,
              themeName: rendered.themeName,
              bodySource: content.bodySource,
              warnings,
              message: LANE_A_SKIP_MESSAGE,
            })
          } else {
            listings.push({
              itemId,
              parentSku: root.sku,
              lane: 'trading',
              outcome: 'failed',
              themed: rendered.themed,
              themeName: rendered.themeName,
              bodySource: content.bodySource,
              warnings,
              message: msg,
            })
            ctx.log?.warn({ itemId, err: msg }, 'ebay-description-push: revise failed')
          }
        }
        if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs)) // rate-limit courtesy
      }

      // ED v2 P5 — staleness stamp (D8). One stamp per family × market, only
      // when a live description actually changed; fire-and-forget so a stamp
      // problem can never fail (or delay) the push result.
      if (anyRevised) {
        stampDescriptionPushSafe(
          prisma,
          { productId: root.id, marketplace, ...revisedThemeInfo },
          (msg) => ctx.log?.warn({ productId: root.id, parentSku: root.sku, marketplace }, `ebay-description-push: ${msg}`),
        )
      }
    } catch (err) {
      summary.error = err instanceof Error ? err.message : String(err)
      ctx.log?.warn({ productId, err: summary.error }, 'ebay-description-push: product failed')
    }
  }

  return { marketplace, listings, products }
}
