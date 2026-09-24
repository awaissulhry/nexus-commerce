import { describe, expect, it } from 'vitest'
import { languageSummary, orderedLocales } from './languageControl'
import { sharedReadiness } from './sharedReadiness'
import type { ScopeBarItem } from '@/design-system/patterns/ScopeBar'

/** Step 4.3 #2 (T1) — the one language control's rules, and R-53's Shared chip. */
const available = ['it', 'de', 'fr', 'es']
const label = (c: string) => ({ it: 'Italian', de: 'German', fr: 'French', es: 'Spanish' } as Record<string, string>)[c]

describe('orderedLocales', () => {
  it('writes the AVAILABLE order, whatever order the multi-select appended in', () => {
    expect(orderedLocales(['de', 'it'], available)).toEqual(['it', 'de'])
    expect(orderedLocales(['it', 'es', 'de'], available)).toEqual(['it', 'de', 'es'])
  })
  it('refuses to write fewer than one language', () => {
    expect(orderedLocales([], available)).toBeNull()
  })
  it('drops a code the scope does not support', () => {
    expect(orderedLocales(['it', 'xx'], available)).toEqual(['it'])
  })
})

describe('languageSummary', () => {
  it('names the first chosen language and counts the rest', () => {
    expect(languageSummary(['de', 'it', 'fr'], available, label)).toBe('Italian +2')
    expect(languageSummary(['de'], available, label)).toBe('German')
  })
})

describe('sharedReadiness (R-53)', () => {
  const ch = (id: string, readiness: ScopeBarItem['readiness']): ScopeBarItem => ({ id, label: id, readiness })
  it('no percentage: "See each channel", in the WORST channel state, named in the note', () => {
    const r = sharedReadiness({ pct: 100, state: 'ready' }, [ch('Amazon', { pct: 80, state: 'warn' }), ch('eBay', { pct: 40, state: 'blocked' })], false)
    expect(r).toMatchObject({ pct: null, state: 'blocked', summary: 'See each channel' })
    expect(r !== 'loading' && r?.note).toContain('Worst channel: eBay — Blocked.')
    expect(r !== 'loading' && r?.note).toContain("Shared's own fields: Ready.")
  })
  it('channels that are not set up, loading or held are not a verdict', () => {
    const r = sharedReadiness({ pct: 50, state: 'warn' }, [ch('Amazon', { pct: null, state: 'absent' }), ch('eBay', 'loading'), ch('Etsy', undefined)], false)
    expect(r).toMatchObject({ pct: null, state: 'notComputed', summary: 'See each channel' })
  })
  it('loading stays loading; a failed save on Shared still shows its own message', () => {
    expect(sharedReadiness('loading', [], false)).toBe('loading')
    const own = { pct: null, state: 'blocked' as const, note: 'Save failed' }
    expect(sharedReadiness(own, [ch('Amazon', { pct: 90, state: 'ready' })], true)).toBe(own)
  })
})
