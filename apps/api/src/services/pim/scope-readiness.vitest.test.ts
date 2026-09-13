vi.mock('./family-account.js', () => ({ readFamilyAccountId: async (_id: string, channel: string) => `account-${channel}` }))
import { describe, expect, it, vi } from 'vitest'
vi.mock('./studio-sheet.service.js', () => ({ getStudioSheet: vi.fn() }))
vi.mock('./studio-columns.js', () => ({ getStudioColumns: vi.fn() }))
const db = vi.hoisted(() => ({ product: { findFirstOrThrow: vi.fn(async () => ({ id: 'p', parentId: null })) }, readinessIndex: { findMany: vi.fn() }, marketplace: { findMany: vi.fn() } }))
vi.mock('../../db.js', () => ({ default: db }))
import { getProductReadiness, readinessFromSheet, summarizeReadinessIndex } from './scope-readiness.service.js'
import { getStudioSheet } from './studio-sheet.service.js'
import { getStudioColumns } from './studio-columns.js'
const sheet = (mapping: unknown): any => ({
  schema: { locale: 'it' },
  scope: { kind: 'channel', channel: 'AMAZON', label: 'Amazon · IT' }, aliases: [],
  rows: [{ completeness: { required: { filled: 1, total: 1 } }, readiness: { issues: [] } }],
  meta: { schemaMissing: [], mapping },
})

it('reads the index at GLOBAL without constructing any sheet or column set', async () => {
  db.marketplace.findMany.mockResolvedValue([{ channel: 'SHOPIFY', code: 'GLOBAL', languages: ['en'] }])
  db.readinessIndex.findMany.mockResolvedValue([{ productId: 'p', channel: 'SHOPIFY', market: 'GLOBAL', accountId: 'account-SHOPIFY', aliasId: null,
    coordinateKey: '["SHOPIFY","GLOBAL","account-SHOPIFY",null]', language: 'en', label: 'Shopify · GLOBAL', pct: 100, state: 'ready', requiredFilled: 1, requiredTotal: 1, missing: [], computedAt: new Date(), mappingRules: 1 }])
  const result = await getProductReadiness({ productId: 'p', market: 'IT', locale: 'en' })
  expect(result.scopes.find(s => s.id === 'SHOPIFY')).toMatchObject({ pct: 100, state: 'ready' })
  expect(result.matrix[0]).toMatchObject({ market: 'GLOBAL', accountId: 'account-SHOPIFY', language: 'en' })
  expect(getStudioSheet).not.toHaveBeenCalled(); expect(getStudioColumns).not.toHaveBeenCalled()
  const german = await getProductReadiness({ productId: 'p', market: 'IT', locale: 'de' })
  // R-LX-9: German has NO index row for Shopify, which is `notComputed` — not
  // `absent` ("nothing set up here"). The language summaries still show the
  // computed English verdict beside it.
  expect(german.scopes.find(s => s.id === 'SHOPIFY')).toMatchObject({ pct: null, state: 'notComputed', languages: [{ language: 'en', state: 'ready', pct: 100 }] })
})
it('weights family counts, preserves null and uses the scope state independently of percentage', () => {
  const c = { channel: 'AMAZON', market: 'DE', accountId: 'a', aliasId: null }
  const rows = [{ ...c, pct: 100, state: 'ready', requiredFilled: 1, requiredTotal: 1, missing: [], computedAt: new Date(), mappingRules: 1 },
    { ...c, pct: 0, state: 'blocked', requiredFilled: 0, requiredTotal: 9, missing: [], computedAt: new Date(), mappingRules: 1 }]
  expect(summarizeReadinessIndex(rows as any, c, 'de', 'Amazon')).toMatchObject({ pct: 10, state: 'blocked', required: { filled: 1, total: 10 } })
  expect(summarizeReadinessIndex([{ ...rows[0], pct: null }] as any, c, 'de', 'Amazon').pct).toBeNull()
  // R-LX-9: no rows is `notComputed`, and its note says so. A row that IS computed
  // and carries state `absent` still summarises as `absent` (the arm below).
  expect(summarizeReadinessIndex([], c, 'de', 'Amazon')).toMatchObject({ pct: null, state: 'notComputed', note: 'Readiness has not been computed for this language.' })
  expect(summarizeReadinessIndex([{ ...rows[0], state: 'absent', pct: null }] as any, c, 'de', 'Amazon')).toMatchObject({ pct: null, state: 'absent' })
})
describe('scope readiness uses verified effective channel values', () => {
  it('does not claim readiness when mapping failed or did not run', () => {
    for (const mapping of [null, { skippedReason: 'Timed out', missingProductIds: [] }, { skippedReason: null, missingProductIds: ['p'] }]) {
      expect(readinessFromSheet(sheet(mapping), 1)).toMatchObject({ pct: null, state: 'warn' })
    }
  })
  it('shows readiness after the mapping run completed', () => {
    expect(readinessFromSheet(sheet({ skippedReason: null, missingProductIds: [] }), 1)).toMatchObject({ pct: 100, state: 'ready' })
  })
  it('keeps filled-but-invalid effective values blocked', () => {
    const input = sheet({ skippedReason: null, missingProductIds: [] })
    input.rows[0].readiness.issues = [{ severity: 'error', message: 'Title too long' }]
    expect(readinessFromSheet(input, 1)).toMatchObject({ pct: 100, state: 'blocked' })
  })
})

it('the API scope vocabulary and the DS chip table are the SAME set (R-LX-9)', async () => {
  // Two lists, two apps: the API decides the state and the design system decides
  // its word and tone. A member added to one and not the other renders as a raw
  // string on the chip, so the set is derived from both sources and compared.
  const { SCOPE_STATES } = await import('./readiness-model.js')
  const { readFileSync } = await import('node:fs')
  const ds = readFileSync(new URL('../../../../web/src/design-system/grid/renderers/readiness.ts', import.meta.url), 'utf8')
  const table = ds.slice(ds.indexOf('const SCOPE:'))
  const members = [...table.slice(0, table.indexOf('\n}')).matchAll(/^\s{2}([A-Za-z]+):\s*\{ tone:/gm)].map(match => match[1])
  expect(members.length).toBeGreaterThan(0) // positive control: the table was found and parsed
  expect(members.sort()).toEqual([...SCOPE_STATES].sort())
  // LX.F F6 — and the ORDER is shared too: the DS declares the table in severity
  // order because `Object.keys(SCOPE)` is what every filter offers, and the API
  // sorts the catalogue by the same rank.
  const declared = [...table.slice(0, table.indexOf('\n}')).matchAll(/^\s{2}([A-Za-z]+):\s*\{ tone:/gm)].map(match => match[1])
  expect(declared).toEqual([...SCOPE_STATES])
})
