/**
 * CR rebuild 4 — the account brakes ask before they save: a higher limit (or clearing to a higher default) is a raise
 * and needs the tick; a lower one is a plain question. An empty field is the default, never "no limit".
 */
import { describe, expect, it } from 'vitest'
import { canConfirmAction } from '@/design-system/components/ActionConfirm'
import { validateImpact } from '@/design-system/grid/actions/registry'
import {
  brakeBody, brakeChanges, brakeImpact, brakeText, changedElsewhere, editedFields, inForceWords, parseBrake, serverFacts, setOf, type Guardrails,
} from './limitsWords'

const g = (actionsSet: number | null, spendSet: number | null): Pick<Guardrails, 'actionsPerHour' | 'spendPerHourCents'> => ({
  actionsPerHour: { effective: actionsSet ?? 250, set: actionsSet, default: 250 },
  spendPerHourCents: { effective: spendSet ?? 50_000, set: spendSet, default: 50_000 },
})

describe('reading what the person typed', () => {
  it('empty is the default; actions are whole numbers ≥ 1; spend is euros above €0, in cents', () => {
    expect(parseBrake('actions', '')).toEqual({ ok: true, value: null })
    expect(parseBrake('actions', '120')).toEqual({ ok: true, value: 120 })
    expect(parseBrake('actions', '0').ok).toBe(false)
    expect(parseBrake('actions', '2.5').ok).toBe(false)
    expect(parseBrake('spend', '40')).toEqual({ ok: true, value: 4000 })
    expect(parseBrake('spend', '12,50')).toEqual({ ok: true, value: 1250 })
    expect(parseBrake('spend', '0').ok).toBe(false)
    expect(parseBrake('spend', 'abc').ok).toBe(false)
  })

  it('the field shows what is SET, never the default; the hint says the number in force', () => {
    expect(brakeText('actions', null)).toBe('')
    expect(brakeText('spend', 4000)).toBe('40')
    expect(inForceWords('actions', { effective: 250, set: null })).toBe('In force: 250 — the default.')
    expect(inForceWords('spend', { effective: 4000, set: 4000 })).toBe('In force: €40.')
  })
})

describe('saving asks first', () => {
  it('nothing changed: nothing to ask', () => {
    expect(brakeChanges(g(100, null), { actions: 100, spend: null })).toEqual([])
    expect(brakeImpact([])).toBeNull()
  })

  it('a lower limit is a plain question, old → new', () => {
    const changes = brakeChanges(g(null, null), { actions: 100, spend: null })
    expect(changes).toEqual([{ field: 'actions', from: 250, to: 100, fromDefault: true, toDefault: false, raise: false }])
    const impact = brakeImpact(changes)!
    expect(impact.title).toBe('Tighten the account brakes?')
    expect(impact.confirmLabel).toBe('Tighten the brakes')
    // A tighter brake is a Nexus setting made safer: no tick, and not the red button (reach local).
    expect(impact.reach).toBe('local')
    expect(impact.consequences?.[0]).toBe('Most rule actions per hour: 250 (the default) → 100.')
    expect(validateImpact(impact)).toEqual([])
    expect(canConfirmAction(impact, '', false)).toBe(true)
  })

  it('THE TRAP: clearing a field to a HIGHER default is a raise, and needs the tick', () => {
    const changes = brakeChanges(g(null, 4000), { actions: null, spend: null })
    expect(changes).toEqual([{ field: 'spend', from: 4000, to: 50_000, fromDefault: false, toDefault: true, raise: true }])
    const impact = brakeImpact(changes)!
    expect(impact.title).toBe('Raise the account brakes?')
    expect(impact.consequences?.[0]).toBe('Most ad spend per hour, all markets: €40 → €500 (the default).')
    expect(validateImpact(impact)).toEqual([])
    expect(canConfirmAction(impact, '', false)).toBe(false)
    expect(canConfirmAction(impact, '', true)).toBe(true)
  })

  it('one up and one down: a change, with the tick', () => {
    const impact = brakeImpact(brakeChanges(g(100, 4000), { actions: 300, spend: 2000 }))!
    expect(impact.title).toBe('Change the account brakes?')
    expect(canConfirmAction(impact, '', false)).toBe(false)
  })

  it('typing the default: the number in force stays, so it is a save, not a lower', () => {
    const impact = brakeImpact(brakeChanges(g(null, null), { actions: 250, spend: null }))!
    expect(impact.title).toBe('Save the account brakes?')
    expect(canConfirmAction(impact, '', false)).toBe(true)
  })

  it('the body sends null for the default', () => {
    expect(brakeBody({ actions: null, spend: 4000 })).toEqual({ maxActionsPerHour: null, maxHourlySpendCentsEur: 4000 })
  })
})

describe('what only a deploy changes', () => {
  it('plain words on screen; the technical name kept apart', () => {
    const facts = serverFacts({ envKill: false, adsMode: 'sandbox', maxWriteValueCents: 50_000 })
    expect(facts.map((f) => [f.label, f.value])).toEqual([
      ['Emergency switch', 'Off'],
      ['Where changes go', 'Amazon’s test account — not your ads'],
      ['Largest single change', '€500'],
    ])
    expect(facts.every((f) => !/NEXUS_/.test(f.value + f.hint))).toBe(true)
    expect(facts[1].technical).toBe('NEXUS_AMAZON_ADS_MODE = sandbox')
    expect(serverFacts({ envKill: true, adsMode: 'live', maxWriteValueCents: 1 }).map((f) => f.value).slice(0, 2))
      .toEqual(['On — all ads automation is stopped', 'Your Amazon account'])
  })
})

describe('CR review — only what the person edited is sent, against a fresh read', () => {
  it('the edited fields are the ones whose typed value differs from what the page read', () => {
    expect(editedFields(setOf(g(100, null)), { actions: 120, spend: null })).toEqual(['actions'])
    expect(editedFields(setOf(g(100, 4000)), { actions: 100, spend: 4000 })).toEqual([])
    expect(editedFields(setOf(g(null, 4000)), { actions: null, spend: null })).toEqual(['spend'])
  })

  it('THE REGRESSION: a limit changed elsewhere since the page opened is not sent back, and the confirmation says it stays', () => {
    const loaded = g(250, 50_000)
    const fresh = g(250, 10_000) // an approved Claude request lowered the spend brake meanwhile
    const typed = { actions: 120, spend: 50_000 } // the box still shows the old spend; only actions was edited
    const edited = editedFields(setOf(loaded), typed)
    expect(edited).toEqual(['actions'])
    expect(brakeBody(typed, edited)).toEqual({ maxActionsPerHour: 120 })
    const changes = brakeChanges(fresh, typed, edited)
    expect(changes.map((c) => c.field)).toEqual(['actions'])
    const elsewhere = changedElsewhere(loaded, fresh, edited)
    expect(elsewhere).toEqual([{ field: 'spend', from: 50_000, to: 10_000, toDefault: false }])
    const impact = brakeImpact(changes, elsewhere)!
    expect(impact.consequences).toContain('Most ad spend per hour, all markets changed since you opened this page: it is now €100. This save keeps it.')
    expect(validateImpact(impact)).toEqual([])
  })

  it('an edited field is compared with what the server holds NOW', () => {
    const fresh = g(90, null)
    expect(brakeChanges(fresh, { actions: 90, spend: null }, ['actions'])).toEqual([]) // already 90 on the server: nothing to send
    expect(brakeChanges(fresh, { actions: 120, spend: null }, ['actions'])[0]).toMatchObject({ from: 90, to: 120, raise: true })
  })

  it('every confirmation names its action on the button', () => {
    expect(brakeImpact(brakeChanges(g(null, 4000), { actions: null, spend: null }))!.confirmLabel).toBe('Raise the brakes')
    expect(brakeImpact(brakeChanges(g(100, null), { actions: 100, spend: null }), [])).toBeNull()
  })
})
