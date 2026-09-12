import { WorkspaceCache } from '../../lib/workspace-cache.js'
/**
 * M1 — Schema-driven Amazon image-slot taxonomy.
 *
 * Replaces the hardcoded 10-slot list (MAIN, PT01–PT08, SWCH) with the
 * REAL set of image-locator attributes Amazon exposes for a given
 * (marketplace, productType), discovered from the cached product-type
 * schema. This:
 *   (a) uncaps the additional-image slots beyond 8 when the product type
 *       allows more (`other_product_image_locator_9`, …), and
 *   (b) surfaces product-safety (PS / GPSR) image locators when the schema
 *       exposes them as writable attributes (relevant for Xavia's EU PPE).
 *
 * Falls back to the legacy 10-slot constants when the schema isn't cached
 * or SP-API is unconfigured, so behaviour never regresses. Pure builder
 * (`buildSlotTaxonomy`) is exported for tests; the resolver caches per
 * (marketplace, productType) for 24h (mirrors `enLabelCache`).
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { CategorySchemaService } from '../categories/schema-sync.service.js'
import { AmazonService } from '../marketplaces/amazon.service.js'
import {
  AMAZON_SLOTS as FALLBACK_SLOTS,
  SLOT_TO_ATTRIBUTE as FALLBACK_MAP,
} from '../channel-batch/amazon-batch-feed.service.js'

export type SlotKind = 'MAIN' | 'OTHER' | 'SWATCH' | 'SAFETY' | 'NAMED'

export interface SlotDef {
  /** Canonical slot code: MAIN, PT01..PTnn, SWCH, PS01..PSnn, IMG01… */
  slot: string
  /** The schema property / locator attribute name it maps to. */
  attribute: string
  kind: SlotKind
  /** Render + publish order (MAIN first, then PT by index, safety, swatch last). */
  order: number
  /** False when the schema marks the locator read-only (Seller-Central-only). */
  writable: boolean
}

export interface SlotTaxonomy {
  slots: SlotDef[]
  slotToAttribute: Record<string, string>
  attributeToSlot: Record<string, string>
  source: 'schema' | 'fallback'
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
/**
 * 🔴 A FALLBACK is cached only briefly, and that asymmetry is the whole point.
 *
 * Both outcomes used to share the 24h TTL, so one transient schema failure pinned the legacy
 * 10-slot set for a DAY — with no log and no signal. MAIN survives that (it is in both sets), but
 * PS01–PS06 do not, and they are populated: on GALE-JACKET eighteen ListingImage rows sit in PS
 * slots. For those 24 hours those images are invisible to preview, validation and publish, and the
 * validator returns a CLEAN verdict for a listing whose safety images are not going out. A falsely
 * clean gate is worse than a falsely blocked one.
 *
 * Short enough that a blip costs one minute rather than a day; long enough that a genuinely
 * unavailable schema cannot turn every request into a fresh lookup.
 */
const FALLBACK_TTL_MS = 60 * 1000
const cache = new WorkspaceCache<string, { at: number; tax: SlotTaxonomy }>()

function isOfferImage(name: string): boolean {
  // B2B *offer* image locators are not part of the buyer-facing gallery.
  return /offer_image_locator/i.test(name)
}

function isReadOnly(prop: unknown): boolean {
  const p = prop as { readOnly?: boolean; editable?: boolean } | null
  return p?.readOnly === true || p?.editable === false
}

/**
 * PURE — build a slot taxonomy from a JSON-Schema `properties` map.
 * Exported for unit tests. Returns `source:'schema'`; callers substitute
 * the fallback when no MAIN slot is discovered.
 */
export function buildSlotTaxonomy(properties: Record<string, unknown>): SlotTaxonomy {
  const slots: SlotDef[] = []
  let safetyCount = 0
  let namedCount = 0

  for (const name of Object.keys(properties ?? {})) {
    if (!/image_locator/i.test(name)) continue
    if (isOfferImage(name)) continue
    const writable = !isReadOnly(properties[name])

    if (name === 'main_product_image_locator') {
      slots.push({ slot: 'MAIN', attribute: name, kind: 'MAIN', order: 0, writable })
      continue
    }
    const other = name.match(/^other_product_image_locator_(\d+)$/)
    if (other) {
      const n = Number(other[1])
      slots.push({ slot: `PT${String(n).padStart(2, '0')}`, attribute: name, kind: 'OTHER', order: n, writable })
      continue
    }
    if (/swatch_.*image_locator/i.test(name)) {
      slots.push({ slot: 'SWCH', attribute: name, kind: 'SWATCH', order: 900, writable })
      continue
    }
    // Product-safety (PS / GPSR) image locators. Amazon names these
    // `image_locator_ps01..ps06` (confirmed live on IT/DE OUTERWEAR) — also
    // accept `product_safety_image_locator_N` / `ps_image_locator_N`. The
    // trailing number is the PS index, so PS order matches Amazon's.
    const psNum = name.match(/(?:image_locator_ps|product_safety_image_locator_?|ps_image_locator_?)0*(\d+)/i)
    if (psNum) {
      const n = Number(psNum[1])
      slots.push({ slot: `PS${String(n).padStart(2, '0')}`, attribute: name, kind: 'SAFETY', order: 800 + n, writable })
      continue
    }
    // Other safety-ish locators without a clear index → sequential PS codes.
    if (/safety|hazard|warning|gpsr|compliance/i.test(name)) {
      safetyCount += 1
      slots.push({ slot: `PS${String(safetyCount).padStart(2, '0')}`, attribute: name, kind: 'SAFETY', order: 800 + safetyCount, writable })
      continue
    }
    // Anything else that is an image locator but unrecognised.
    namedCount += 1
    slots.push({ slot: `IMG${String(namedCount).padStart(2, '0')}`, attribute: name, kind: 'NAMED', order: 850 + namedCount, writable })
  }

  slots.sort((a, b) => a.order - b.order || a.slot.localeCompare(b.slot))

  const slotToAttribute: Record<string, string> = {}
  const attributeToSlot: Record<string, string> = {}
  for (const s of slots) {
    slotToAttribute[s.slot] = s.attribute
    attributeToSlot[s.attribute] = s.slot
  }
  return { slots, slotToAttribute, attributeToSlot, source: 'schema' }
}

/** The legacy 10-slot set, used when the schema is unavailable. */
export function fallbackTaxonomy(): SlotTaxonomy {
  const slots: SlotDef[] = FALLBACK_SLOTS.map((slot, i): SlotDef => ({
    slot,
    attribute: FALLBACK_MAP[slot]!,
    kind: slot === 'MAIN' ? 'MAIN' : slot === 'SWCH' ? 'SWATCH' : 'OTHER',
    order: slot === 'MAIN' ? 0 : slot === 'SWCH' ? 900 : i,
    writable: true,
  }))
  const attributeToSlot: Record<string, string> = {}
  for (const [s, a] of Object.entries(FALLBACK_MAP)) attributeToSlot[a] = s
  return { slots, slotToAttribute: { ...FALLBACK_MAP }, attributeToSlot, source: 'fallback' }
}

let _svc: CategorySchemaService | null = null
function svc(): CategorySchemaService {
  if (!_svc) _svc = new CategorySchemaService(prisma as never, new AmazonService())
  return _svc
}

/**
 * Resolve the writable image-slot taxonomy for (marketplace, productType)
 * from the cached Amazon product-type schema. 24h in-memory cache.
 * Always succeeds — falls back to the legacy 10 slots on any miss/error.
 */
export async function resolveSlotTaxonomy(marketplace: string, productType: string): Promise<SlotTaxonomy> {
  const key = `${marketplace}:${productType}`
  const hit = cache.get(key)
  if (hit) {
    const ttl = hit.tax.source === 'fallback' ? FALLBACK_TTL_MS : TWENTY_FOUR_HOURS_MS
    if (Date.now() - hit.at < ttl) return hit.tax
  }

  let tax: SlotTaxonomy
  try {
    const row = await svc().getSchema({ channel: 'AMAZON', marketplace, productType })
    const def = (row?.schemaDefinition ?? {}) as Record<string, unknown>
    const props = (def.properties ?? {}) as Record<string, unknown>
    const built = buildSlotTaxonomy(props)
    // Require at least a MAIN slot to trust the schema result.
    if (built.slots.some((s) => s.kind === 'MAIN')) {
      tax = built
    } else {
      // A schema that answered but carried no MAIN locator. Silently identical to a failure before
      // this log existed, and a different problem entirely — worth telling them apart.
      logger.warn('[amazon-slot-taxonomy] schema returned no MAIN locator — using the fallback slot set', {
        marketplace, productType, slotsFound: built.slots.length,
      })
      tax = fallbackTaxonomy()
    }
  } catch (err) {
    // Was a bare catch. One blip used to pin the 10-slot fallback for 24 hours with nothing in the
    // logs to say why PS/safety slots had vanished from preview, validation and publish.
    logger.warn('[amazon-slot-taxonomy] schema lookup failed — using the fallback slot set for the next minute', {
      marketplace, productType, err,
    })
    tax = fallbackTaxonomy()
  }
  cache.set(key, { at: Date.now(), tax })
  return tax
}

/** Test helper — clear the in-memory taxonomy cache. */
export function _clearTaxonomyCache(): void {
  cache.clear()
}
