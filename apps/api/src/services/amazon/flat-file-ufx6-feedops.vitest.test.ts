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
import {
  AmazonFlatFileService,
  buildSchemaFieldHints,
  dedupCellsBySelectors,
  findEnumDeprecated,
  normalizeVariationTheme,
} from './flat-file.service.js'
import { CategorySchemaService } from '../categories/schema-sync.service.js'
import { buildPerTypeValidation, checkDeprecatedValues, preflightRow } from '../listing-preflight.service.js'

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

// ── P6g-3 — meta-schema `selectors` honored in the numbered-column reassembly ─

describe('UFX P6g — buildSchemaFieldHints captures selectors per attribute', () => {
  it('top-level selectors are captured; attributes without them are absent', () => {
    const { selectorsByField } = buildSchemaFieldHints({
      // Real shape: bullet_point [marketplace_id, language_tag], maxUniqueItems 10.
      bullet_point: {
        type: 'array', maxUniqueItems: 10, selectors: ['marketplace_id', 'language_tag'],
        items: { type: 'object', properties: { value: { type: 'string' }, language_tag: {}, marketplace_id: {} } },
      },
      // Real shape: ghs_chemical_h_code [marketplace_id, value] — value IS a selector.
      ghs_chemical_h_code: {
        type: 'array', maxUniqueItems: 100, selectors: ['marketplace_id', 'value'],
        items: { type: 'object', properties: { value: { type: 'string' }, marketplace_id: {} } },
      },
      color: {
        type: 'array',
        items: { type: 'object', properties: { value: { type: 'string' }, language_tag: {}, marketplace_id: {} } },
      },
    })
    expect(selectorsByField.bullet_point).toEqual(['marketplace_id', 'language_tag'])
    expect(selectorsByField.ghs_chemical_h_code).toEqual(['marketplace_id', 'value'])
    expect(selectorsByField.color).toBeUndefined()
  })
})

describe('UFX P6g — dedupCellsBySelectors', () => {
  const mp = 'APJ6JRA9NG5V4'
  const bp = (value: string) => ({ value, language_tag: 'it_IT', marketplace_id: mp })

  it('infra-only selectors (bullet_point shape): distinct values ALL survive — never collapse to one', () => {
    const cells = [bp('A'), bp('B'), bp('C'), bp('D'), bp('E')]
    expect(dedupCellsBySelectors(cells, ['marketplace_id', 'language_tag'])).toEqual(cells)
  })

  it('infra-only selectors: a true duplicate value is dropped, first wins, order preserved', () => {
    expect(dedupCellsBySelectors([bp('A'), bp('B'), bp('A'), bp('C')], ['marketplace_id', 'language_tag']))
      .toEqual([bp('A'), bp('B'), bp('C')])
  })

  it('content selector (ghs shape [marketplace_id, value]): equal tuple = duplicate under Amazon rule', () => {
    const cells = [
      { value: 'H200', marketplace_id: mp },
      { value: 'H201', marketplace_id: mp },
      { value: 'H200', marketplace_id: mp },
    ]
    expect(dedupCellsBySelectors(cells, ['marketplace_id', 'value'])).toEqual([
      { value: 'H200', marketplace_id: mp },
      { value: 'H201', marketplace_id: mp },
    ])
  })

  it('no selectors / single cell → unchanged (legacy behavior)', () => {
    const cells = [bp('A'), bp('A')]
    expect(dedupCellsBySelectors(cells, undefined)).toEqual(cells)
    expect(dedupCellsBySelectors(cells, [])).toEqual(cells)
    expect(dedupCellsBySelectors([bp('A')], ['marketplace_id'])).toEqual([bp('A')])
  })
})

describe('UFX P6g — feed builder dedups numbered columns by schema selectors', () => {
  const feedSchemaWithSelectors = {
    localizedFields: new Set(['bullet_point']),
    selectorsByField: { bullet_point: ['marketplace_id', 'language_tag'] },
    // Numbered columns come from the manifest's expandedFields map.
  }
  const expanded = { bullet_point_1: 'bullet_point', bullet_point_2: 'bullet_point', bullet_point_3: 'bullet_point' }

  it('duplicate bullet in two numbered columns is sent ONCE; distinct bullets untouched', () => {
    const r = feedSvc.buildJsonFeedBodyWithReport(
      [{ item_sku: 'S1', product_type: 'JACKET', bullet_point_1: 'Impermeabile', bullet_point_2: 'Traspirante', bullet_point_3: 'Impermeabile' }],
      'IT', 'SELLER', expanded, feedSchemaWithSelectors,
    )
    const values = JSON.parse(r.body).messages[0].attributes.bullet_point.map((c: any) => c.value)
    expect(values).toEqual(['Impermeabile', 'Traspirante'])
  })

  it('no schema selectors → legacy behavior (duplicates pass through)', () => {
    const r = feedSvc.buildJsonFeedBodyWithReport(
      [{ item_sku: 'S1', product_type: 'JACKET', bullet_point_1: 'A', bullet_point_2: 'A' }],
      'IT', 'SELLER', expanded, { localizedFields: new Set(['bullet_point']) },
    )
    const values = JSON.parse(r.body).messages[0].attributes.bullet_point.map((c: any) => c.value)
    expect(values).toEqual(['A', 'A'])
  })
})

// ── P6g-4 — $lifecycle.enumDeprecated → deprecatedOptions + preflight warning ─

// Shapes mirror the REAL carriers found in the live cached schemas:
// variation_theme.items.properties.name.$lifecycle.enumDeprecated and
// vehicle_fitment.items.properties.standard.items.properties.value.$lifecycle.
const deprecationDef: Record<string, any> = {
  required: [],
  properties: {
    variation_theme: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            enum: ['COLOR/SIZE', 'COLOR_NAME', 'SIZE_NAME'],
            // GONE_THEME is deprecated AND already dropped from the enum —
            // it must NOT appear (the accepted-set check owns dropped values).
            $lifecycle: { enumDeprecated: ['COLOR_NAME', 'SIZE_NAME', 'GONE_THEME'] },
          },
          marketplace_id: {},
        },
      },
    },
    // Top-level enum whose display labels differ from the codes.
    target_gender: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          value: {
            type: 'string',
            enum: ['male', 'female'],
            enumNames: ['Maschio', 'Femmina'],
            $lifecycle: { enumDeprecated: ['male'] },
          },
          marketplace_id: {},
        },
      },
    },
    // Pattern C attribute with a deprecated sub-property enum (the real
    // vehicle_fitment case: "tecdoc" deprecated, "ktype" is the successor).
    fitment_like: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          standard: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                value: {
                  type: 'string',
                  enum: ['ktype', 'tecdoc'],
                  enumNames: ['KType (TecDoc)', 'TecDoc'],
                  $lifecycle: { enumDeprecated: ['tecdoc'] },
                },
                marketplace_id: {},
              },
            },
          },
          note: { type: 'string' },
          marketplace_id: {},
        },
      },
    },
  },
  __propertyGroups: {
    details: { title: 'Details', propertyNames: ['target_gender', 'fitment_like'] },
  },
}

const colById = (m: { groups: Array<{ columns: any[] }> }, id: string) =>
  m.groups.flatMap((g) => g.columns).find((c) => c.id === id)

describe('UFX P6g — $lifecycle.enumDeprecated → manifest deprecatedOptions', () => {
  it('findEnumDeprecated finds the marker wherever the enum sits (mirrors findEnumNode)', () => {
    expect(findEnumDeprecated(deprecationDef.properties.variation_theme)).toEqual(['COLOR_NAME', 'SIZE_NAME', 'GONE_THEME'])
    expect(findEnumDeprecated(deprecationDef.properties.target_gender)).toEqual(['male'])
    expect(findEnumDeprecated(deprecationDef.properties.fitment_like.items.properties.standard)).toEqual(['tecdoc'])
    expect(findEnumDeprecated(deprecationDef.properties.fitment_like.items.properties.note ?? {})).toEqual([])
  })

  it('top-level enum column: deprecated code + its differing label; dropped values excluded', async () => {
    const svc = svcFor({ SHIRT: deprecationDef })
    const m = await svc.generateManifest('IT', 'SHIRT')
    expect(colById(m, 'target_gender')?.deprecatedOptions).toEqual(['male', 'Maschio'])
  })

  it('variation_theme column tags still-offered deprecated themes only', async () => {
    const svc = svcFor({ SHIRT: deprecationDef })
    const m = await svc.generateManifest('IT', 'SHIRT')
    const vt = colById(m, 'variation_theme')
    expect(vt?.deprecatedOptions).toEqual(['COLOR_NAME', 'SIZE_NAME'])
    // Deprecated themes stay SELECTABLE — warn-only, never removed.
    expect(vt?.options).toContain('COLOR_NAME')
  })

  it('Pattern C sub-column (vehicle_fitment__standard shape) carries deprecatedOptions', async () => {
    const svc = svcFor({ SHIRT: deprecationDef })
    const m = await svc.generateManifest('IT', 'SHIRT')
    expect(colById(m, 'fitment_like__standard')?.deprecatedOptions).toEqual(['tecdoc', 'TecDoc'])
  })

  it('union manifest merges deprecatedOptions by set union across member types', async () => {
    const otherDef = {
      ...deprecationDef,
      properties: {
        ...deprecationDef.properties,
        target_gender: {
          ...deprecationDef.properties.target_gender,
          items: {
            type: 'object',
            properties: {
              value: { type: 'string', enum: ['male', 'female'], enumNames: ['Maschio', 'Femmina'], $lifecycle: { enumDeprecated: ['female'] } },
              marketplace_id: {},
            },
          },
        },
      },
    }
    const svc = svcFor({ SHIRT: deprecationDef, PANTS: otherDef })
    const union = await svc.generateUnionManifest('IT', ['SHIRT', 'PANTS'])
    expect(new Set(colById(union, 'target_gender')?.deprecatedOptions)).toEqual(new Set(['male', 'Maschio', 'female', 'Femmina']))
  })
})

describe('UFX P6g — preflight warns on deprecated enum values', () => {
  const cols = [{ id: 'target_gender', label: 'Target Gender', values: ['male', 'Maschio'] }]

  it('deprecated value (code or label, case-insensitive) → WARNING, never error', () => {
    for (const v of ['male', 'Maschio', 'MASCHIO']) {
      const issues = checkDeprecatedValues({ target_gender: v }, cols)
      expect(issues).toHaveLength(1)
      expect(issues[0].severity).toBe('warning')
      expect(issues[0].message).toContain('deprecated')
    }
    expect(checkDeprecatedValues({ target_gender: 'Femmina' }, cols)).toEqual([])
    expect(checkDeprecatedValues({ target_gender: '' }, cols)).toEqual([])
  })

  it('includes the replacement when one is named (no live schema names one — probed 2026-07-11)', () => {
    const withRepl = [{ id: 'std', label: 'Standard', values: ['tecdoc'], replacementByValue: { tecdoc: 'KType (TecDoc)' } }]
    const [issue] = checkDeprecatedValues({ std: 'tecdoc' }, withRepl)
    expect(issue.message).toContain('use "KType (TecDoc)" instead')
  })

  it('variation_theme historical spellings are caught via the normalizer', () => {
    const vtCols = [{ id: 'variation_theme', label: 'Variation Theme', values: ['SIZE_NAME/COLOR_NAME'] }]
    const normalize = (colId: string, v: string) =>
      colId === 'variation_theme' ? normalizeVariationTheme(v, { 'SIZE_NAME/COLOR_NAME': 'SIZE_NAME/COLOR_NAME' }) : v
    expect(checkDeprecatedValues({ variation_theme: 'SizeName-ColorName' }, vtCols, normalize)).toHaveLength(1)
    expect(checkDeprecatedValues({ variation_theme: 'SizeName-ColorName' }, vtCols)).toEqual([])
  })

  it('buildPerTypeValidation exposes deprecatedByType (variation_theme INCLUDED) and preflightRow wires it', async () => {
    const svc = svcFor({ SHIRT: deprecationDef })
    const union = await svc.generateUnionManifest('IT', ['SHIRT'])
    const { deprecatedByType } = buildPerTypeValidation(union)
    const cols = deprecatedByType.get('SHIRT') ?? []
    expect(cols.map((c) => c.id).sort()).toEqual(['fitment_like__standard', 'target_gender', 'variation_theme'])

    const issues = preflightRow({ item_sku: 'S1', target_gender: 'Maschio' }, [], [], { deprecatedColumns: cols })
    const dep = issues.find((i) => i.field === 'target_gender')
    expect(dep?.severity).toBe('warning')
    expect(dep?.message).toContain('deprecated')
  })
})
