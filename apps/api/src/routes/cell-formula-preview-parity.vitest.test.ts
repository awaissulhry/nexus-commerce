vi.mock('../services/pim/product-category-context.js', () => ({ productCategoryContext: async () => ({ categories: ['OUTERWEAR'], byRow: new Map([['p1:', { channelCategoryId: 'OUTERWEAR' }]]) }) }))
/**
 * #782 — the preview must reach the SAME option verdict as the save, and a
 * refusal must name the field the way the SHEET HEADER names it.
 *
 * Two defects, one function:
 *   · the preview ran no option check at all, so `"maybe"` on a closed list
 *     previewed as `{ok:true, value:"maybe"}` and was then refused by the PUT.
 *     Measured live on Amazon·IT before this landed.
 *   · on a channel scope the catalogue supplied BOTH the option list and the
 *     field name, so the refusal said "Le batterie sono incluse?" while the
 *     header beside it said "Are batteries included?".
 *
 * Run: npx vitest run src/routes/cell-formula-preview-parity.vitest.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const productFindUnique = vi.fn()
const listingFindFirst = vi.fn()
const getStudioColumns = vi.fn()
const getFieldCatalogue = vi.fn()

vi.mock('../db.js', () => ({
  default: {
    product: { findUnique: (...a: unknown[]) => productFindUnique(...a) },
    channelListing: { findFirst: (...a: unknown[]) => listingFindFirst(...a) },
    cellFormula: { findMany: async () => [], findUnique: async () => null },
    marketplace: { findFirst: async () => ({ languages: ['it'] }) },
    auditLog: { findMany: async () => [] },
  },
}))
vi.mock('../services/audit-log.service.js', () => ({ auditLogService: { write: async () => {} } }))
vi.mock('../services/pim/workspace-destination.js', () => ({ resolveWorkspaceDestination: async (input: { accountId: string; aliasKey?: string }) => {
  if (input.accountId !== 'account-a') throw new Error('This account is not available for this channel.')
  return { accountId: input.accountId, aliasKey: input.aliasKey ?? '' }
} }))
vi.mock('../services/pim/studio-columns.js', () => ({ getStudioColumns: (...a: unknown[]) => getStudioColumns(...a) }))
vi.mock('../services/pim/schema-mapping.service.js', () => ({ getMappingForMarketplace: async () => ({ expressions: {} }) }))
vi.mock('../services/pim/value-map.service.js', () => ({ loadValueMapLookup: async () => undefined, loadSizeScaleLookup: async () => undefined }))
vi.mock('../services/pim/attribute-resolver.js', () => ({ resolveAttributes: () => ({}) }))
vi.mock('../services/pim/studio-sheet.service.js', () => ({ formulaLookupMap: () => ({}), resolveWriteRouting: (col: any, coordinate: unknown) => ({ writeField: col.writeField, writeTarget: coordinate ? 'channelListing' : 'master' }) }))
vi.mock('../services/pim/mapping/field-catalogue.service.js', () => ({
  getFieldCatalogue: (...a: unknown[]) => getFieldCatalogue(...a),
}))

import routes from './cell-formula.routes.js'

const PID = 'p1'
/** The header the operator reads — English on every coordinate. */
const COLUMN_LABEL = 'Are batteries included?'
/** What the CATALOGUE calls the same field on Amazon·IT. */
const CATALOGUE_LABEL = 'Le batterie sono incluse?'

let app: FastifyInstance
beforeEach(async () => {
  for (const m of [productFindUnique, listingFindFirst, getStudioColumns, getFieldCatalogue]) m.mockReset()
  productFindUnique.mockResolvedValue({ id: PID, parentId: null, productType: 'OUTERWEAR', variationAxes: [] })
  listingFindFirst.mockResolvedValue(null)
  getStudioColumns.mockResolvedValue({
    columns: [
      { key: 'batteries_included', writeField: 'attr_batteries_included', label: COLUMN_LABEL,
        kind: 'select', options: ['false', 'true'] },
      { key: 'manufacturer', writeField: 'manufacturer', label: 'Manufacturer', kind: 'text' },
    ],
  })
  getFieldCatalogue.mockResolvedValue({
    fields: [{
      fieldKey: 'batteries_included', label: CATALOGUE_LABEL,
      options: ['false', 'true'], optionLabels: { false: 'No', true: 'Sì' }, selectionOnly: true,
    }],
  })
  app = Fastify(); app.patch('/api/products/bulk', async () => ({ errors: [], wouldUpdate: 1 })); await app.register(routes); await app.ready()
})

const preview = (expr: string, over: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST', url: '/pim/formulas/preview',
    payload: {
      productId: PID, expr, fieldKey: 'batteries_included',
      scope: 'master', market: 'DE', locale: 'de', ...over,
    },
  })
const CHANNEL = { channelConnectionId: 'account-a', scope: 'channel', channel: 'AMAZON', marketplace: 'IT', market: 'IT', locale: 'it' }

describe('#782 preview parity — the option check runs on both scopes', () => {
  for (const [name, coord] of [['master', {}], ['channel Amazon·IT', CHANNEL]] as const) {
    describe(name, () => {
      it('a value INSIDE the list previews ok', async () => {
        const b = (await preview('"true"', coord)).json()
        expect(b.ok).toBe(true)
        expect(b.value).toBe('true')
        expect(b.error).toBeNull()
      })

      it('a value OUTSIDE the list is REFUSED, with the allowed set as data', async () => {
        const b = (await preview('"maybe"', coord)).json()
        expect(b.ok).toBe(false)
        expect(b.value).toBeNull()
        expect(b.error).toContain('not an allowed value')
        // Raw codes, untranslated — this half is data, not prose.
        expect(b.allowedOptions).toEqual(['false', 'true'])
        expect(b.actualValue).toBe('maybe')
      })

      it('a NON-SELECT column has no list, so nothing is refused', async () => {
        const b = (await preview('"anything at all"', { ...coord, fieldKey: 'manufacturer' })).json()
        expect(b.ok).toBe(true)
        expect(b.value).toBe('anything at all')
      })

      it('the preview returns the value as it would be STORED, not as typed', async () => {
        // checkOptions normalises to the canonical option; a preview showing
        // "TRUE" would disagree with the cell the save produces.
        const b = (await preview('"TRUE"', coord)).json()
        expect(b.ok).toBe(true)
        expect(b.value).toBe('true')
      })
    })
  }
})

describe('#782 the refusal names the field the way the HEADER does', () => {
  it('channel scope: the SHEET COLUMN label, not the catalogue label', async () => {
    const b = (await preview('"maybe"', CHANNEL)).json()
    expect(b.error).toContain(COLUMN_LABEL)
    // The bug this pins: the catalogue's own name must not reach the message.
    expect(b.error).not.toContain(CATALOGUE_LABEL)
  })

  it('channel scope: the OPTIONS keep the labels the cell list shows', async () => {
    // The field name is the header's; the option names are the catalogue's.
    // Both halves in one sentence, which is the whole point of the split.
    const b = (await preview('"maybe"', CHANNEL)).json()
    expect(b.error).toContain('No, Sì')
  })

  it('master scope: the same header label, and the raw codes as its options', async () => {
    const b = (await preview('"maybe"')).json()
    expect(b.error).toContain(COLUMN_LABEL)
    // No catalogue on master, so the column supplies the option names too.
    expect(b.error).toContain('false, true')
  })
})

vi.mock('../services/connection-resolver.service.js', () => ({ primaryConnectionIds: async () => new Map([['AMAZON', 'account-a'], ['EBAY', 'account-b']]) }))


it.each([
  { extra: { aliasKey: 'alias-b' }, reason: 'requires its account' },
  { extra: { channelConnectionId: 'account-b' }, reason: 'account is not available' },
])('refuses preview/save/delete on an invalid formula coordinate: %j', async ({ extra, reason }) => {
  const body = { productId: 'p1', fieldKey: 'manufacturer', expr: '"value"', scope: 'channel', channel: 'AMAZON', marketplace: 'IT', ...extra }
  for (const method of ['POST', 'PUT', 'DELETE'] as const) {
    const query = new URLSearchParams({ fieldKey: 'manufacturer', scope: 'channel', channel: 'AMAZON', marketplace: 'IT', ...extra } as Record<string, string>)
    const res = await app.inject({ method, url: method === 'POST' ? '/pim/formulas/preview' : '/pim/formulas/product/p1' + (method === 'DELETE' ? `?${query}` : ''),
      ...(method !== 'DELETE' ? { payload: body } : {}) })
    expect(res.statusCode, res.body).toBe(400)
    expect(res.json().error).toContain(reason)
  }
})
