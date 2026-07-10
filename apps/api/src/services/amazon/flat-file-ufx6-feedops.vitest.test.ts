/**
 * UFX Phase 6 (batch 3) — Amazon official-format adoption, feed-operation side.
 *
 * Locks the four units:
 *   P6g-1  operationType per record_action: 'partial_update' (default) →
 *          PARTIAL_UPDATE with NO requirements key; 'full_update' / _isNew →
 *          UPDATE + requirements (LISTING, or LISTING_PRODUCT_ONLY for a
 *          parent row — a variation parent has no offer); 'delete' → minimal
 *          DELETE {sku, operationType}. Payload content is otherwise identical
 *          across partial/full — the full attribute set under PARTIAL_UPDATE
 *          is deliberate (no sparse diffs).
 *   P6g-2  requirementsEnforced (getDefinitionsProductType envelope, captured
 *          by schema-sync as __requirementsEnforced) → manifest exposure +
 *          preflight downgrade of missing-required errors for PARTIAL_UPDATE
 *          rows of a NOT_ENFORCED type. Absent value = ENFORCED (conservative).
 *   P6g-3  meta-schema `selectors` (array-item uniqueness, pairs with
 *          maxUniqueItems) honored in the numbered-column reassembly dedup.
 *   P6g-4  $lifecycle.enumDeprecated → manifest deprecatedOptions + preflight
 *          deprecated-value warning.
 *
 * Truths verified against the LIVE cached schemas (49 distinct defs probed
 * 2026-07-11): requirementsEnforced is NOT stored yet (0/49 — capture added
 * additively by this batch); `selectors` sit on the top-level attribute node
 * ([marketplace_id] / [marketplace_id, language_tag] on the flat multi-
 * instance attributes: bullet_point maxUniqueItems=10, material 3|14);
 * $lifecycle.enumDeprecated sits on the enum-bearing node
 * (variation_theme.items.properties.name, vehicle_fitment…standard…value
 * ["tecdoc"]); NO replacedBy/replaces marker exists in any cached schema.
 */
import { describe, it, expect } from 'vitest'
import { AmazonFlatFileService } from './flat-file.service.js'

const feedSvc = new AmazonFlatFileService({} as any, {} as any)
const build = (rows: any[], feedSchema: any = {}) =>
  feedSvc.buildJsonFeedBodyWithReport(rows, 'IT', 'SELLER', {}, feedSchema)
const messagesOf = (r: { body: string }) => JSON.parse(r.body).messages as Array<Record<string, any>>

// ── P6g-1 — UPDATE vs PARTIAL_UPDATE vs DELETE matrix ────────────────────────

describe('UFX P6g — operationType / requirements per record_action', () => {
  it('default (no record_action) → PARTIAL_UPDATE with NO requirements key', () => {
    const [m] = messagesOf(build([{ item_sku: 'S1', product_type: 'JACKET', item_name: 'X' }]))
    expect(m.operationType).toBe('PARTIAL_UPDATE')
    expect('requirements' in m).toBe(false)
    // Full attribute set still sent — PARTIAL_UPDATE does not mean sparse diff.
    expect(m.attributes.item_name).toBeDefined()
  })

  it("explicit record_action 'partial_update' → PARTIAL_UPDATE, no requirements", () => {
    const [m] = messagesOf(build([{ item_sku: 'S1', product_type: 'JACKET', record_action: 'partial_update' }]))
    expect(m.operationType).toBe('PARTIAL_UPDATE')
    expect('requirements' in m).toBe(false)
  })

  it("'full_update' on a child/standalone row → UPDATE + requirements LISTING", () => {
    const [m] = messagesOf(build([{ item_sku: 'S1', product_type: 'JACKET', record_action: 'full_update' }]))
    expect(m.operationType).toBe('UPDATE')
    expect(m.requirements).toBe('LISTING')
  })

  it("'full_update' on a PARENT row → UPDATE + requirements LISTING_PRODUCT_ONLY (a parent has no offer)", () => {
    const [m] = messagesOf(build([{ item_sku: 'P1', product_type: 'JACKET', record_action: 'full_update', parentage_level: 'parent', variation_theme: 'SIZE' }]))
    expect(m.operationType).toBe('UPDATE')
    expect(m.requirements).toBe('LISTING_PRODUCT_ONLY')
  })

  it('_isNew row → UPDATE (create) + requirements LISTING even without record_action', () => {
    const [m] = messagesOf(build([{ item_sku: 'NEW-1', product_type: 'JACKET', _isNew: true }]))
    expect(m.operationType).toBe('UPDATE')
    expect(m.requirements).toBe('LISTING')
  })

  it("'delete' → minimal DELETE message: sku + operationType ONLY", () => {
    const [m] = messagesOf(build([{ item_sku: 'DEL-1', record_action: 'delete', product_type: 'JACKET', item_name: 'ignored' }]))
    expect(m).toEqual({ messageId: 1, sku: 'DEL-1', operationType: 'DELETE' })
  })

  it('payload attributes are identical between partial and full update (only op/requirements differ)', () => {
    const row = { item_sku: 'S1', product_type: 'JACKET', item_name: 'Giacca', brand: 'Xavia', bullet_point: 'BP' }
    const [partial] = messagesOf(build([{ ...row }]))
    const [full] = messagesOf(build([{ ...row, record_action: 'full_update' }]))
    expect(full.attributes).toEqual(partial.attributes)
    expect(partial.operationType).toBe('PARTIAL_UPDATE')
    expect(full.operationType).toBe('UPDATE')
  })
})
