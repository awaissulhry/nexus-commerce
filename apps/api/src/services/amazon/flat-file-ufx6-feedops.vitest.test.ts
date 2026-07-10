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
import { describe, it, expect, vi } from 'vitest'
import { AmazonFlatFileService } from './flat-file.service.js'
import { CategorySchemaService } from '../categories/schema-sync.service.js'
import { preflightRow } from '../listing-preflight.service.js'

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

// ── P6g-2 — requirementsEnforced: capture → manifest → preflight downgrade ───

const wrappedString = () => ({
  type: 'array',
  items: { type: 'object', properties: { value: { type: 'string' }, language_tag: {}, marketplace_id: {} } },
})

const defWithEnforcement = (requirementsEnforced?: string): Record<string, any> => ({
  required: ['item_name'],
  properties: { item_name: wrappedString() },
  __propertyGroups: { details: { title: 'Details', propertyNames: ['item_name'] } },
  ...(requirementsEnforced ? { __requirementsEnforced: requirementsEnforced } : {}),
})

const svcFor = (defsByType: Record<string, Record<string, any>>) =>
  new AmazonFlatFileService({} as any, {
    getSchema: async ({ productType }: any) => ({ schemaDefinition: defsByType[productType], schemaVersion: 'REL_1' }),
    refreshSchema: async ({ productType }: any) => ({ schemaDefinition: defsByType[productType], schemaVersion: 'REL_1' }),
  } as any)

describe('UFX P6g — requirementsEnforced manifest exposure', () => {
  it('generateManifest surfaces __requirementsEnforced; absent key → undefined (= ENFORCED)', async () => {
    const svc = svcFor({ SHIRT: defWithEnforcement('NOT_ENFORCED'), PANTS: defWithEnforcement() })
    expect((await svc.generateManifest('IT', 'SHIRT')).requirementsEnforced).toBe('NOT_ENFORCED')
    expect((await svc.generateManifest('IT', 'PANTS')).requirementsEnforced).toBeUndefined()
  })

  it('union manifest maps requirementsEnforced per member type; all-absent → undefined', async () => {
    const svc = svcFor({ SHIRT: defWithEnforcement('NOT_ENFORCED'), PANTS: defWithEnforcement('ENFORCED'), COAT: defWithEnforcement() })
    const union = await svc.generateUnionManifest('IT', ['SHIRT', 'PANTS', 'COAT'])
    expect(union.requirementsEnforcedByType).toEqual({ SHIRT: 'NOT_ENFORCED', PANTS: 'ENFORCED' })
    const bare = await svc.generateUnionManifest('IT', ['COAT'])
    expect(bare.requirementsEnforcedByType).toBeUndefined()
  })
})

describe('UFX P6g — preflight missing-required downgrade for PARTIAL_UPDATE + NOT_ENFORCED', () => {
  const required = [{ id: 'item_name', label: 'Title' }]
  const severityOf = (row: Record<string, any>, requirementsEnforced?: string) =>
    preflightRow(row, required, [], { requirementsEnforced })
      .find((i) => i.field === 'item_name')?.severity

  it('NOT_ENFORCED + partial-update row → warning (submit is not blocked-by-error)', () => {
    expect(severityOf({ item_sku: 'S1' }, 'NOT_ENFORCED')).toBe('warning')
    expect(severityOf({ item_sku: 'S1', record_action: 'partial_update' }, 'NOT_ENFORCED')).toBe('warning')
  })

  it('full_update / new rows keep the hard error even when NOT_ENFORCED (they submit requirements)', () => {
    expect(severityOf({ item_sku: 'S1', record_action: 'full_update' }, 'NOT_ENFORCED')).toBe('error')
    expect(severityOf({ item_sku: 'S1', _isNew: true }, 'NOT_ENFORCED')).toBe('error')
  })

  it("ENFORCED or absent (pre-capture schema) → error, conservative default", () => {
    expect(severityOf({ item_sku: 'S1' }, 'ENFORCED')).toBe('error')
    expect(severityOf({ item_sku: 'S1' }, undefined)).toBe('error')
  })
})

describe('UFX P6g — schema-sync captures envelope requirementsEnforced additively', () => {
  const makeDeps = (existing: any) => {
    const created: any[] = []
    const updated: any[] = []
    const prisma = {
      categorySchema: {
        findFirst: vi.fn(async () => existing),
        findUnique: vi.fn(async () => existing),
        create: vi.fn(async ({ data }: any) => { created.push(data); return data }),
        update: vi.fn(async (args: any) => { updated.push(args); return args }),
      },
      schemaChange: { create: vi.fn() },
      $transaction: vi.fn(async () => []),
    }
    const envelope = {
      productType: 'SHIRT',
      productTypeVersion: { version: 'REL_2' },
      schema: { link: { resource: 'https://example.test/schema.json', verb: 'GET' }, checksum: 'x' },
      requirements: 'LISTING',
      requirementsEnforced: 'NOT_ENFORCED',
      propertyGroups: { details: { title: 'Details', propertyNames: ['item_name'] } },
    }
    const amazon = { isConfigured: () => true, getClient: async () => ({ callAPI: async () => envelope }) }
    return { prisma, amazon, created, updated }
  }
  const stubFetch = () => vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ required: ['item_name'], properties: { item_name: wrappedString() } }),
  })))

  it('new-version path stores __requirementsEnforced on schemaDefinition (no migration)', async () => {
    stubFetch()
    try {
      const { prisma, amazon, created } = makeDeps(null)
      const svc = new CategorySchemaService(prisma as any, amazon as any)
      await svc.refreshSchema({ channel: 'AMAZON', marketplace: 'IT', productType: 'SHIRT' })
      expect(created).toHaveLength(1)
      expect(created[0].schemaDefinition.__requirementsEnforced).toBe('NOT_ENFORCED')
      expect(created[0].schemaDefinition.__propertyGroups).toBeDefined()
    } finally { vi.unstubAllGlobals() }
  })

  it('same-version bump path BACKFILLS a cached row missing __requirementsEnforced', async () => {
    stubFetch()
    try {
      const existing = {
        id: 'row1',
        schemaVersion: 'REL_2',
        // Cached before the capture: has __propertyGroups but not __requirementsEnforced.
        schemaDefinition: { properties: {}, __propertyGroups: { details: {} } },
      }
      const { prisma, amazon, updated } = makeDeps(existing)
      const svc = new CategorySchemaService(prisma as any, amazon as any)
      await svc.refreshSchema({ channel: 'AMAZON', marketplace: 'IT', productType: 'SHIRT' })
      expect(updated).toHaveLength(1)
      expect(updated[0].data.schemaDefinition.__requirementsEnforced).toBe('NOT_ENFORCED')
    } finally { vi.unstubAllGlobals() }
  })
})
