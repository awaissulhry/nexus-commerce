import { describe, expect, it } from 'vitest'

import type { PreferencesColumnSpec, PreferencesValue } from '../../patterns/PreferencesModal'
import { preferencesFromLayout } from './columnLayout'
import { columnsViewPayload } from './viewPayload'
import { describeViewRules, viewRuleMatches, viewRulesFor, viewRulesOf, withViewRules, type ViewRuleFacts } from './viewRules'

const SPECS: PreferencesColumnSpec[] = [
  { key: 'product', label: 'Identity', locked: true },
  { key: 'name', label: 'Name', group: 'Content', groupKey: 'content' },
  { key: 'description', label: 'Description', group: 'Content', groupKey: 'content' },
  { key: 'basePrice', label: 'Price', group: 'Offer', groupKey: 'offer' },
  { key: 'brand', label: 'Brand', group: 'Offer', groupKey: 'offer' },
  { key: 'fabric', label: 'Fabric', group: 'Details', groupKey: 'details' },
]
const FACTS: ViewRuleFacts = { required: new Set(['brand', 'fabric']), gaps: new Set(['description']) }
const value = (visible: string[]): PreferencesValue => ({ ...preferencesFromLayout(null, SPECS), visibleColumns: visible })

describe('viewRulesOf — the checked read', () => {
  it('keeps known rules once and drops what this build does not understand', () => {
    expect(viewRulesOf({ rules: [{ kind: 'group', group: ' content ' }, { kind: 'required' }, { kind: 'required' }, { kind: 'group', group: '' }, { kind: 'locale', locale: 'it' }, null, 'gaps'] }))
      .toEqual([{ kind: 'group', group: 'content' }, { kind: 'required' }])
  })
  it('reads a payload without rules, or no payload at all, as no rules', () => {
    expect(viewRulesOf(columnsViewPayload(['name']))).toEqual([])
    expect(viewRulesOf(null)).toEqual([])
    expect(viewRulesOf({ rules: 'required' })).toEqual([])
  })
})

describe('withViewRules — a new column joins by itself', () => {
  it('adds what a group rule matches today, after the stored keys, and never removes a stored key', () => {
    const payload = { ...columnsViewPayload(['basePrice', 'gone']), rules: [{ kind: 'group' as const, group: 'content' }] }
    expect(withViewRules(payload, SPECS, value([]), FACTS).columns).toEqual(['basePrice', 'gone', 'name', 'description'])
  })
  it('follows the row facts for required and gaps', () => {
    const payload = { ...columnsViewPayload([]), rules: [{ kind: 'required' as const }, { kind: 'gaps' as const }] }
    expect(withViewRules(payload, SPECS, value([]), FACTS).columns).toEqual(['brand', 'fabric', 'description'])
  })
  it('honours a group move stored in the view', () => {
    const moved = { ...value([]), groupOverrides: { fabric: 'content' } }
    expect(viewRuleMatches({ kind: 'group', group: 'content' }, SPECS, moved, FACTS)).toEqual(['name', 'description', 'fabric'])
  })
  it('returns the same payload when there is nothing to add', () => {
    const plain = columnsViewPayload(['name'])
    expect(withViewRules(plain, SPECS, value([]), FACTS)).toBe(plain)
    const covered = { ...columnsViewPayload(['name', 'description']), rules: [{ kind: 'group' as const, group: 'content' }] }
    expect(withViewRules(covered, SPECS, value([]), FACTS)).toBe(covered)
  })
})

describe('viewRulesFor — what a save stores', () => {
  it('stores a group rule for every FULLY ticked group only', () => {
    expect(viewRulesFor(value(['name', 'description', 'basePrice']), SPECS, FACTS)).toEqual([{ kind: 'group', group: 'content' }])
  })
  it('keeps an offered fact rule while all its columns stay ticked, and drops it once one is unticked', () => {
    expect(viewRulesFor(value(['brand', 'fabric']), SPECS, FACTS, [{ kind: 'required' }])).toEqual([{ kind: 'required' }])
    expect(viewRulesFor(value(['brand']), SPECS, FACTS, [{ kind: 'required' }])).toEqual([])
  })
  it('does not add a group rule for a group a kept fact rule already covers', () => {
    // Details = [fabric], all required: a Required view must not start following "Details" as well.
    expect(viewRulesFor(value(['brand', 'fabric']), SPECS, FACTS, [{ kind: 'required' }])).not.toContainEqual({ kind: 'group', group: 'details' })
    // Without the Required rule the fully ticked Details group is followed.
    expect(viewRulesFor(value(['fabric']), SPECS, FACTS)).toEqual([{ kind: 'group', group: 'details' }])
  })
  it('never keeps a fact rule that matches nothing', () => {
    expect(viewRulesFor(value(['name']), SPECS, { required: new Set(), gaps: new Set() }, [{ kind: 'gaps' }])).toEqual([])
  })
})

describe('describeViewRules — the menu note', () => {
  it('says what the view follows, in words', () => {
    expect(describeViewRules([], SPECS, value([]))).toBe('')
    expect(describeViewRules([{ kind: 'group', group: 'content' }], SPECS, value([]))).toBe('Follows the Content group')
    expect(describeViewRules([{ kind: 'required' }, { kind: 'gaps' }, { kind: 'group', group: 'content' }, { kind: 'group', group: 'offer' }], SPECS, value([])))
      .toBe('Follows required fields, fields with gaps, the Content, Offer groups')
    expect(describeViewRules(['content', 'offer', 'details'].map((group) => ({ kind: 'group' as const, group })), SPECS, value([]))).toBe('Follows every group')
  })
})
