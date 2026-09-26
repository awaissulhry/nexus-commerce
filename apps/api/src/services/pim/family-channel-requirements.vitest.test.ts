import { describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ attributes: vi.fn(), family: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { customAttribute: { findMany: db.attributes } } }))
vi.mock('../family-hierarchy.service.js', async () => ({ familyHierarchyService: (await import('../../test-support/family-service-mock.js')).familyServiceMock((id: string) => db.family(id)) }))
import { familySheetFields } from './family-sheet-schema.js'
import { buildSheetColumns, type SheetCoordinate } from './sheet-columns.service.js'
import { columnRequiredHere } from '@nexus/shared/master-sheet'

/**
 * PLAN Step 2.1 (A-14, approved) — a family requirement scoped to a channel must survive.
 *
 * 🔴 WHAT THIS GUARDS. `schema.prisma:736-739`: `required = true` with an EMPTY `channels` array
 * means required everywhere; `['AMAZON']` means required on Amazon. `family-sheet-schema.ts` read
 * `a.required && (a.channels?.length ?? 0) === 0`, which keeps the first case and DISCARDS the
 * second. Measured on the scale fixture before the fix: five attributes marked `required = true`
 * with a channel list came out of the column build with `requiredBy: []` — indistinguishable from
 * the ones marked optional. "Ready 100%" was true for everything and meant nothing.
 *
 * 🔴 ALL FOUR ARMS, because a fixture pins every dimension it does not vary and the arm that would
 * have failed is the one never run. The third arm — required on a channel that is NOT the one in
 * view — is the one the obvious wrong fix (`a.required` alone) gets wrong: it would mark an
 * Amazon-only attribute required on eBay.
 */
const coordinate = (channel: string, label: string): SheetCoordinate =>
  ({ channel, marketplace: 'DE', label, inMarket: true } as SheetCoordinate)
const AMAZON = coordinate('AMAZON', 'Amazon · DE')
const EBAY = coordinate('EBAY', 'eBay · DE')

const ATTRIBUTES = [
  { code: 'material', required: true, channels: [] },
  { code: 'browse_node', required: true, channels: ['AMAZON'] },
  { code: 'ebay_category', required: true, channels: ['EBAY'] },
  { code: 'season', required: false, channels: [] },
]

async function columnsFor(coordinates: SheetCoordinate[]) {
  db.attributes.mockResolvedValue(ATTRIBUTES.map((a, i) => ({
    id: a.code, code: a.code, label: a.code, type: 'text', options: [],
    group: { code: 'specs', label: 'Specifications' }, validation: {}, scope: 'global', sortOrder: i,
  })))
  db.family.mockResolvedValue(ATTRIBUTES.map((a, i) => ({ attributeId: a.code, required: a.required, channels: a.channels, sortOrder: i })))
  const fields = await familySheetFields(['jacket'])
  const { columns } = buildSheetColumns({ fields, coordinates, scopeKind: 'master', familySchema: true })
  return Object.fromEntries(columns.map(c => [c.key, c]))
}

describe('Step 2.1 — a family requirement scoped to a channel', () => {
  it('🔴 all four arms, with both coordinates in view', async () => {
    const col = await columnsFor([AMAZON, EBAY])
    const required = (key: string, label: string) => columnRequiredHere(col[key] as never, label, 'OUTERWEAR', 'jacket')

    // 1. required EVERYWHERE — the only arm that worked before.
    expect(col.material.requiredBy).toEqual(['Master'])
    expect(required('material', 'Master')).toBe(true)

    // 2. required on a channel, that channel IN VIEW.
    expect(col.browse_node.requiredBy).toEqual(['Amazon · DE'])
    expect(required('browse_node', 'Amazon · DE')).toBe(true)

    // 3. required on a channel, asked about a DIFFERENT channel. 🔴 The arm that catches the
    //    obvious wrong fix: reading `a.required` alone marks an Amazon-only attribute required on
    //    eBay, which is a different wrong answer, not a fix.
    expect(required('browse_node', 'eBay · DE')).toBe(false)
    expect(required('ebay_category', 'Amazon · DE')).toBe(false)
    expect(col.ebay_category.requiredBy).toEqual(['eBay · DE'])
    expect(required('ebay_category', 'eBay · DE')).toBe(true)

    // 4. not required at all.
    expect(col.season.requiredBy).toEqual([])
    expect(required('season', 'Master')).toBe(false)
    expect(required('season', 'Amazon · DE')).toBe(false)
  })

  it('🔴 a channel-scoped requirement is NOT a plain requirement on Shared', async () => {
    const col = await columnsFor([AMAZON, EBAY])
    // The step's `Done when`: *"as 'required by Amazon' on Shared"* — a marker, never a hard
    // requirement. `requiredBy` carries the label list the marker renders from; `Master` stays
    // false because `familyRules[...].required` still means required EVERYWHERE.
    expect(columnRequiredHere(col.browse_node as never, 'Master', 'OUTERWEAR', 'jacket')).toBe(false)
    expect(col.browse_node.requiredBy).toContain('Amazon · DE')
    expect(col.browse_node.requiredBy).not.toContain('Master')
  })

  it('🔴 a channel that is not in view is never required, and never invents a coordinate', async () => {
    const col = await columnsFor([AMAZON])
    expect(col.browse_node.requiredBy).toEqual(['Amazon · DE'])
    // eBay is not a coordinate here, so its requirement has nowhere to land. It must be empty
    // rather than carry a label for a coordinate the sheet is not showing.
    expect(col.ebay_category.requiredBy).toEqual([])
    expect(columnRequiredHere(col.ebay_category as never, 'eBay · DE', 'OUTERWEAR', 'jacket')).toBe(false)
  })

  it('an attribute with NO channels key behaves exactly as before — required everywhere', async () => {
    // The 486 rows in the real catalogue have `channels: []`, and older fixtures omit the key
    // entirely. Neither may change meaning.
    db.attributes.mockResolvedValue([{ id: 'a', code: 'lining', label: 'Lining', type: 'text', options: [], group: { code: 'specs', label: 'Specifications' }, validation: {}, scope: 'global' }])
    db.family.mockResolvedValue([{ attributeId: 'a', required: true, sortOrder: 0 }])
    const fields = await familySheetFields(['jacket'])
    expect(fields[0].required).toBe(true)
    expect(fields[0].requiredChannels).toEqual([])
    const { columns } = buildSheetColumns({ fields, coordinates: [AMAZON], scopeKind: 'master', familySchema: true })
    expect(columns.find(c => c.key === 'lining')!.requiredBy).toEqual(['Master'])
  })
})
