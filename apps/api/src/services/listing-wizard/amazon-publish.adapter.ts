import { hasVariationMappingOverride, parseVariationMapping, variationMappingTarget } from '@nexus/shared/variation-mapping'
import { bindSegmentToAttribute, canonicalThemeSegment, themeSegments } from '../pim/variation-theme-segments.js'
import { loadAmazonThemeFacts } from '../pim/variation-theme-facts.js'
import { getAmazonSellerId } from '../../lib/amazon-sp-client.js'
/**
 * E.8 — Amazon publish adapter (SP-API Listings Items v2021-08-01).
 *
 * Flow:
 *   1. PUT  /listings/2021-08-01/items/{sellerId}/{parentSku}    parent
 *   2. PUT  /listings/2021-08-01/items/{sellerId}/{childSku} … N children
 *   3. GET  /listings/2021-08-01/items/{sellerId}/{parentSku}    parent ASIN
 *   4. GET  /listings/2021-08-01/items/{sellerId}/{childSku} … N child ASINs
 *
 * Each child gets its own putListingsItem call with parentage_level=child
 * + child_relationship_type=variation + child_parent_sku_relationship
 * pointing at the parent's marketplace-scoped SKU. The composer
 * (submission.service.ts) doesn't currently emit the wrapped child
 * attribute envelopes — this adapter expands payload.children[] into
 * the SP-API shape inline.
 *
 * NOT END-TO-END TESTED — wiring is real but exercising it requires:
 *   - AMAZON_CLIENT_ID + AMAZON_CLIENT_SECRET + AMAZON_REFRESH_TOKEN env
 *   - AMAZON_SELLER_ID env (the seller's SP-API seller token)
 *   - AMAZON_REGION env matching the marketplace's SP-API region
 *     (eu-west-1 for IT/DE/FR/ES, us-east-1 for US/CA/MX, etc.)
 * Until creds are configured, expect 401/403 from LWA.
 *
 * The adapter never throws; returns ok=false with the SP-API error
 * surface so the wizard's submissions log shows actionable errors.
 */

import { assertPushAllowed } from '@nexus/shared/push-lock'
import prisma from '../../db.js'
import { closedMarketSet } from '../amazon-market-offer.service.js'
import { amazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
import { logger } from '../../utils/logger.js'
import {
  acquireAmazonPublishToken,
  checkAmazonCircuit,
  getAmazonPublishMode,
  recordAmazonOutcome,
} from '../amazon-publish-gate.service.js'
import {
  digestPayload,
  writeAttemptLog,
} from '../channel-publish-audit.service.js'

export function amazonParentVariationAttributes(marketplaceId: string, theme: string): Record<string, unknown> {
  return { parentage_level: [{ marketplace_id: marketplaceId, value: 'parent' }], variation_theme: [{ marketplace_id: marketplaceId, name: theme }] }
}

interface AmazonPayload {
  productType: string
  marketplaceId: string
  attributes: Record<string, unknown>
  parentSku?: string
  childSkus?: string[]
  children?: Array<{
    masterSku: string
    channelSku: string
    channelProductId: string | null
    variationAttributes: Record<string, unknown>
    price: number | null
    quantity: number | null
  }>
  variationTheme?: string
  /** R-VT-13: either shape — the ORDERED `{axes:[…]}` a save stores now, or the flat legacy map. */
  variationMapping?: unknown
  imageUrls?: string[]
}

export interface AmazonPublishResult {
  ok: boolean
  /** Resolved parent SKU sent to SP-API. */
  parentSku?: string
  /** Marketplace-scoped child SKUs sent to SP-API (post-strategy resolution). */
  childSkus?: string[]
  /** SP-API submission id from the parent PUT. */
  submissionId?: string
  /** Per-child submission ids, keyed by master SKU. */
  childSubmissionIds?: Record<string, string>
  /** Parent ASIN if the post-publish getListingsItem returned one. */
  parentAsin?: string
  /** Per-child ASIN keyed by master SKU. */
  childAsinsByMasterSku?: Record<string, string>
  /** Human-readable error when ok=false. */
  error?: string
  /** Which step failed (parentPut|childPut|parentRead|childRead). */
  failedStep?: string
  /** Non-blocking issues from SP-API (WARNING / INFO). Always
   *  populated when SP-API surfaced any — both successful and failed
   *  publishes can carry these. The wizard UI tiers them by severity. */
  warnings?: Array<{
    code: string
    message: string
    severity: 'WARNING' | 'INFO'
    /** Where the issue applies, scoped per-child by SKU when relevant. */
    sku?: string
    attributeNames?: string[]
  }>
}

export class AmazonPublishAdapter {
  /**
   * Publish one (channel, marketplace) listing — parent + every selected
   * child — via SP-API. Returns whatever ASINs the immediate post-publish
   * read picked up; the wizard's poll path can re-call this to land late
   * ASIN assignments.
   */
  async publish(payload: AmazonPayload): Promise<AmazonPublishResult> {
    const sellerId =
      (await getAmazonSellerId())
    if (!sellerId) {
      return {
        ok: false,
        error:
          'AMAZON_SELLER_ID is not configured. Set the env var to the SP-API merchant token before publishing.',
        failedStep: 'config',
      }
    }
    if (!payload.parentSku) {
      return {
        ok: false,
        error: 'Composed payload is missing parentSku — wizard state has no master product SKU.',
        failedStep: 'config',
      }
    }
    if (!payload.marketplaceId) {
      return {
        ok: false,
        error: 'Composed payload is missing SP-API marketplaceId — Marketplace lookup failed.',
        failedStep: 'config',
      }
    }
    if (!payload.productType) {
      return {
        ok: false,
        error: 'Composed payload is missing productType — Step 3 not completed.',
        failedStep: 'config',
      }
    }

    const parentSku = payload.parentSku
    const children = Array.isArray(payload.children) ? payload.children : []
    const marketplaceCode = payload.marketplaceId
    // The legacy wizard payload has no account/alias coordinate. Read all stored
    // matches as a conservative refusal belt; never use this set to choose targets.
    const pushSkus = [...new Set([parentSku, ...children.flatMap(child => [child.masterSku, child.channelSku])])]
    let pushControls
    let closed
    try {
      pushControls = await prisma.channelListing.findMany({ where: { channel: 'AMAZON', product: { sku: { in: pushSkus } } } })
      closed = await closedMarketSet(pushControls.map(row => row.productId))
    } catch {
      return { ok: false, failedStep: 'push-lock', error: 'PUSH_CONTROL_UNAVAILABLE: The current listing controls could not be read.' }
    }
    for (const row of pushControls) {
      const refusal = assertPushAllowed({ ...row, offerClosedAt: row.offerClosedAt ?? (closed.has(`${row.productId}|${row.marketplace}`) ? 'closed' : null) })
      if (refusal) return { ok: false, failedStep: 'push-lock', error: `${refusal.code}: ${refusal.sentence}` }
    }
    // Validate the complete family before the first parent PUT; a child refusal must not leave a partial parent.
    const variationFacts = children.length ? await loadAmazonThemeFacts(marketplaceCode, payload.productType) : null
    if (children.length && (!payload.variationTheme || !variationFacts || !variationFacts.facts.themes.includes(payload.variationTheme) || variationFacts.facts.deprecated.includes(payload.variationTheme))) return { ok: false, error: 'A current schema-bound Amazon variation theme is required before publishing this family.', failedStep: 'validation' }
    const childPayloads = new Map<string, ReturnType<AmazonPublishAdapter['buildChildAttributes']>>()
    const combinations = new Map<string, string>()
    for (const child of children) {
      const built = this.buildChildAttributes({ parentSku, marketplaceId: marketplaceCode, variationTheme: payload.variationTheme!, variationAttributes: child.variationAttributes ?? {}, variationMapping: payload.variationMapping, schemaProperties: variationFacts!.facts.properties, price: child.price, quantity: child.quantity })
      if (built.unbound.length) return { ok: false, error: `Unbound variation attributes for ${child.channelSku}: ${built.unbound.map(a => a.axis).join(', ')}`, failedStep: 'validation' }
      const combination = JSON.stringify(themeSegments(payload.variationTheme!).map(segment => built.attributes[bindSegmentToAttribute(segment, variationFacts!.facts.properties)!.attribute]))
      if (combinations.has(combination)) return { ok: false, error: `${combinations.get(combination)} and ${child.channelSku} have identical variation values. Resolve the collision before publishing.`, failedStep: 'validation' }
      combinations.set(combination, child.channelSku); childPayloads.set(child.channelSku, built)
    }

    // C.6 — single helper threads each PUT through the gate sequence:
    // feature flag → rate limiter → circuit breaker → SP-API client →
    // audit log → circuit outcome record. Both the parent PUT and
    // each child PUT use it, so a misconfigured account can't silently
    // burn through 50 children before the breaker trips.
    //
    // Returns the same shape as the underlying client call so the
    // existing parent/child branching logic doesn't change.
    const gatedPut = async (
      sku: string,
      attributes: Record<string, unknown>,
    ): Promise<ReturnType<typeof amazonSpApiClient.putListingsItem>> => {
      for (const row of pushControls) {
        const refusal = assertPushAllowed(row)
        if (refusal) return { success: false, sku, error: `${refusal.code}: ${refusal.sentence}` }
      }
      const mode = getAmazonPublishMode()
      const digest = digestPayload({ productType: payload.productType, attributes })

      // 1. Feature flag (resolved as 'gated' mode)
      if (mode === 'gated') {
        writeAttemptLog({
          channel: 'AMAZON',
          marketplace: marketplaceCode,
          sellerId,
          sku,
          mode: 'gated',
          outcome: 'gated',
          payloadDigest: digest,
          errorMessage:
            'NEXUS_ENABLE_AMAZON_PUBLISH=false — set true to enable Amazon publishes.',
        })
        return {
          success: false,
          sku,
          error:
            'Amazon publish disabled by feature flag (NEXUS_ENABLE_AMAZON_PUBLISH=false).',
        }
      }

      // 2. Circuit breaker
      const circuit = checkAmazonCircuit(sellerId, marketplaceCode)
      if (!circuit.ok) {
        writeAttemptLog({
          channel: 'AMAZON',
          marketplace: marketplaceCode,
          sellerId,
          sku,
          mode,
          outcome: 'circuit-open',
          payloadDigest: digest,
          errorMessage: circuit.error,
        })
        return { success: false, sku, error: circuit.error }
      }

      // 3. Rate limiter
      const tokenStart = Date.now()
      const acquired = await acquireAmazonPublishToken(
        sellerId,
        marketplaceCode,
      )
      if (!acquired.ok) {
        writeAttemptLog({
          channel: 'AMAZON',
          marketplace: marketplaceCode,
          sellerId,
          sku,
          mode,
          outcome: 'rate-limited',
          payloadDigest: digest,
          errorMessage: acquired.error,
        })
        return { success: false, sku, error: acquired.error }
      }

      // 4. Real call (or dry-run short-circuit inside the client)
      const t0 = tokenStart
      let result: Awaited<ReturnType<typeof amazonSpApiClient.putListingsItem>>
      try {
        result = await amazonSpApiClient.putListingsItem({
          sellerId,
          sku,
          marketplaceId: marketplaceCode,
          productType: payload.productType,
          attributes,
          requirements: 'LISTING',
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        recordAmazonOutcome(sellerId, marketplaceCode, false)
        writeAttemptLog({
          channel: 'AMAZON',
          marketplace: marketplaceCode,
          sellerId,
          sku,
          mode,
          outcome: 'timeout',
          payloadDigest: digest,
          errorMessage: message,
          durationMs: Date.now() - t0,
        })
        return { success: false, sku, error: message }
      }

      // 5. Record outcome + audit
      const succeeded = result.success
      recordAmazonOutcome(sellerId, marketplaceCode, succeeded)
      writeAttemptLog({
        channel: 'AMAZON',
        marketplace: marketplaceCode,
        sellerId,
        sku,
        mode: result.dryRun ? 'dry-run' : mode,
        outcome: succeeded ? 'success' : 'failed',
        payloadDigest: digest,
        errorMessage: result.error ?? null,
        errorCode:
          result.issues && result.issues.length > 0
            ? result.issues[0].code
            : null,
        submissionId: result.submissionId ?? null,
        durationMs: Date.now() - t0,
      })
      return result
    }

    // Collect every non-blocking issue across parent + child PUTs so
    // the wizard UI can render them all together. Each entry tagged
    // with its SKU so the user knows which row triggered the issue.
    const collectedWarnings: AmazonPublishResult['warnings'] = []
    const stampWarnings = (
      sku: string,
      ws: NonNullable<AmazonPublishResult['warnings']>,
    ) => {
      for (const w of ws) collectedWarnings!.push({ ...w, sku })
    }

    // ── Step 1: PUT parent ───────────────────────────────────────────
    const parentResult = await gatedPut(parentSku, children.length ? { ...payload.attributes, ...amazonParentVariationAttributes(payload.marketplaceId, payload.variationTheme!) } : payload.attributes)
    if (parentResult.warnings) stampWarnings(parentSku, parentResult.warnings)
    if (!parentResult.success) {
      return {
        ok: false,
        parentSku,
        error: parentResult.error ?? 'Parent putListingsItem failed.',
        failedStep: 'parentPut',
        warnings: collectedWarnings.length > 0 ? collectedWarnings : undefined,
      }
    }

    // ── Step 2: PUT each child ──────────────────────────────────────
    const childSkusSent: string[] = []
    const childSubmissionIds: Record<string, string> = {}
    if (children.length > 0 && payload.variationTheme) {
      // ONE schema read for the whole family (cached per marketplace x productType in variation-theme-facts.ts),
      // never one per child: a per-child read would be a live-ish cost on a 50-child family.
      //
      // 🔴 P0 (VT.4): `payload.marketplaceId` holds the SP-API ID here (`submission.service.ts` resolves it through
      // `Marketplace.marketplaceId`), while `CategorySchema.marketplace` is keyed by the market CODE. The resolver
      // inside `loadAmazonThemeFacts` turns either form into the code through the `Marketplace` row — one authority,
      // no literal map — so this read resolves on the publish path as well as on the sheet path.
      for (const child of children) {
        const built = childPayloads.get(child.channelSku)!

        // VT.1 — REFUSE before the PUT rather than sending an invented attribute name. The submission names the
        // axis and the theme segment, so the operator knows exactly what to map; SP-API would otherwise accept the
        // payload and silently drop the axis, which is how a family publishes with its variants indistinguishable.
        if (built.unbound.length > 0) {
          const named = built.unbound.map((u) => u.segment ? `${u.axis} (theme segment ${u.segment})` : u.axis).join(', ')
          const noSchema = built.uncheckable.length > 0
          return {
            ok: false,
            parentSku,
            childSkus: childSkusSent,
            submissionId: parentResult.submissionId,
            // The two reasons are different sentences, and an operator acts on them differently: one needs a mapping,
            // the other needs the product type's requirements refreshed.
            error: noSchema
              ? `Child ${child.channelSku} was not sent: no cached ${marketplaceCode} schema for ${payload.productType}, so ${named} could not be bound to a real attribute. Refresh the product type's requirements and publish again.`
              : `Child ${child.channelSku} was not sent: ${named} binds to no attribute of product type ${payload.productType} on ${marketplaceCode}. Map ${built.unbound.length === 1 ? 'it' : 'them'} on the Variation theme column before publishing.`,
            failedStep: 'childPut',
            warnings: collectedWarnings.length > 0 ? collectedWarnings : undefined,
          }
        }

        const childResult = await gatedPut(child.channelSku, built.attributes)
        childSkusSent.push(child.channelSku)
        if (childResult.warnings) {
          stampWarnings(child.channelSku, childResult.warnings)
        }
        if (!childResult.success) {
          return {
            ok: false,
            parentSku,
            childSkus: childSkusSent,
            submissionId: parentResult.submissionId,
            error: `Child ${child.channelSku} putListingsItem failed: ${childResult.error ?? 'unknown'}`,
            failedStep: 'childPut',
            warnings:
              collectedWarnings.length > 0 ? collectedWarnings : undefined,
          }
        }
        if (childResult.submissionId) {
          childSubmissionIds[child.masterSku] = childResult.submissionId
        }
      }
    }

    // ── Step 3: read back the parent ASIN ────────────────────────────
    // Amazon assigns ASINs asynchronously after PUT; the immediate read
    // often returns null. Caller polls via the wizard /poll endpoint to
    // pick up the assignment when it lands. The first attempt here lets
    // us surface ASINs that landed in the same request cycle.
    const parentRead = await amazonSpApiClient.getListingsItem({
      sellerId,
      sku: parentSku,
      marketplaceId: payload.marketplaceId,
      includedData: ['summaries'],
    })
    const parentAsin = parentRead.success ? parentRead.asin ?? undefined : undefined

    // ── Step 4: read back each child ASIN (best-effort) ──────────────
    const childAsinsByMasterSku: Record<string, string> = {}
    for (const child of children) {
      const childRead = await amazonSpApiClient.getListingsItem({
        sellerId,
        sku: child.channelSku,
        marketplaceId: payload.marketplaceId,
        includedData: ['summaries'],
      })
      if (childRead.success && childRead.asin) {
        childAsinsByMasterSku[child.masterSku] = childRead.asin
      }
    }

    logger.info('Amazon publish adapter completed', {
      parentSku,
      childCount: children.length,
      parentAsinResolved: !!parentAsin,
      childAsinsResolved: Object.keys(childAsinsByMasterSku).length,
    })

    return {
      ok: true,
      parentSku,
      childSkus: childSkusSent,
      submissionId: parentResult.submissionId,
      childSubmissionIds:
        Object.keys(childSubmissionIds).length > 0 ? childSubmissionIds : undefined,
      parentAsin,
      childAsinsByMasterSku:
        Object.keys(childAsinsByMasterSku).length > 0
          ? childAsinsByMasterSku
          : undefined,
      warnings: collectedWarnings.length > 0 ? collectedWarnings : undefined,
    }
  }

  /**
   * Build the wrapped attribute envelope for a child PUT call. SP-API
   * needs parentage_level + child_parent_sku_relationship + the variation
   * theme axis values, plus a purchasable_offer if we have price/qty.
   *
   * 🔴 VT.1 (2026-09-13) REPLACED the `${axis}_name` fallback that stood here.
   *
   * Audit-fix #4 said `size_name` / `color_name` were "the dominant SP-API convention … correct for Xavia's
   * motorcycle-gear catalog". VT.0 measured the opposite on the very product type this catalogue publishes:
   * OUTERWEAR on IT and DE declares `color`, `size`, `style`, `material` and **does NOT declare `color_name`,
   * `size_name`, `style_name` or `material_type` at all** (`"color_name"` occurs 0 times in the schema; the
   * `_NAME` spellings exist ONLY inside the theme enum, and Amazon's own `$lifecycle.enumDeprecated` marks every
   * one of them deprecated). So the fallback named attributes the product type does not have — on every child
   * whose axis was missing from `variationMapping`.
   *
   * The binding is now resolved against the product type's OWN `properties`
   * (`variation-theme-segments.ts:bindSegmentToAttribute`), in this order:
   *   1. an explicit `variationMapping` entry (the operator's/projection's statement wins);
   *   2. the THEME SEGMENT whose canonical key matches this axis, bound to a real property;
   *   3. the axis name itself, bound to a real property;
   *   4. otherwise **unbound** — reported by name, never invented.
   *
   * When the schema is not cached at all (`schemaProperties` null) every axis is UNBOUND and the child is refused:
   * `uncheckable` still records WHY (we could not look, as opposed to we looked and there is no such attribute) so the
   * submission can say which of the two it was, but neither outcome sends an invented attribute name. VT.1's first
   * version kept the legacy convention in the could-not-look case; VT.4 measured that this is the case that FIRES on
   * the live path, and a wrong attribute name on a live parent is worse than a refused publish.
   */
  /**
   * 🔴 VT.4 (2026-09-13) made this PUBLIC and changed nothing else about it.
   *
   * The dry-run theme-change plan (`services/pim/theme-change.service.ts`, D-VT6 / VX D8) must show the
   * operator the exact child payload a live re-theme would send. A plan that composed that payload itself
   * would be a SECOND composer of the same bytes — the failure mode the programme's "one definition, zero
   * copies" rule exists for, and the one `docs/2026-09-12-variation-projection-design.md` §8 names
   * explicitly ("a test pins preview payload ≡ live payload; the test fails if a second composer appears").
   * `theme-change.vitest.test.ts` is that test: it calls THIS method and asserts the plan carries its
   * output byte-for-byte.
   *
   * It is safe to call off the publish path: no `await`, no prisma, no fetch, no clock — every input is a
   * parameter. Making it public adds one caller; it does not add a code path.
   */
  buildChildAttributes(args: {
    parentSku: string
    marketplaceId: string
    variationTheme: string
    variationAttributes: Record<string, unknown>
    /** R-VT-13: either shape — the ORDERED `{axes:[…]}` a save stores now, or the flat legacy map. */
  variationMapping?: unknown
    /** The product type's own `properties`, from the latest cached schema. `null` = not cached (see above). */
    schemaProperties?: Record<string, unknown> | null
    price: number | null
    quantity: number | null
  }): { attributes: Record<string, unknown>; unbound: Array<{ axis: string; segment: string | null }>; uncheckable: string[] } {
    const {
      parentSku,
      marketplaceId,
      variationTheme,
      variationAttributes,
      variationMapping,
      schemaProperties,
      price,
    } = args

    const wrap = (value: unknown) => ({ marketplace_id: marketplaceId, value })
    const axisEnvelope = (attribute: string, value: unknown) => {
      const binding = schemaProperties && segments.map(segment => bindSegmentToAttribute(segment, schemaProperties)).find(bound => bound?.attribute === attribute)
      return binding?.valuePath ? { marketplace_id: marketplaceId, [binding.valuePath[0]]: value } : wrap(value)
    }

    const out: Record<string, unknown> = {
      parentage_level: [wrap('child')],
      child_parent_sku_relationship: [
        {
          marketplace_id: marketplaceId,
          child_relationship_type: 'variation',
          parent_sku: parentSku,
        },
      ],
      variation_theme: [
        { marketplace_id: marketplaceId, name: variationTheme },
      ],
    }

    // Variation axis values — each axis (Size, Color, ...) becomes its own SP-API attribute, named by the binding
    // rule documented above. Nothing is invented: an axis that binds to no property is REPORTED.
    const unbound: Array<{ axis: string; segment: string | null }> = []
    const uncheckable: string[] = []
    const segments = themeSegments(variationTheme)
    for (const [axis, value] of Object.entries(variationAttributes)) {
      if (value === undefined || value === null || value === '') continue
      // R-VT-13 — ONE lookup for both shapes (`@nexus/shared/variation-mapping`), including the lowercase
      // fallback this line has always had. `variationMapping` may be the ordered `{axes:[…]}` or the flat map.
      const explicit = variationMappingTarget(variationMapping, axis, axis.toLowerCase()) ?? parseVariationMapping(variationMapping).entries.find(e => canonicalThemeSegment(e.axisKey) === canonicalThemeSegment(axis))?.target
      if (explicit) {
        const valid = schemaProperties && segments.some(segment => bindSegmentToAttribute(segment, schemaProperties)?.attribute === explicit)
        if (!valid) { unbound.push({ axis, segment: explicit }); continue }
        out[explicit] = [axisEnvelope(explicit, value)]; continue
      }
      if (hasVariationMappingOverride(variationMapping)) continue
      if (!schemaProperties) {
        // 🔴 P0 (VT.4): there is NO fallback here any more. The old one composed `${axis.toLowerCase()}_name`, which
        // on this catalogue produced the attribute name `"fit type_name"` — a space inside an SP-API attribute — and
        // named attributes the product type does not declare (T15). "We could not read the schema" is now a REFUSAL
        // with the axis named, exactly like "the schema has no such attribute": both mean this child must not be sent.
        unbound.push({ axis, segment: null })
        uncheckable.push(axis)
        continue
      }
      const wanted = canonicalThemeSegment(axis)
      const segment = segments.find((s) => canonicalThemeSegment(s) === wanted) ?? null
      const bound = (segment ? bindSegmentToAttribute(segment, schemaProperties) : null)
        ?? bindSegmentToAttribute(axis, schemaProperties)
      if (!bound) { unbound.push({ axis, segment }); continue }
      out[bound.attribute] = [axisEnvelope(bound.attribute, value)]
    }

    // Pricing — purchasable_offer envelope if we have a price.
    if (typeof price === 'number' && price > 0) {
      out.purchasable_offer = [
        {
          marketplace_id: marketplaceId,
          our_price: [{ schedule: [{ value_with_tax: price }] }],
        },
      ]
    }

    for (const segment of segments) { const bound = schemaProperties ? bindSegmentToAttribute(segment, schemaProperties) : null; if ((!bound || !out[bound.attribute]) && !unbound.some(u => canonicalThemeSegment(u.segment ?? u.axis) === canonicalThemeSegment(segment))) unbound.push({ axis: segment, segment }) }
    return { attributes: out, unbound, uncheckable }
  }
}
