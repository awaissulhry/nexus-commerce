import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => {
  const same = (a: unknown[] | undefined, b: unknown[] | undefined) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const s = { slots: [] as Array<{ deps?: unknown[]; value?: unknown }>, i: 0, effects: [] as Array<() => void> }
  return {
    s,
    react: {
      useRef: (initial: unknown) => {
        const i = s.i++
        if (!(i in s.slots)) s.slots[i] = { value: { current: initial } }
        return s.slots[i].value
      },
      useState: (init: unknown) => {
        const i = s.i++
        if (!(i in s.slots)) s.slots[i] = { value: typeof init === 'function' ? (init as () => unknown)() : init }
        const slot = s.slots[i]
        return [slot.value, (next: unknown) => { slot.value = typeof next === 'function' ? (next as (v: unknown) => unknown)(slot.value) : next }]
      },
      useMemo: (fn: () => unknown, deps: unknown[]) => {
        const i = s.i++
        const prev = s.slots[i]
        if (prev && same(prev.deps, deps)) return prev.value
        s.slots[i] = { deps, value: fn() }
        return s.slots[i].value
      },
      useEffect: (fn: () => void, deps: unknown[]) => {
        const i = s.i++
        const prev = s.slots[i]
        if (prev && same(prev.deps, deps)) return
        s.slots[i] = { deps }
        s.effects.push(fn)
      },
    },
  }
})
vi.mock('react', () => hooks.react)

const reads = vi.hoisted(() => ({ policies: vi.fn(), themes: vi.fn() }))
vi.mock('./ebayPolicies', () => ({ policyLists: { paymentPolicyId: 'paymentPolicies', returnPolicyId: 'returnPolicies', fulfillmentPolicyId: 'fulfillmentPolicies' }, loadEbayPolicies: reads.policies }))
vi.mock('./referenceOptions', () => ({ isReferenceField: () => false, loadReferenceChoices: reads.themes }))
import { useReferenceNames } from './useReferenceNames'
type Sheet = NonNullable<Parameters<typeof useReferenceNames>[0]>
const sheet = (policy: unknown = null, theme: unknown = null): Sheet => ({ family: { id: 'synthetic-family' }, scope: { kind: 'channel', connectionId: 'synthetic-account' },
  columns: ['paymentPolicyId', 'returnPolicyId', 'fulfillmentPolicyId', 'descriptionThemeId', 'brand'].map(key => ({ key, kind: 'text' })),
  rows: [{ values: { paymentPolicyId: { value: policy }, descriptionThemeId: { value: theme }, brand: { value: 'Example' } } }],
})
const render = (value: Sheet) => {
  hooks.s.i = 0
  const out = useReferenceNames(value, 'EBAY', 'IT', 'synthetic-account')
  for (const effect of hooks.s.effects.splice(0)) effect()
  return out
}
beforeEach(() => {
  hooks.s.slots = []; hooks.s.effects = []
  reads.policies.mockReset().mockResolvedValue({ paymentPolicies: [{ id: 'policy-a', name: 'Example policy' }], returnPolicies: [], fulfillmentPolicies: [] })
  reads.themes.mockReset().mockResolvedValue({ labels: { 'theme-a': 'Example theme', 'theme-b': 'Second theme' }, options: [] })
})
afterEach(() => vi.unstubAllGlobals())
describe('reference names for displayed assignments', () => {
  it('does not read a policy or theme catalog when all its cells are empty', () => {
    render(sheet())
    expect(reads.policies).not.toHaveBeenCalled()
    expect(reads.themes).not.toHaveBeenCalled()
  })
  it('keeps the fixed No theme name without a catalog read', () => {
    const out = render(sheet(null, 'none'))
    expect(out?.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.none).toBe('No theme')
    expect(reads.themes).not.toHaveBeenCalled()
  })
  it('reads names as soon as an assignment exists and retains the row value', async () => {
    render(sheet())
    const assigned = sheet('policy-a', 'theme-a')
    render(assigned)
    expect(reads.policies).toHaveBeenCalledExactlyOnceWith('IT', false, 'synthetic-account')
    expect(reads.themes).toHaveBeenCalledExactlyOnceWith('descriptionThemeId', {}, { live: false, refresh: true, reusePending: false })
    await Promise.resolve(); await Promise.resolve()
    const out = render(assigned)
    expect(out?.rows).toBe(assigned.rows)
    expect(out?.columns.find(c => c.key === 'paymentPolicyId')?.optionLabels?.['policy-a']).toBe('Example policy')
    expect(out?.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-a']).toBe('Example theme')
    const next = render(sheet('policy-b', 'theme-b'))
    expect(next?.columns.find(c => c.key === 'descriptionThemeId')?.optionLabels?.['theme-b']).toBe('Second theme')
    expect(reads.policies).toHaveBeenCalledOnce()
    expect(reads.themes).toHaveBeenCalledOnce()
  })
})
