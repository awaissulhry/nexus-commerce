/**
 * PES.3 — the cascade fold, tested where it can lie.
 *
 * A wrong fold does not throw; it draws a confident, wrong badge. The case that matters most is the
 * row-kind one: `channelExplicit` on an alias BAND is an alias-level pin (every variant inherits
 * it), and on a VARIANT row it is a pin for that variant alone.
 */
import { describe, expect, it } from 'vitest'

import { aliasMark, cascadeIntent, cascadeOf, describeCascade, foldSource, narrowLayer } from './provenance'
import type { ChannelValueSource, StudioCellValue, StudioLayer } from './types'

describe('foldSource', () => {
  it('reads the SAME source differently on a band and on a variant row', () => {
    expect(foldSource('channelExplicit', 'parent', true)).toBe('alias')
    expect(foldSource('channelExplicit', 'variant', true)).toBe('aliasVariant')
    expect(foldSource('channelOverride', 'parent', true)).toBe('alias')
    expect(foldSource('channelOverride', 'variant', true)).toBe('aliasVariant')
  })

  it('folds the alias layer to `alias` on both row kinds', () => {
    for (const kind of ['parent', 'variant'] as const) {
      expect(foldSource('aliasExplicit', kind, true)).toBe('alias')
      expect(foldSource('aliasOverride', kind, true)).toBe('alias')
    }
  })

  it('folds every master-ish layer to `master`', () => {
    const masterish: ChannelValueSource[] = ['master', 'masterLocale', 'masterColumn', 'variant', 'variantLocale']
    for (const s of masterish) expect(foldSource(s, 'variant', true)).toBe('master')
  })

  it('an emptied cell is `unset`, never an inherited badge', () => {
    // A layer can carry an explicit null: the operator cleared it. Painting 🔗 master there would
    // claim the master supplies a value it does not.
    expect(foldSource('channelExplicit', 'variant', false)).toBe('unset')
    expect(foldSource('master', 'variant', false)).toBe('unset')
    expect(foldSource('default', 'variant', true)).toBe('unset')
  })
})

describe('cascadeIntent — one click pins, one click resets', () => {
  it('releases a value that is already this row own', () => {
    expect(cascadeIntent('aliasVariant', 'variant', 'x')).toEqual({ action: 'reset', target: 'aliasVariant', value: null })
    expect(cascadeIntent('alias', 'parent', 'x')).toEqual({ action: 'reset', target: 'alias', value: null })
  })

  it('pins an inherited value DOWN to the row that was clicked', () => {
    // On a variant, the alias value is inherited from above → pin it to this variant.
    expect(cascadeIntent('alias', 'variant', 'Red')).toEqual({ action: 'pin', target: 'aliasVariant', value: 'Red' })
    // On a band, master is inherited → pin it to the alias.
    expect(cascadeIntent('master', 'parent', 'Red')).toEqual({ action: 'pin', target: 'alias', value: 'Red' })
  })

  it('pins the CURRENT value, so pinning never changes what the channel shows', () => {
    const intent = cascadeIntent('master', 'variant', 42)
    expect(intent).toEqual({ action: 'pin', target: 'aliasVariant', value: 42 })
  })

  it('offers nothing on an unset cell', () => {
    expect(cascadeIntent('unset', 'variant', null)).toBeNull()
  })
})

describe('describeCascade — the ACTION clause only', () => {
  const ctx = { aliasLabel: 'Giacca Moto Uomo', aliasPosition: 2, sku: 'GALE-JACKET-BLACK-MEN-M', kind: 'variant' as const }

  it('says what a click does, and never re-describes where the value came from', () => {
    // Ruling #16: the provenance sentence is `provenanceTooltip`'s. A lane that also describes the
    // source is the two-wordings-for-one-cell problem the ruling exists to stop.
    for (const layer of ['aliasVariant', 'alias', 'master'] as const) {
      const hint = describeCascade(layer).actionHint(ctx)
      expect(hint).toMatch(/^Click to /)
      expect(hint).not.toMatch(/inherit/i)
    }
  })

  it('pins to the SKU on a variant and to the alias on a band', () => {
    expect(describeCascade('master').actionHint(ctx)).toContain('GALE-JACKET-BLACK-MEN-M')
    expect(describeCascade('master').actionHint({ ...ctx, kind: 'parent' })).toContain('Giacca Moto Uomo')
  })

  it('names the actual reset destination without promising parent-listing inheritance', () => {
    expect(describeCascade('alias').actionHint({ ...ctx, kind: 'parent' })).toBe('Click to reset this listing row to Master.')
    expect(describeCascade('aliasVariant').actionHint(ctx)).toContain('variant’s Master value')
  })

  it('names the alias for the substrate tooltip rather than writing its own sentence', () => {
    expect(describeCascade('alias').fromLabel(ctx)).toBe('② Giacca Moto Uomo')
    expect(describeCascade('aliasVariant').fromLabel(ctx)).toBe('② Giacca Moto Uomo · GALE-JACKET-BLACK-MEN-M')
    expect(describeCascade('master').fromLabel(ctx)).toBe('the master record')
  })
})

describe('aliasMark', () => {
  it('numbers aliases ①②③', () => {
    expect(aliasMark(1)).toBe('①')
    expect(aliasMark(3)).toBe('③')
    expect(aliasMark(20)).toBe('⑳')
  })

  it('marks the PRIMARY listing rather than calling it alias zero', () => {
    // PES.5 §3.2 sends the primary as one more uniform group at position 0. "⓪" would read as an
    // alias numbered zero; the primary is not an alias, it is the listing the others are aliases of.
    expect(aliasMark(0)).toBe('★')
  })

  it('falls back past the glyph range instead of rendering undefined', () => {
    expect(aliasMark(21)).toBe('(21)')
  })
})

describe('narrowLayer — the SERVER fold is the authority', () => {
  it('keeps the alias levels the server already distinguished', () => {
    expect(narrowLayer('aliasVariant', 'variant', true)).toBe('aliasVariant')
    expect(narrowLayer('alias', 'variant', true)).toBe('alias')
  })

  it('resolves the unattributed `channel` layer by row kind', () => {
    expect(narrowLayer('channel', 'parent', true)).toBe('alias')
    expect(narrowLayer('channel', 'variant', true)).toBe('aliasVariant')
  })

  it('paints a link group as inherited, not as a pin', () => {
    // A FieldLinkGroup is an inheritance; layout §1 draws derived values with 🔗.
    expect(narrowLayer('linked', 'variant', true)).toBe('master')
  })

  it('folds master and variant to `master` — both are the master record to a channel scope', () => {
    for (const l of ['master', 'variant'] as StudioLayer[]) {
      expect(narrowLayer(l, 'variant', true)).toBe('master')
    }
  })
})

describe('cascadeOf — prefers the server layer, falls back honestly', () => {
  const cell = (over: Partial<StudioCellValue>): StudioCellValue => ({
    value: 'x', source: 'master', inheritedFrom: null, inherited: false,
    layer: 'master', pinned: false, follows: null, editable: true,
    linkGroupId: null, mapped: null, writeField: 'f', writeTarget: 'channelListing', writeVerb: 'channel',
    affectsAllChannels: false, writable: true, ...over,
  })

  it('uses `layer` even when `source` would fold differently', () => {
    // source says master; the server says the alias pinned it. The server wins.
    expect(cascadeOf(cell({ source: 'master', layer: 'alias' }), 'variant')).toBe('alias')
  })

  it('falls back to the source fold when the payload carries no layer', () => {
    const c = cell({ source: 'channelExplicit' })
    delete (c as Partial<StudioCellValue>).layer
    expect(cascadeOf(c, 'variant')).toBe('aliasVariant')
    expect(cascadeOf(c, 'parent')).toBe('alias')
  })

  it('is `unset` for a missing cell', () => {
    expect(cascadeOf(undefined, 'variant')).toBe('unset')
  })

  it('offers reset for a deliberately empty channel override', () => {
    for (const value of [null, '', []]) {
      const overridden = cell({ value, layer: 'channel', pinned: true, follows: false })
      expect(cascadeOf(overridden, 'variant')).toBe('aliasVariant')
      expect(cascadeIntent(cascadeOf(overridden, 'variant'), 'variant', value)?.action).toBe('reset')
      expect(cascadeOf(cell({ value, layer: 'default', pinned: false }), 'variant')).toBe('unset')
    }
  })

  it('resets an own named-alias override on a variant instead of pinning it again', () => {
    const overridden = cell({ layer: 'alias', pinned: true, inherited: false })
    expect(cascadeOf(overridden, 'variant')).toBe('aliasVariant')
    expect(cascadeIntent(cascadeOf(overridden, 'variant'), 'variant', 'x')?.action).toBe('reset')
    expect(cascadeOf(cell({ layer: 'alias', pinned: false, inherited: true }), 'variant')).toBe('alias')
  })
})
