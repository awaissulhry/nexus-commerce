import { describe, expect, it } from 'vitest'

import { buildCompareTargets, coordinateTargetId, languageTargetId, matchesOpenRecord, type CompareCoordinate } from './compareTargets'

const labels = {
  channel: (c: string) => ({ AMAZON: 'Amazon', EBAY: 'eBay' } as Record<string, string>)[c] ?? c,
  language: (l: string) => ({ it: 'Italian', de: 'German', fr: 'French', nl: 'Dutch' } as Record<string, string>)[l] ?? l,
}

describe('buildCompareTargets (LX.13)', () => {
  it('puts the source language first, then the shared languages, then the coordinates', () => {
    const targets = buildCompareTargets({
      scope: { kind: 'master', marketplace: 'IT', locale: 'it', label: 'Shared' },
      languages: ['nl', 'de', 'fr', 'it'],
      primaryLanguage: 'it',
      coordinates: [
        { channel: 'AMAZON', marketplace: 'DE', accountId: 'a1', locale: 'de' },
        { channel: 'EBAY', marketplace: 'DE', accountId: 'e1', locale: 'de' },
      ],
      labels,
      masterLabel: 'Shared',
      masterMarket: 'IT',
    })
    expect(targets.map(t => t.label)).toEqual([
      'Italian · source', 'Dutch · shared', 'German · shared', 'French · shared',
      'Amazon · DE · de', 'eBay · DE · de',
    ])
    expect(targets.map(t => t.kind)).toEqual(['locale', 'locale', 'locale', 'locale', 'channel', 'channel'])
    // A language target reads the SHARED record in that language — the language tier's own home.
    expect(targets[1].scope).toMatchObject({ kind: 'master', marketplace: 'IT', locale: 'nl' })
    expect(targets[4].scope).toMatchObject({ kind: 'channel', channel: 'AMAZON', marketplace: 'DE', accountId: 'a1', locale: 'de' })
  })

  it('offers the open scope’s language even when the shared record has no row for it', () => {
    const targets = buildCompareTargets({
      scope: { kind: 'channel', channel: 'AMAZON', marketplace: 'BE', accountId: 'a1', locale: 'nl', label: 'Amazon · BE' },
      languages: ['it'],
      primaryLanguage: 'it',
      coordinates: [{ channel: 'AMAZON', marketplace: 'BE', accountId: 'a1', locale: 'nl' }],
      labels,
      masterLabel: 'Shared',
      masterMarket: 'BE',
    })
    expect(targets.map(t => t.id)).toEqual([languageTargetId('it'), languageTargetId('nl'),
      coordinateTargetId({ channel: 'AMAZON', marketplace: 'BE', accountId: 'a1', locale: 'nl' })])
  })

  it('never emits the same coordinate twice', () => {
    const coordinate: CompareCoordinate = { channel: 'AMAZON', marketplace: 'DE', accountId: 'a1', locale: 'de' }
    const targets = buildCompareTargets({
      scope: { kind: 'master', marketplace: 'DE', locale: 'de', label: 'Shared' },
      languages: ['de'], primaryLanguage: 'de', coordinates: [coordinate, { ...coordinate }],
      labels, masterLabel: 'Shared', masterMarket: 'DE',
    })
    expect(targets.filter(t => t.kind === 'channel')).toHaveLength(1)
  })

  /**
   * The regression the language axis introduces into #342.2: without `locale` in the predicate a
   * master scope read in German marks the Italian source row as "this record", so a copy would be
   * made FROM the wrong language.
   */
  it('marks the open record by coordinate AND language', () => {
    const input = {
      scope: { kind: 'master' as const, marketplace: 'IT', locale: 'de', label: 'Shared' },
      languages: ['it', 'de'], primaryLanguage: 'it', coordinates: [], labels,
      masterLabel: 'Shared', masterMarket: 'IT',
    }
    const targets = buildCompareTargets(input)
    const matched = targets.filter(t => matchesOpenRecord(t, input.scope))
    expect(matched.map(t => t.id)).toEqual([languageTargetId('de')])
    // positive control: the same list read on the source language marks the source row instead
    expect(targets.filter(t => matchesOpenRecord(t, { ...input.scope, locale: 'it' })).map(t => t.id))
      .toEqual([languageTargetId('it')])
  })

  it('marks nothing rather than an arbitrary target when no row matches', () => {
    const targets = buildCompareTargets({
      scope: { kind: 'master', marketplace: 'IT', locale: 'it', label: 'Shared' },
      languages: ['it'], primaryLanguage: 'it', coordinates: [], labels, masterLabel: 'Shared', masterMarket: 'IT',
    })
    expect(targets.filter(t => matchesOpenRecord(t, { kind: 'master', marketplace: 'IT', locale: 'xx', label: 'Shared' }))).toEqual([])
  })
})
