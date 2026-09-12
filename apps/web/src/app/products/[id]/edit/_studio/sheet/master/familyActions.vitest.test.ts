import { describe, expect, it, vi } from 'vitest'

import { actionsFor, contextOf, SELECTION, isRunnable, requiresTypedConfirm, validateImpact } from '@/design-system/grid/actions/registry'
import { runAction } from '@/design-system/grid/actions/runAction'

import { familyActions, PERM_DELETE, PERM_PIM, PERM_UNLINK, type FamilyActionContext } from './familyActions'
import type { FamilyResponse } from './family'
import type { StudioRow } from './types'

const row = (): StudioRow =>
  ({ id: 'c1', sku: 'GALE-BLACK-L', parentId: 'p', isParent: false, cells: {}, version: 1 } as unknown as StudioRow)
const child = (id: string, parentId: string | null = 'p') => ({ ...row(), id, sku: id, parentId }) as StudioRow

const family = (over: Partial<FamilyResponse> = {}): FamilyResponse => ({
  role: 'parent',
  self: { id: 'p', sku: 'GALE-JACKET', name: 'GALE', isParent: true, parentId: null, variationTheme: 'Colore,Taglia', variationAxes: ['Colore', 'Taglia'] },
  parent: null,
  children: [{ id: 'c1', sku: 'c1', name: null, variantAttributes: null }, { id: 'c2', sku: 'c2', name: null, variantAttributes: null }],
  siblings: [],
  ...over,
})

const ops = (over: Partial<FamilyActionContext['ops']> = {}) => ({
  attach: vi.fn(async () => ({ success: true, attached: 1, errors: [], parentId: 'p' })),
  unlink: vi.fn(async (ids: string[]) => ({ success: true, detached: ids.length })),
  reparent: vi.fn(async () => ({ success: true, productId: 'c1', newParentId: 'p2', oldParentId: 'p' })),
  promote: vi.fn(async () => ({ success: true, productId: 'p' })),
  listings: vi.fn(async () => []),
  deleteVariant: vi.fn(async () => ({ success: true })),
  demoteParent: vi.fn(async () => ({ success: true, productId: 'p' })),
  addVariation: vi.fn(async () => ({ success: true, data: { id: 'new', sku: 'NEW' } })),
  ...over,
})

const ctx = (over: Partial<FamilyActionContext> = {}): FamilyActionContext => ({
  family: family(), ops: ops(), can: () => true, authStatus: 'authed', ...over,
})

const find = (c: FamilyActionContext, id: string) => familyActions(c).find((a) => a.id === id)!
const yes = async () => true

describe('family product collection', () => {
  it.each(['attach-existing', 'reparent'])('silently cancels %s before confirmation or write', async id => {
    const o = ops(), ask = vi.fn(yes)
    const c = ctx({ ops: o, pickProduct: vi.fn(async () => null) })
    const action = find(c, id)
    expect(action.available([child('c1')])).toEqual({ kind: 'available' })
    expect(await runAction(action, [child('c1')], ask)).toEqual({ kind: 'cancelled' })
    expect(ask).not.toHaveBeenCalled()
    expect(o.attach).not.toHaveBeenCalled()
    expect(o.reparent).not.toHaveBeenCalled()
  })
  it('shows the chosen SKU and applies its ID only after confirmation', async () => {
    const o = ops(), pick = vi.fn(async () => ({ id: 'other-id', sku: 'OTHER-SKU' }))
    const action = find(ctx({ ops: o, pickProduct: pick }), 'attach-existing')
    const impact = await action.preflight!([])
    expect(impact.consequences?.[0]).toContain('OTHER-SKU')
    expect(o.attach).not.toHaveBeenCalled()
    await action.run([], impact)
    expect(o.attach).toHaveBeenCalledWith('p', ['other-id'], undefined)
  })
  it('excludes the child and its current parent from the move picker', async () => {
    const pick = vi.fn(async () => ({ id: 'p2', sku: 'P2' }))
    const action = find(ctx({ pickProduct: pick }), 'reparent')
    const impact = await action.preflight!([child('c1')])
    expect(pick).toHaveBeenCalledWith('parent', ['c1', 'p'])
    expect(impact.payload).toEqual({ productId: 'c1', newParentId: 'p2', expectedParentId: 'p' })
  })
  it('sends the exact reviewed children even if the family read changes before confirm', async () => {
    const o = ops(), c = ctx({ ops: o }), action = find(c, 'demote')
    const impact = await action.preflight!([])
    c.family!.children.push({ id: 'new', sku: 'NEW', name: null, variantAttributes: null })
    await action.run([], impact)
    expect(o.demoteParent).toHaveBeenCalledWith('p', true, ['c1', 'c2'])
  })
})

/**
 * 🔴 THE finding of F2. Unlink is served from `/api/amazon`, so the manifest gates it with
 * `channels.sync`; the other three live under `/api/pim` and want `pim.manage`. An operator can
 * hold one set and not the other, in either direction, and nothing about the verb's NAME hints at
 * it. Without this, Unlink looks identical to its neighbours and fails at press-time with a bare
 * "Access denied" — a missing permission indistinguishable from a bug.
 */
describe('the permission split between /api/pim and /api/amazon', () => {
  it('pim.manage alone does NOT unlock unlink', () => {
    const c = ctx({ can: (p) => p === PERM_PIM })
    const a = find(c, 'unlink').available([child('c1')])
    expect(a).toEqual({ kind: 'disabled', reason: `Unlinking needs the "${PERM_UNLINK}" permission, which this account does not have` })
  })

  /**
   * 🔴 The lie this prevents, found on screen. Against the local API on :8091 the browser holds no
   * session cookie, `/api/auth/me` answers 401 and every `can()` is false — while the account is
   * the Owner. "which this account does not have" is then a confident falsehood about a real
   * person's permissions. Three auth states, three different sentences.
   */
  it('an unauthenticated session says so, instead of blaming the account', () => {
    const c = ctx({ can: () => false, authStatus: 'anon' })
    const a = find(c, 'unlink').available([child('c1')])
    expect(a.kind === 'disabled' && a.reason).toBe(
      `Unlinking needs the "${PERM_UNLINK}" permission, and this session is not signed in — so it cannot be checked`,
    )
    expect(a.kind === 'disabled' && a.reason).not.toContain('this account does not have')
  })

  it('a session still resolving says it is checking, not that permission was denied', () => {
    const c = ctx({ can: () => false, authStatus: 'loading' })
    const a = find(c, 'unlink').available([child('c1')])
    expect(a.kind === 'disabled' && a.reason).toMatch(/^Checking whether this session may use unlinking/)
  })

  it('channels.sync alone does NOT unlock promote or attach', () => {
    const c = ctx({ family: family({ role: 'standalone' }), can: (p) => p === PERM_UNLINK })
    expect(find(c, 'promote').available([])).toMatchObject({ kind: 'disabled', reason: expect.stringContaining(PERM_PIM) })
  })

  it('the refusal NAMES the permission, so the operator can ask for it', () => {
    const c = ctx({ can: () => false })
    const a = find(c, 'unlink').available([child('c1')])
    expect(a.kind === 'disabled' && a.reason).toContain('channels.sync')
  })

  /** A wrong SELECTION is refused before a missing permission — the fixable thing comes first. */
  it('reports the selection problem before the permission one', () => {
    const c = ctx({ can: () => false })
    const a = find(c, 'unlink').available([child('s1', null)])
    expect(a.kind === 'disabled' && a.reason).toBe('Only a child can be unlinked')
  })
})

describe('a verb never appears mid-flight', () => {
  /** A control that pops into the bar a moment after a fetch reads as a glitch, not as a load. */
  it('promote is disabled with a reason while the family loads, never hidden', () => {
    const a = find(ctx({ family: null }), 'promote').available([])
    expect(a).toEqual({ kind: 'disabled', reason: 'Loading the family…' })
  })
})

describe('scope — a row surface cannot offer a family verb', () => {
  it('attach/promote/demote act on the FAMILY; unlink/reparent/delete act on the SELECTION', () => {
    const all = familyActions(ctx())
    expect(actionsFor(all, contextOf('product-family'), []).map((a) => a.action.id)).toEqual(['attach-existing', 'promote', 'add-variation', 'demote'])
    expect(actionsFor(all, SELECTION, [child('c1')]).map((a) => a.action.id)).toEqual(['unlink', 'reparent', 'delete-variant'])
  })

  /** A row menu must not be able to offer the verb that destroys the whole family. */
  it('demote is not reachable from a row selection', () => {
    expect(actionsFor(familyActions(ctx()), SELECTION, [child('c1')]).map((a) => a.action.id)).not.toContain('demote')
  })

  it('a family verb is not offered to an alias-group context', () => {
    expect(actionsFor(familyActions(ctx()), contextOf('alias-group'), [])).toEqual([])
  })
})

describe('a parameterised verb is disabled until it has been given its input', () => {
  it('attach waits for products to be picked, and says so', () => {
    expect(find(ctx(), 'attach-existing').available([])).toEqual({ kind: 'disabled', reason: 'Pick the products to attach first' })
    const withPick = ctx({ pending: { attach: { productIds: ['x'] } } })
    expect(isRunnable(find(withPick, 'attach-existing').available([]))).toBe(true)
  })

  it('reparent waits for a target parent', () => {
    expect(find(ctx(), 'reparent').available([child('c1')])).toMatchObject({ reason: 'Pick the parent to move it under first' })
  })

  it('refuses the server’s caps client-side rather than spending a round trip to be told', () => {
    const many = ctx({ pending: { attach: { productIds: Array.from({ length: 201 }, (_, i) => `p${i}`) } } })
    expect(find(many, 'attach-existing').available([])).toMatchObject({ reason: expect.stringContaining('at most 200') })
  })

  it('refuses a move that would make a product its own parent, or a no-op move', () => {
    const own = ctx({ pending: { reparentTo: { id: 'c1', sku: 'c1' } } })
    expect(find(own, 'reparent').available([child('c1')])).toMatchObject({ reason: 'A product cannot be its own parent' })
    const same = ctx({ pending: { reparentTo: { id: 'p', sku: 'GALE-JACKET' } } })
    expect(find(same, 'reparent').available([child('c1')])).toMatchObject({ reason: expect.stringContaining('already under') })
  })

  /** The endpoint moves ONE product; looping it client-side turns one failure into a half-moved family. */
  it('reparent refuses a multi-row selection instead of looping the single-product endpoint', () => {
    const c = ctx({ pending: { reparentTo: { id: 'p2', sku: 'P2' } } })
    expect(find(c, 'reparent').available([child('c1'), child('c2')])).toMatchObject({ reason: expect.stringContaining('one child at a time') })
  })
})

describe('the confirmations say what the endpoints actually do', () => {
  it('unlink warns that it leaves a childless parent behind — because it does not demote', async () => {
    const impact = await find(ctx(), 'unlink').preflight!([child('c1'), child('c2')])
    expect(impact.sideEffects).toEqual(expect.arrayContaining([expect.stringContaining('unlink does not demote it')]))
  })

  it('…and stays silent about that when the parent keeps children', async () => {
    const impact = await find(ctx(), 'unlink').preflight!([child('c1')])
    expect(impact.sideEffects?.some((s) => s.includes('does not demote'))).toBe(false)
  })

  it('unlink promises the axis values survive, which is what makes it reversible', async () => {
    const impact = await find(ctx(), 'unlink').preflight!([child('c1')])
    expect(impact.sideEffects).toEqual(expect.arrayContaining([expect.stringContaining('axis values are kept')]))
  })

  /** 🔴 reparent demotes the OLD parent when it takes its last child. The name does not say so. */
  it('reparent preserves the empty parent role, matching unlink and import', async () => {
    const one = ctx({ family: family({ children: [{ id: 'c1', sku: 'c1', name: null, variantAttributes: null }] }), pending: { reparentTo: { id: 'p2', sku: 'P2' } } })
    const impact = await find(one, 'reparent').preflight!([child('c1')])
    expect(impact.sideEffects).toEqual(expect.arrayContaining([expect.stringContaining('remain a Parent')]))
  })

  it('attach names each product and flags the ones joining with no axis values', async () => {
    const c = ctx({ pending: { attach: { productIds: ['a', 'b'], axisValues: { a: { Colore: 'Nero' } } } } })
    const impact = await find(c, 'attach-existing').preflight!([])
    expect(impact.consequences).toEqual(['a — Colore: Nero', 'b — existing attribute values are kept'])
    expect(impact.sideEffects?.[0]).toContain('Review the child’s variation values')
  })
})

describe('results report what actually happened, not what was asked', () => {
  /** 🔴 attach is partially successful BY DESIGN — one transaction per child. */
  it('a partial attach is NOT reported as success', async () => {
    const c = ctx({
      pending: { attach: { productIds: ['a', 'b'] } },
      ops: ops({ attach: vi.fn(async () => ({ success: true, attached: 1, errors: [{ productId: 'b', error: 'b is already a parent' }], parentId: 'p' })) }),
    })
    const out = await runAction(find(c, 'attach-existing'), [], yes)
    expect(out).toMatchObject({ kind: 'ran', result: { ok: false, message: 'Attached 1 of 2. b: b is already a parent' } })
  })

  it('an unlink that matched fewer rows than asked says so', async () => {
    const c = ctx({ ops: ops({ unlink: vi.fn(async () => ({ success: true, detached: 1 })) }) })
    const out = await runAction(find(c, 'unlink'), [child('c1'), child('c2')], yes)
    expect(out).toMatchObject({ result: { ok: false, message: '1 of 2 rows were detached' } })
  })

  it('the server’s own words survive a failure', async () => {
    const c = ctx({ ops: ops({ unlink: vi.fn(async () => { throw new Error('Bulk unlink capped at 200 entries.') }) }) })
    expect(await runAction(find(c, 'unlink'), [child('c1')], yes)).toEqual({ kind: 'failed', message: 'Bulk unlink capped at 200 entries.' })
  })

  it('saying no calls nothing', async () => {
    const o = ops()
    await runAction(find(ctx({ ops: o }), 'unlink'), [child('c1')], async () => false)
    expect(o.unlink).not.toHaveBeenCalled()
  })

  /** Ruling #118: run applies the snapshot the operator approved, not a re-read of `pending`. */
  it('attach sends the ids its own confirmation described, even if the picker changed after', async () => {
    const o = ops()
    const c = ctx({ pending: { attach: { productIds: ['a', 'b'] } }, ops: o })
    const action = find(c, 'attach-existing')
    const impact = await action.preflight!([])
    c.pending!.attach!.productIds = ['ZZZ'] // the picker moved on
    await action.run([], impact)
    expect(o.attach).toHaveBeenCalledWith('p', ['a', 'b'], undefined)
  })
})

describe('F3 — delete child: severity comes from what the server found', () => {
  const listed = (over: Partial<import('./familyOps').ListingRow> = {}) => ({
    channel: 'ebay', marketplace: 'IT', listingStatus: 'ACTIVE', externalListingId: '256789012345', isPublished: true, ...over,
  })

  it('a child nothing is listed on gets a PLAIN confirm and no phrase', async () => {
    const c = ctx({ ops: ops({ listings: vi.fn(async () => []) }) })
    const impact = await find(c, 'delete-variant').preflight!([child('c1')])
    expect(impact.level).toBe('confirm')
    expect(impact.confirmPhrase).toBeUndefined()
    expect(impact.consequences).toContain('It is not listed on any channel')
  })

  /**
   * 🔴 THE case this whole preflight exists for. PES.3 measured a family where every non-ACTIVE
   * eBay row still carried a real ItemID. Keyed on status, this delete would be one click.
   */
  it('a DRAFT listing holding a real ItemID refuses local deletion', async () => {
    const c = ctx({ ops: ops({ listings: vi.fn(async () => [listed({ listingStatus: 'DRAFT' })]) }) })
    const impact = await find(c, 'delete-variant').preflight!([child('c1')])
    expect(impact.level).toBe('none')
    expect(impact.unavailable).toContain('marketplace listing')
    expect(requiresTypedConfirm(impact)).toBe(false)
    expect(validateImpact(impact)).toEqual([])
  })

  it('the confirmation NAMES the listing id rather than counting listings', async () => {
    const c = ctx({ ops: ops({ listings: vi.fn(async () => [listed({ channel: 'amazon', marketplace: 'DE', externalListingId: 'B0F7J163XJ' })]) }) })
    const impact = await find(c, 'delete-variant').preflight!([child('c1')])
    expect(impact.findings?.[0]).toMatchObject({ label: 'amazon · DE — ACTIVE, B0F7J163XJ', severity: 'error' })
    // 🔴 and NOT also in consequences: the dialog renders both under their own headings, so filling
    // both printed every listing twice — seen on screen in the GDS lab.
    expect(impact.consequences).not.toEqual(expect.arrayContaining([expect.stringContaining('B0F7J163XJ')]))
  })

  it('says plainly that there is no undo, and that listings cascade', async () => {
    const impact = await find(ctx(), 'delete-variant').preflight!([child('c1')])
    expect(impact.consequences?.[0]).toContain('no undo')
    expect(impact.sideEffects).toEqual(expect.arrayContaining([expect.stringContaining('deleted with it, by database cascade')]))
  })

  /**
   * 🔴 A preflight that could not LOOK must not fall back to a gentler confirm — that is how a
   * delete runs on a guess. `runAction` refuses it; the verb never executes.
   */
  it('a failed listings read REFUSES the delete instead of asking a softer question', async () => {
    const o = ops({ listings: vi.fn(async () => { throw new Error('products service unreachable') }) })
    const out = await runAction(find(ctx({ ops: o }), 'delete-variant'), [child('c1')], yes)
    expect(out).toMatchObject({ kind: 'refused' })
    expect(out.kind === 'refused' && out.problem).toContain('products service unreachable')
    expect(o.deleteVariant).not.toHaveBeenCalled()
  })

  it('refuses a multi-row selection, because one typed SKU cannot authorise six deletions', () => {
    expect(find(ctx(), 'delete-variant').available([child('c1'), child('c2')])).toMatchObject({
      reason: expect.stringContaining('one child at a time'),
    })
  })

  it('a parent is not deletable here — it is removed by demoting it', () => {
    const parentRow = { ...child('p'), isParent: true } as StudioRow
    expect(find(ctx(), 'delete-variant').available([parentRow])).toMatchObject({ reason: expect.stringContaining('demoting it') })
  })

  /** 🔴 A THIRD permission: delete is served from /api/catalog, gated products.edit. */
  it('needs products.edit — neither pim.manage nor channels.sync unlocks it', () => {
    const c = ctx({ can: (p) => p === PERM_PIM || p === PERM_UNLINK })
    expect(find(c, 'delete-variant').available([child('c1')])).toMatchObject({ reason: expect.stringContaining(PERM_DELETE) })
  })

  /**
   * Ruling #118 on the verb where it matters most. BOTH ids must come from the approved snapshot:
   * the row that moved under us differs in its parent as well as its own id, so a run that re-read
   * either half would delete a different product from the one the operator was shown.
   */
  it('deletes the child its own confirmation named, not whatever is selected now', async () => {
    const o = ops()
    const action = find(ctx({ ops: o }), 'delete-variant')
    const impact = await action.preflight!([child('c1')])
    await action.run([child('SOMETHING-ELSE', 'A-DIFFERENT-PARENT')], impact)
    expect(o.deleteVariant).toHaveBeenCalledWith('p', 'c1')
  })
})

describe('F3 — demote parent: force is the dangerous half', () => {
  it('a childless parent gets a plain confirm and does NOT send force', async () => {
    const c = ctx({ family: family({ children: [] }) })
    const impact = await find(c, 'demote').preflight!([])
    expect(impact.level).toBe('confirm')
    expect(impact.confirmPhrase).toBeUndefined()
    expect(impact.payload).toMatchObject({ force: false })
    expect(impact.sideEffects).toEqual(expect.arrayContaining([expect.stringContaining('Promoting it again reverses this')]))
  })

  /** 🔴 `force: true` orphans every child, and the verb's name does not say so. */
  it('a parent with children requires the SKU to be typed, and names every child', async () => {
    const impact = await find(ctx(), 'demote').preflight!([])
    expect(impact.level).toBe('type-to-confirm')
    expect(impact.confirmPhrase).toBe('GALE-JACKET')
    expect(impact.title).toContain('detach 2 children')
    expect(impact.consequences).toHaveLength(2)
    expect(impact.payload).toMatchObject({ force: true })
  })

  it('says the children SURVIVE — the operator’s real question', async () => {
    const impact = await find(ctx(), 'demote').preflight!([])
    expect(impact.sideEffects).toEqual(expect.arrayContaining([expect.stringContaining('NOT deleted')]))
  })

  /** force comes from the approved snapshot; re-deriving it could force a demote that was described as safe. */
  it('sends the force flag from the impact, never re-derived at run time', async () => {
    const o = ops()
    const c = ctx({ family: family({ children: [] }), ops: o })
    const action = find(c, 'demote')
    const impact = await action.preflight!([])
    c.family!.children = [{ id: 'x', sku: 'x', name: null, variantAttributes: null }] // family changed under us
    await action.run([], impact)
    expect(o.demoteParent).toHaveBeenCalledWith('p', false, [])
  })

  it('only a parent can be demoted, and it needs pim.manage', () => {
    expect(find(ctx({ family: family({ role: 'standalone' }) }), 'demote').available([])).toMatchObject({ reason: 'Only a parent can be demoted' })
    expect(find(ctx({ can: () => false }), 'demote').available([])).toMatchObject({ reason: expect.stringContaining(PERM_PIM) })
  })
})
