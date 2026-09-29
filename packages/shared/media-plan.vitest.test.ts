import { describe, expect, it } from 'vitest'
import { applyMediaOps, emptyMediaPlan, inverseMediaOps, knownSetRefs, mediaLayerKey, MediaPlanEditError, mediaOpSchema, mediaPlanSchema, collapseVersionsInPlan, planAssetIds, replaceAssetInPlan, resolveAxis, resolveSet, resolveSwatch, type MediaPlan, type MediaPlanStack } from './media-plan'

const plan = (sets: MediaPlan['sets'], axis?: string | null): MediaPlan => ({ version: 1, ...(axis !== undefined ? { axis } : {}), sets })
const ids = (...list: string[]) => list.map(assetId => ({ assetId }))
const NERO = 'value:color:black' as const, GIALLO = 'value:color:yellow' as const

const shared = plan({ common: ids('cover', 'detail'), values: { 'color:black': ids('n1', 'n2'), 'color:yellow': ids('g1') } }, 'color')

describe('media plan layers', () => {
  it('a lower layer wins only for the sets it owns; an empty array is an owned empty set', () => {
    const stack: MediaPlanStack = { shared, channel: plan({ values: { 'color:black': ids('n9') } }), listing: plan({ common: [] }) }
    expect(resolveSet(stack, 'common')).toEqual({ items: [], source: 'LISTING' })
    expect(resolveSet(stack, NERO)).toEqual({ items: ['n9'], source: 'CHANNEL' })
    expect(resolveSet(stack, GIALLO)).toEqual({ items: ['g1'], source: 'SHARED' })
    expect(resolveSet(stack, 'safety')).toEqual({ items: [], source: null })
  })
  it('resolves the axis and swatches by layer, and lists sets only a lower layer knows', () => {
    const stack: MediaPlanStack = { shared: plan({ swatches: { 'color:black': { assetId: 's1' } } }, 'color'), listing: plan({ skus: { child9: ids('x') }, swatches: { 'color:black': null } }, null) }
    expect(resolveAxis(stack, 'size')).toEqual({ axis: null, source: 'LISTING' })
    expect(resolveAxis({ shared: emptyMediaPlan() }, 'size')).toEqual({ axis: 'size', source: null })
    expect(resolveSwatch(stack, 'color:black')).toEqual({ assetId: null, source: 'LISTING' })
    expect(resolveSwatch({ shared: stack.shared }, 'color:black')).toEqual({ assetId: 's1', source: 'SHARED' })
    expect(knownSetRefs(stack)).toContain('sku:child9')
  })
  it('an Amazon market layer sits below its account layer: it wins only for what it owns, and edits touch it alone', () => {
    const account = plan({ values: { 'color:black': ids('a1') }, swatches: { 'color:black': { assetId: 's1' } } })
    const market = plan({ common: ids('de-cover') })
    const stack: MediaPlanStack = { shared, channel: null, listing: account, market }
    expect(resolveSet(stack, 'common')).toEqual({ items: ['de-cover'], source: 'MARKET' })
    expect(resolveSet(stack, NERO)).toEqual({ items: ['a1'], source: 'LISTING' })
    expect(resolveSet(stack, GIALLO)).toEqual({ items: ['g1'], source: 'SHARED' })
    expect(resolveSwatch(stack, 'color:black')).toEqual({ assetId: 's1', source: 'LISTING' })
    expect(knownSetRefs({ shared: emptyMediaPlan(), market: plan({ skus: { child9: [] } }) })).toContain('sku:child9')
    const next = applyMediaOps(stack, 'MARKET', [{ op: 'insert', set: NERO, assetIds: ['de-nero'], index: 0 }])
    expect(next.sets).toEqual({ common: ids('de-cover'), values: { 'color:black': ids('de-nero', 'a1') } })
    expect(stack.listing).toBe(account)
    // "Reset to shared" on the market drops its copy: the account's photos show again.
    const back = applyMediaOps({ ...stack, market: next }, 'MARKET', [{ op: 'follow', set: NERO }])
    expect(resolveSet({ ...stack, market: back }, NERO)).toEqual({ items: ['a1'], source: 'LISTING' })
    expect(inverseMediaOps('MARKET', market, next)).toEqual([{ op: 'follow', set: NERO, expect: ['de-nero', 'a1'] }])
  })
  it('keys layers the way the table stores them', () => {
    expect(mediaLayerKey({ layer: 'SHARED' })).toBe('SHARED')
    expect(mediaLayerKey({ layer: 'CHANNEL', channel: 'EBAY' })).toBe('CHANNEL:EBAY')
    expect(mediaLayerKey({ layer: 'LISTING', channel: 'EBAY', marketplace: 'IT', accountId: 'acc', aliasKey: 'a1' })).toBe('LISTING:EBAY:IT:acc:a1')
  })
  it('refuses malformed plans and value keys', () => {
    expect(mediaPlanSchema.safeParse(plan({ values: { Nero: ids('a') } })).success).toBe(false)
    expect(mediaPlanSchema.safeParse(plan({ values: { 'color:text:nerolucido': ids('a') } })).success).toBe(true)
    expect(mediaPlanSchema.safeParse({ version: 2, sets: {} }).success).toBe(false)
    expect(mediaOpSchema.safeParse({ op: 'insert', set: 'value:Nero', assetIds: ['a'] }).success).toBe(false)
  })
})

describe('media plan edits', () => {
  it('inserts at a position and never adds a photo twice to one set', () => {
    const next = applyMediaOps({ shared }, 'SHARED', [{ op: 'insert', set: 'common', assetIds: ['new'], index: 1 }])
    expect(next.sets.common).toEqual(ids('cover', 'new', 'detail'))
    expect(() => applyMediaOps({ shared }, 'SHARED', [{ op: 'insert', set: 'common', assetIds: ['cover'] }])).toThrow(MediaPlanEditError)
    expect(() => applyMediaOps({ shared }, 'SHARED', [{ op: 'insert', set: 'common', assetIds: ['a', 'a'] }])).toThrow(MediaPlanEditError)
  })
  it('counts language versions of one photo as the same photo', () => {
    const sameGroup = (a: string, b: string) => a === b || (a.startsWith('chart') && b.startsWith('chart'))
    const withChart = applyMediaOps({ shared }, 'SHARED', [{ op: 'insert', set: 'common', assetIds: ['chart-it'] }], sameGroup)
    expect(() => applyMediaOps({ shared: withChart }, 'SHARED', [{ op: 'insert', set: 'common', assetIds: ['chart-de'] }], sameGroup)).toThrow(MediaPlanEditError)
  })
  it('D8: the same photo may sit in Common and in a colour set on purpose, but a move never makes a copy', () => {
    const also = applyMediaOps({ shared }, 'SHARED', [{ op: 'insert', set: NERO, assetIds: ['cover'], index: 0 }])
    expect(also.sets.common?.[0]).toEqual({ assetId: 'cover' })
    expect(also.sets.values?.['color:black']).toEqual(ids('cover', 'n1', 'n2'))
    const moved = applyMediaOps({ shared }, 'SHARED', [{ op: 'move', from: 'common', to: GIALLO, assetId: 'detail', index: 0 }])
    expect(moved.sets.common).toEqual(ids('cover'))
    expect(moved.sets.values?.['color:yellow']).toEqual(ids('detail', 'g1'))
    expect(() => applyMediaOps({ shared: also }, 'SHARED', [{ op: 'move', from: 'common', to: NERO, assetId: 'cover', index: 0 }])).toThrow(MediaPlanEditError)
  })
  it('moves within a set to any position and keeps the order dense', () => {
    const next = applyMediaOps({ shared }, 'SHARED', [{ op: 'move', from: NERO, to: NERO, assetId: 'n2', index: 0 }])
    expect(next.sets.values?.['color:black']).toEqual(ids('n2', 'n1'))
  })
  it('editing an inherited set on a lower layer copies it there first and leaves the layers above alone', () => {
    const stack: MediaPlanStack = { shared, channel: null, listing: null }
    const listing = applyMediaOps(stack, 'LISTING', [{ op: 'remove', set: NERO, assetId: 'n1' }])
    expect(listing).toEqual(plan({ values: { 'color:black': ids('n2') } }))
    expect(shared.sets.values?.['color:black']).toEqual(ids('n1', 'n2'))
  })
  it('own copies and follow drops a layer copy; Shared cannot follow anything', () => {
    const owned = applyMediaOps({ shared, channel: null }, 'CHANNEL', [{ op: 'own', set: 'common' }])
    expect(owned.sets.common).toEqual(ids('cover', 'detail'))
    expect(applyMediaOps({ shared, channel: owned }, 'CHANNEL', [{ op: 'follow', set: 'common' }])).toEqual(emptyMediaPlan())
    expect(() => applyMediaOps({ shared }, 'SHARED', [{ op: 'follow', set: 'common' }])).toThrow(MediaPlanEditError)
    // A per-SKU set CAN be dropped on Shared: the SKU shows its value's photos again.
    const withSku = applyMediaOps({ shared }, 'SHARED', [{ op: 'replace', set: 'sku:child9', assetIds: ['n1'] }])
    expect(applyMediaOps({ shared: withSku }, 'SHARED', [{ op: 'follow', set: 'sku:child9' }]).sets.skus).toBeUndefined()
    expect(inverseMediaOps('SHARED', shared, withSku)).toEqual([{ op: 'follow', set: 'sku:child9', expect: ['n1'] }])
    // Shared can drop its axis choice: the family's default axis applies again.
    expect(applyMediaOps({ shared }, 'SHARED', [{ op: 'axis', axis: undefined }]).axis).toBeUndefined()
  })
  it('reorder must be the same photos — a concurrent change is refused, not merged', () => {
    expect(applyMediaOps({ shared }, 'SHARED', [{ op: 'reorder', set: 'common', assetIds: ['detail', 'cover'] }]).sets.common).toEqual(ids('detail', 'cover'))
    expect(() => applyMediaOps({ shared }, 'SHARED', [{ op: 'reorder', set: 'common', assetIds: ['detail'] }])).toThrow(MediaPlanEditError)
  })
  it('sets and clears the axis and swatches per layer', () => {
    const listing = applyMediaOps({ shared, listing: null }, 'LISTING', [{ op: 'axis', axis: null }, { op: 'swatch', value: 'color:black', assetId: 'sw' }])
    expect(listing).toEqual(plan({ swatches: { 'color:black': { assetId: 'sw' } } }, null))
    const back = applyMediaOps({ shared, listing }, 'LISTING', [{ op: 'axis', axis: undefined }, { op: 'swatch', value: 'color:black', assetId: undefined }])
    expect(back).toEqual(emptyMediaPlan())
  })
  it('replace sets a set exactly and refuses when the layer changed since (expect)', () => {
    expect(applyMediaOps({ shared }, 'SHARED', [{ op: 'replace', set: 'common', assetIds: ['detail'], expect: ['cover', 'detail'] }]).sets.common).toEqual(ids('detail'))
    expect(() => applyMediaOps({ shared }, 'SHARED', [{ op: 'replace', set: 'common', assetIds: ['detail'], expect: ['cover'] }])).toThrow(MediaPlanEditError)
    expect(() => applyMediaOps({ shared }, 'SHARED', [{ op: 'replace', set: 'common', assetIds: ['a', 'a'] }])).toThrow(MediaPlanEditError)
    // expect: null = the layer must still follow that set.
    const own = plan({ common: ids('x') })
    expect(() => applyMediaOps({ shared, channel: own }, 'CHANNEL', [{ op: 'follow', set: 'common', expect: null }])).toThrow(MediaPlanEditError)
  })
  it('undo ops put a layer back exactly, set by set, and refuse after a later change', () => {
    const cases: Array<[MediaPlanStack, 'SHARED' | 'CHANNEL', Parameters<typeof applyMediaOps>[2]]> = [
      [{ shared }, 'SHARED', [{ op: 'move', from: NERO, to: 'common', assetId: 'n2', index: 0 }]],
      [{ shared }, 'SHARED', [{ op: 'insert', set: 'value:color:red', assetIds: ['r1'] }, { op: 'axis', axis: 'size' }, { op: 'swatch', value: 'color:black', assetId: 's1' }]],
      [{ shared, channel: null }, 'CHANNEL', [{ op: 'remove', set: GIALLO, assetId: 'g1' }, { op: 'axis', axis: null }]],
      [{ shared, channel: plan({ common: ids('detail') }) }, 'CHANNEL', [{ op: 'follow', set: 'common' }]],
    ]
    for (const [stack, layer, ops] of cases) {
      const key = layer === 'SHARED' ? 'shared' : 'channel'
      const before = stack[key] ?? null
      const after = applyMediaOps(stack, layer, ops)
      const undo = inverseMediaOps(layer, before, after)
      const back = applyMediaOps({ ...stack, [key]: after }, layer, undo)
      // On Shared a new set comes back empty (it shows the same as absent); every other layer comes back byte for byte.
      const strip = (p: MediaPlan | null) => JSON.parse(JSON.stringify(p ?? emptyMediaPlan(), (k, v) => Array.isArray(v) && !v.length && k !== 'common' ? undefined : v))
      expect(strip(back)).toEqual(strip(before))
      const redo = inverseMediaOps(layer, after, back)
      expect(applyMediaOps({ ...stack, [key]: back }, layer, redo)).toEqual(after)
    }
    const after = applyMediaOps({ shared }, 'SHARED', [{ op: 'remove', set: 'common', assetId: 'cover' }])
    const later = applyMediaOps({ shared: after }, 'SHARED', [{ op: 'insert', set: 'common', assetIds: ['x'] }])
    expect(() => applyMediaOps({ shared: later }, 'SHARED', inverseMediaOps('SHARED', shared, after))).toThrow(MediaPlanEditError)
  })
  it('lists every photo a plan points at', () => {
    expect(planAssetIds(plan({ common: ids('a'), values: { 'color:black': ids('b') }, skus: { c1: ids('c') }, swatches: { 'color:black': { assetId: 'd' } }, safety: ids('e') })).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('same photo at two addresses (W4a)', () => {
  const base: MediaPlan = { version: 1, axis: 'color', sets: { common: ids('amz', 'cover'), values: { 'color:black': ids('n1', 'amz'), 'color:yellow': ids('ours', 'amz') },
    skus: { p1: ids('amz') }, swatches: { 'color:black': { assetId: 'amz' }, 'color:yellow': null }, safety: ids('ps1') } }
  it('puts the kept photo where the copy was, and drops the copy where the set already shows the kept one', () => {
    const next = replaceAssetInPlan(base, 'amz', 'ours')
    expect(next.sets.common).toEqual(ids('ours', 'cover'))
    expect(next.sets.values).toEqual({ 'color:black': ids('n1', 'ours'), 'color:yellow': ids('ours') })
    expect(next.sets.skus).toEqual({ p1: ids('ours') })
    expect(next.sets.swatches).toEqual({ 'color:black': { assetId: 'ours' }, 'color:yellow': null })
    expect(next.sets.safety).toEqual(ids('ps1'))
  })
  it('counts a copy or a language version of the kept photo as the kept photo; leaves a plan without the copy as it is', () => {
    const plan: MediaPlan = { version: 1, sets: { common: ids('ours-de', 'amz') } }
    expect(replaceAssetInPlan(plan, 'amz', 'ours', (a, b) => a.startsWith(b)).sets.common).toEqual(ids('ours-de'))
    const other: MediaPlan = { version: 1, sets: { common: ids('cover') } }
    expect(replaceAssetInPlan(other, 'amz', 'ours')).toBe(other)
  })
})

describe('language versions of one photo (W4b)', () => {
  it('a set that holds two versions keeps the main-language one in its place; one version per set is left alone', () => {
    const plan: MediaPlan = { version: 1, sets: { common: ids('cover', 'chart-es', 'chart-it', 'chart-fr'), values: { 'color:black': ids('chart-fr', 'n1') } } }
    const next = collapseVersionsInPlan(plan, ['chart-it', 'chart-es', 'chart-fr'], 'chart-it')
    expect(next.sets.common).toEqual(ids('cover', 'chart-it'))
    expect(next.sets.values).toEqual({ 'color:black': ids('chart-fr', 'n1') })
    // Without the main-language one in the set, the first member in set order stays.
    expect(collapseVersionsInPlan({ version: 1, sets: { common: ids('chart-fr', 'chart-es') } }, ['chart-it', 'chart-es', 'chart-fr'], 'chart-it').sets.common).toEqual(ids('chart-fr'))
    expect(collapseVersionsInPlan(plan, ['n1', 'cover'], 'n1')).toBe(plan)
  })
})
