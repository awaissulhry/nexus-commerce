import { describe, expect, it } from 'vitest'

import {
  AVAILABLE,
  HIDDEN,
  ROW,
  SELECTION,
  actionsFor,
  contextOf,
  disabled,
  isRunnable,
  requiresTypedConfirm,
  validateImpact,
  type ActionImpact,
  type GridAction,
} from './registry'

interface Row { id: string; isParent: boolean; parentId: string | null }
const parent: Row = { id: 'p', isParent: true, parentId: null }
const child: Row = { id: 'c', isParent: false, parentId: 'p' }
const standalone: Row = { id: 's', isParent: false, parentId: null }

const act = (over: Partial<GridAction<Row>> & Pick<GridAction<Row>, 'id' | 'scope'>): GridAction<Row> => ({
  label: over.id,
  available: () => AVAILABLE,
  run: async () => ({ ok: true }),
  ...over,
})

/** A slice of the real family verbs, with their actual role rules. */
const ACTIONS: GridAction<Row>[] = [
  act({ id: 'promote', scope: ROW, available: (r) => (r[0] && !r[0].isParent && !r[0].parentId ? AVAILABLE : HIDDEN) }),
  act({ id: 'unlink', scope: SELECTION, available: (r) => (r.every((x) => x.parentId) ? AVAILABLE : disabled('Only a variation can be unlinked')) }),
  act({ id: 'delete', scope: ROW, danger: true, available: (r) => (r[0]?.isParent ? disabled('A parent is removed by demoting it') : AVAILABLE) }),
  act({ id: 'add-variation', scope: contextOf('product-family') }),
]

describe('actionsFor — scope', () => {
  /**
   * 🔴 THREE scopes. "Add variation" acts on the FAMILY, not on a row, and a registry shaped only
   * for row-or-selection cannot express it — which is why a row menu must not be able to offer it.
   */
  it('a row menu physically cannot offer a family verb', () => {
    expect(actionsFor(ACTIONS, ROW, [child]).map((x) => x.action.id)).not.toContain('add-variation')
    expect(actionsFor(ACTIONS, contextOf('product-family'), []).map((x) => x.action.id)).toEqual(['add-variation'])
  })

  /**
   * 🔴 A context verb must name its AXIS. On the master sheet the context is the product family; on
   * a channel sheet the rows are alias × variant and the context is the alias group. Without the
   * axis, a family verb would be offered by a surface whose context is an alias — the same mistake
   * as a row menu offering a family verb, one level up.
   */
  it('a family verb is not offered to an alias-group context', () => {
    expect(actionsFor(ACTIONS, contextOf('alias-group'), []).map((x) => x.action.id)).toEqual([])
    expect(actionsFor(ACTIONS, contextOf('product-family'), []).map((x) => x.action.id)).toEqual(['add-variation'])
  })

  it('a selection verb does not appear on the row menu, and vice versa', () => {
    expect(actionsFor(ACTIONS, ROW, [child]).map((x) => x.action.id)).not.toContain('unlink')
    expect(actionsFor(ACTIONS, SELECTION, [child]).map((x) => x.action.id)).toEqual(['unlink'])
  })
})

describe('actionsFor — availability', () => {
  it('drops a verb that does not apply at all', () => {
    // Promote is meaningless on a child; it is not shown greyed out, it is not shown.
    expect(actionsFor(ACTIONS, ROW, [child]).map((x) => x.action.id)).not.toContain('promote')
    expect(actionsFor(ACTIONS, ROW, [standalone]).map((x) => x.action.id)).toContain('promote')
  })

  /**
   * 🔴 A disabled verb is KEPT, with its reason. Hiding it teaches the operator nothing; greying it
   * out with no explanation is the trap where a missing permission, a wrong selection and a bug all
   * look identical.
   */
  it('keeps a disabled verb AND its reason', () => {
    const [entry] = actionsFor(ACTIONS, ROW, [parent]).filter((x) => x.action.id === 'delete')
    expect(entry.availability).toEqual({ kind: 'disabled', reason: 'A parent is removed by demoting it' })
    expect(isRunnable(entry.availability)).toBe(false)
  })

  it('a mixed selection reports why, rather than silently offering the verb', () => {
    const [entry] = actionsFor(ACTIONS, SELECTION, [child, standalone])
    expect(entry.availability.kind).toBe('disabled')
  })

  it('preserves declaration order, so a menu does not reshuffle between renders', () => {
    const many = [act({ id: 'a', scope: ROW }), act({ id: 'b', scope: ROW }), act({ id: 'c', scope: ROW })]
    expect(actionsFor(many, ROW, [child]).map((x) => x.action.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('payload — the snapshot survives preflight → run', () => {
  /**
   * 🔴 The TOCTOU this closes. A verb that must FETCH to describe itself (pull-from-channel asks the
   * marketplace what would change) has no channel to `run` without this — so it fetches again, and
   * the operator approves snapshot A while run applies snapshot B. A confirmation describing data
   * other than what lands is the same dishonesty `validateImpact` guards, one step later.
   */
  it('run receives the impact its own preflight produced', async () => {
    const fetched = { rev: 'A', changes: ['title', 'price'] }
    let seen: unknown = 'never ran'
    const action: GridAction<Row> = act({
      id: 'pull',
      scope: ROW,
      preflight: async () => ({ level: 'confirm', title: 'Pull from the channel?', payload: fetched }),
      run: async (_rows, impact) => { seen = impact?.payload; return { ok: true } },
    })
    const impact = await action.preflight!([child])
    await action.run([child], impact)
    // The SAME object, not an equal one re-fetched: identity is the proof there was no second call.
    expect(seen).toBe(fetched)
  })

  it('a verb with no preflight still runs, with no impact', async () => {
    let called = false
    const action = act({ id: 'simple', scope: ROW, run: async (_r, impact) => { called = impact === undefined; return { ok: true } } })
    await action.run([child])
    expect(called).toBe(true)
  })

  it('the registry never inspects the payload — any shape passes through', async () => {
    for (const payload of [null, 0, '', { deep: { nested: true } }, [1, 2, 3]]) {
      let seen: unknown = 'unset'
      const action = act({ id: 'x', scope: ROW, run: async (_r, i) => { seen = i?.payload; return { ok: true } } })
      await action.run([child], { level: 'none', title: 't', payload })
      expect(seen).toEqual(payload)
    }
  })
})

describe('impact — severity comes from the preflight', () => {
  const impact = (over: Partial<ActionImpact> = {}): ActionImpact => ({ level: 'confirm', title: 'Delete this variation?', ...over })

  it('a plain confirm needs no typing', () => {
    expect(requiresTypedConfirm(impact())).toBe(false)
  })

  it('a typed confirm needs the phrase it will check', () => {
    expect(requiresTypedConfirm(impact({ level: 'type-to-confirm', confirmPhrase: 'GALE-JACKET-BLACK-L' }))).toBe(true)
  })

  /**
   * 🔴 The failure that matters: an impact asking to be typed while naming no phrase must be
   * treated as a BUG, not as a lenient confirm. Silently downgrading is how a five-live-listing
   * delete becomes a one-click delete.
   */
  it('a typed confirm with no phrase does NOT quietly become a click', () => {
    const bad = impact({ level: 'type-to-confirm' })
    expect(requiresTypedConfirm(bad)).toBe(false)
    expect(validateImpact(bad)).toContain('level is type-to-confirm but no confirmPhrase was given — refuse rather than downgrade to a click')
  })

  it('an empty question is a problem, not an empty dialog', () => {
    expect(validateImpact(impact({ title: '   ' })).length).toBe(1)
  })

  /** A preflight that FAILED cannot be followed by a confirmation — the verb would run on a guess. */
  it('refuses a confirmation built on a failed preflight', () => {
    expect(validateImpact(impact({ unavailable: 'Could not reach the listings service' }))).toContain(
      'preflight failed but still asked for a confirmation — a verb must not run on a guess',
    )
    // …and a failed preflight that asks for nothing is coherent: the surface simply cannot proceed.
    expect(validateImpact({ level: 'none', title: 'Cannot check', unavailable: 'offline' })).toEqual([])
  })

  it('a clean impact has nothing to report', () => {
    expect(validateImpact(impact({ level: 'type-to-confirm', confirmPhrase: 'SKU-1', consequences: ['Amazon · IT — ACTIVE'] }))).toEqual([])
  })
})
